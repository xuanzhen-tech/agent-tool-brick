/**
 * 【文件说明】
 * 本文件实现超长工具结果的本地持久化与受控恢复。
 *
 * AgentTool 会在压缩超长结果前保存完整原文，只把摘要和不可猜测的 resultId
 * 放进模型上下文。模型随后只能在同一 thread 中按 JSON Pointer、分页或关键词
 * 读取，不能通过本模块获得本地文件路径，也不能一次把整份大结果重新灌入上下文。
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const TOOL_RESULT_STORE_SCHEMA_VERSION = "agent-tool-result-store.v1";

const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_PAGE_ITEMS = 20;
const MAX_PAGE_ITEMS = 100;
const DEFAULT_PAGE_CHARS = 8_000;
const MAX_PAGE_CHARS = 12_000;
const DEFAULT_SEARCH_MATCHES = 20;
const MAX_SEARCH_MATCHES = 50;
const MAX_STRUCTURE_ENTRIES = 160;
const MAX_STRUCTURE_DEPTH = 8;

export function createToolResultStore(input = {}) {
  return new ToolResultStore(input);
}

export class ToolResultStore {
  constructor(input = {}) {
    this.rootPath = path.resolve(input.rootPath ?? path.join(os.homedir(), ".agent-cli", "tool-results"));
    this.retentionMs = positiveInteger(input.retentionMs) ?? DEFAULT_RETENTION_MS;
    this.maxTotalBytes = positiveInteger(input.maxTotalBytes) ?? DEFAULT_MAX_TOTAL_BYTES;
    this.now = typeof input.now === "function" ? input.now : () => new Date();
    this.cleanupPromise = undefined;
  }

  async persist(input) {
    const threadId = requireThreadId(input.threadId);
    const resultId = `tool-result-${crypto.randomUUID()}`;
    const createdAt = toIsoString(this.now());
    const expiresAt = new Date(Date.parse(createdAt) + this.retentionMs).toISOString();
    const rawSerialized = safeJson(input.result);
    if (rawSerialized === undefined) {
      throw storeError("tool_result_not_serializable", "完整工具结果无法序列化，因此不能建立恢复引用。");
    }

    const bytes = Buffer.byteLength(rawSerialized, "utf8");
    const contentHash = sha256(rawSerialized);
    const logical = resolveLogicalDocument(input.result);
    const availablePaths = collectAvailablePaths(logical.value);
    const scopePath = this.scopePath(threadId);
    const filePath = path.join(scopePath, `${resultId}.json`);
    const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const record = {
      schemaVersion: TOOL_RESULT_STORE_SCHEMA_VERSION,
      resultId,
      threadId,
      toolCallId: normalizeIdentifier(input.toolCallId),
      toolName: normalizeIdentifier(input.toolName),
      createdAt,
      expiresAt,
      bytes,
      contentHash,
      logicalSource: logical.source,
      rawResult: input.result
    };

    await fs.mkdir(scopePath, { recursive: true, mode: 0o700 });
    try {
      await fs.writeFile(temporaryPath, JSON.stringify(record), { encoding: "utf8", flag: "wx", mode: 0o600 });
      await fs.rename(temporaryPath, filePath);
    } finally {
      // rename 成功后临时文件已不存在；失败时清掉残留，避免异常写盘长期占空间。
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    }
    if (!this.cleanupPromise) {
      this.cleanupPromise = this.cleanup()
        .catch(() => undefined)
        .finally(() => {
          this.cleanupPromise = undefined;
        });
    }

    return {
      resultRef: publicResultRef(record, logical.value),
      availablePaths
    };
  }

  async inspect(input) {
    const record = await this.loadScopedRecord(input.resultId, input.threadId);
    const logical = resolveLogicalDocument(record.rawResult);
    return {
      resultRef: publicResultRef(record, logical.value),
      availablePaths: collectAvailablePaths(logical.value),
      guidance: "先选择必要字段再分页读取；不要在一次调用中读取完整结果。"
    };
  }

  async read(input) {
    throwIfAborted(input.signal);
    const record = await this.loadScopedRecord(input.resultId, input.threadId);
    const logical = resolveLogicalDocument(record.rawResult);
    const pointer = normalizePointer(input.path);
    if (!pointer) return await this.inspect(input);

    const selected = resolveJsonPointer(logical.value, pointer);
    const offset = nonNegativeInteger(input.offset) ?? 0;
    const limit = Math.min(positiveInteger(input.limit) ?? DEFAULT_PAGE_ITEMS, MAX_PAGE_ITEMS);
    const maxChars = Math.min(positiveInteger(input.maxChars) ?? DEFAULT_PAGE_CHARS, MAX_PAGE_CHARS);
    const page = createValuePage(selected, { pointer, offset, limit, maxChars });
    throwIfAborted(input.signal);
    return {
      resultRef: publicResultRef(record, logical.value),
      ...page
    };
  }

  async search(input) {
    throwIfAborted(input.signal);
    const query = typeof input.query === "string" ? input.query.trim() : "";
    if (!query) throw storeError("tool_result_query_required", "query 不能为空。");
    const record = await this.loadScopedRecord(input.resultId, input.threadId);
    const logical = resolveLogicalDocument(record.rawResult);
    const maxMatches = Math.min(positiveInteger(input.maxMatches) ?? DEFAULT_SEARCH_MATCHES, MAX_SEARCH_MATCHES);
    const matches = [];
    searchValue(logical.value, query.toLocaleLowerCase(), "", matches, maxMatches, input.signal);
    return {
      resultRef: publicResultRef(record, logical.value),
      query,
      matches,
      matchCount: matches.length,
      truncated: matches.length >= maxMatches,
      guidance: matches.length >= maxMatches
        ? "命中数量已达上限，请缩小关键词或使用 tool_result_read 读取具体路径。"
        : "可使用 tool_result_read 读取命中路径对应的数据。"
    };
  }

  async deleteThread(threadId) {
    const normalized = requireThreadId(threadId);
    await fs.rm(this.scopePath(normalized), { recursive: true, force: true });
  }

  async cleanup() {
    const nowMs = this.now().getTime();
    const files = await listResultFiles(this.rootPath);
    const retained = [];
    let totalBytes = 0;
    for (const file of files) {
      let record;
      try {
        record = JSON.parse(await fs.readFile(file.path, "utf8"));
      } catch {
        await fs.rm(file.path, { force: true });
        continue;
      }
      if (Date.parse(record.expiresAt ?? "") <= nowMs) {
        await fs.rm(file.path, { force: true });
        continue;
      }
      retained.push({ ...file, createdAt: Date.parse(record.createdAt ?? "") || file.mtimeMs });
      totalBytes += file.size;
    }

    // 达到磁盘上限时优先清理最旧结果；引用随后会稳定返回已过期/不存在错误。
    retained.sort((left, right) => left.createdAt - right.createdAt);
    for (const file of retained) {
      if (totalBytes <= this.maxTotalBytes) break;
      await fs.rm(file.path, { force: true });
      totalBytes -= file.size;
    }
  }

  async loadScopedRecord(resultId, threadId) {
    const normalizedResultId = requireResultId(resultId);
    const normalizedThreadId = requireThreadId(threadId);
    const filePath = path.join(this.scopePath(normalizedThreadId), `${normalizedResultId}.json`);
    let record;
    try {
      record = JSON.parse(await fs.readFile(filePath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw storeError("tool_result_not_found", `工具结果不存在或已经清理: ${normalizedResultId}`);
      }
      throw storeError("tool_result_read_failed", `读取工具结果失败: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (record.schemaVersion !== TOOL_RESULT_STORE_SCHEMA_VERSION || record.resultId !== normalizedResultId) {
      throw storeError("tool_result_invalid_record", "工具结果记录格式无效。");
    }
    if (record.threadId !== normalizedThreadId) {
      throw storeError("tool_result_scope_mismatch", "当前 thread 无权读取该工具结果。");
    }
    if (Date.parse(record.expiresAt ?? "") <= this.now().getTime()) {
      await fs.rm(filePath, { force: true });
      throw storeError("tool_result_expired", `工具结果已经过期: ${normalizedResultId}`);
    }
    return record;
  }

  scopePath(threadId) {
    const safe = /^[A-Za-z0-9._-]{1,180}$/.test(threadId)
      ? threadId
      : `thread-${sha256(threadId).slice(0, 32)}`;
    return path.join(this.rootPath, safe);
  }
}

function resolveLogicalDocument(result, depth = 0, source = "$") {
  if (depth > 8) return { value: result, source };
  if (typeof result === "string") {
    const parsed = parseJson(result);
    return parsed === undefined ? { value: result, source } : resolveLogicalDocument(parsed, depth + 1, `${source}#json`);
  }
  if (!isRecord(result)) return { value: result, source };

  for (const key of ["structuredContent", "structured_content"]) {
    if (result[key] !== undefined && result[key] !== null) {
      return resolveLogicalDocument(result[key], depth + 1, `${source}.${key}`);
    }
  }
  if (isRecord(result.details?.result)) {
    return resolveLogicalDocument(result.details.result, depth + 1, `${source}.details.result`);
  }
  if (isRecord(result.result)) {
    return resolveLogicalDocument(result.result, depth + 1, `${source}.result`);
  }
  if (Array.isArray(result.content)) {
    const textParts = result.content
      .filter((part) => isRecord(part) && part.type === "text" && typeof part.text === "string")
      .map((part) => part.text);
    if (textParts.length === 1) {
      const parsed = parseJson(textParts[0]);
      if (parsed !== undefined) return resolveLogicalDocument(parsed, depth + 1, `${source}.content[0].text#json`);
      return { value: textParts[0], source: `${source}.content[0].text` };
    }
  }
  if (typeof result.content === "string") {
    const parsed = parseJson(result.content);
    if (parsed !== undefined) return resolveLogicalDocument(parsed, depth + 1, `${source}.content#json`);
  }
  return { value: result, source };
}

function collectAvailablePaths(value) {
  const entries = [];
  visitStructure(value, "", 0, entries);
  return entries.slice(0, MAX_STRUCTURE_ENTRIES);
}

function visitStructure(value, pointer, depth, entries) {
  if (entries.length >= MAX_STRUCTURE_ENTRIES || depth > MAX_STRUCTURE_DEPTH) return;
  if (Array.isArray(value)) {
    entries.push({ path: pointer || "/", type: "array", length: value.length });
    // 用真实可读取的首项路径展示数组结构，避免向模型暴露无法解析的通配符路径。
    if (value.length && isRecord(value[0])) visitStructure(value[0], `${pointer}/0`, depth + 1, entries);
    return;
  }
  if (isRecord(value)) {
    if (pointer) entries.push({ path: pointer, type: "object", keys: Object.keys(value).length });
    for (const [key, entry] of Object.entries(value)) {
      if (entries.length >= MAX_STRUCTURE_ENTRIES) break;
      visitStructure(entry, `${pointer}/${escapePointerToken(key)}`, depth + 1, entries);
    }
    return;
  }
  entries.push({ path: pointer || "/", type: value === null ? "null" : typeof value });
}

function createValuePage(value, input) {
  if (Array.isArray(value)) {
    const candidates = value.slice(input.offset, input.offset + input.limit);
    const items = [];
    let serializedChars = 0;
    let oversizedItemPath;
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      const chars = (safeJson(candidate) ?? String(candidate)).length;
      if (serializedChars + chars > input.maxChars) {
        oversizedItemPath = `${input.pointer}/${input.offset + index}`;
        break;
      }
      items.push(candidate);
      serializedChars += chars;
    }
    return {
      path: input.pointer,
      valueType: "array",
      offset: input.offset,
      limit: input.limit,
      total: value.length,
      items,
      nextOffset: oversizedItemPath && items.length === 0
        ? undefined
        : input.offset + items.length < value.length ? input.offset + items.length : undefined,
      oversizedItemPath,
      guidance: oversizedItemPath
        ? `下一项超过单页字符预算，请用更具体的 path 读取 ${oversizedItemPath} 内的必要字段。`
        : undefined
    };
  }
  if (typeof value === "string") {
    const text = value.slice(input.offset, input.offset + input.maxChars);
    return {
      path: input.pointer,
      valueType: "string",
      offset: input.offset,
      chars: value.length,
      text,
      nextOffset: input.offset + text.length < value.length ? input.offset + text.length : undefined
    };
  }
  const serialized = safeJson(value) ?? String(value);
  if (serialized.length <= input.maxChars) {
    return { path: input.pointer, valueType: typeOfValue(value), value };
  }
  return {
    path: input.pointer,
    valueType: typeOfValue(value),
    truncated: true,
    availablePaths: collectAvailablePaths(value),
    guidance: "该对象仍然过大，请继续选择更具体的 path；不会直接返回完整对象。"
  };
}

function searchValue(value, query, pointer, matches, maxMatches, signal) {
  throwIfAborted(signal);
  if (matches.length >= maxMatches) return;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length && matches.length < maxMatches; index += 1) {
      searchValue(value[index], query, `${pointer}/${index}`, matches, maxMatches, signal);
    }
    return;
  }
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (matches.length >= maxMatches) break;
      const childPointer = `${pointer}/${escapePointerToken(key)}`;
      if (key.toLocaleLowerCase().includes(query)) {
        matches.push({ path: childPointer, preview: previewValue(entry) });
      }
      searchValue(entry, query, childPointer, matches, maxMatches, signal);
    }
    return;
  }
  const text = String(value ?? "");
  const index = text.toLocaleLowerCase().indexOf(query);
  if (index >= 0) {
    matches.push({
      path: pointer || "/",
      preview: text.slice(Math.max(0, index - 120), Math.min(text.length, index + query.length + 240))
    });
  }
}

function resolveJsonPointer(value, pointer) {
  if (pointer === "/") return value;
  let current = value;
  for (const token of pointer.slice(1).split("/").map(unescapePointerToken)) {
    if (Array.isArray(current)) {
      const index = nonNegativeInteger(token);
      if (index === undefined || index >= current.length) throw storeError("tool_result_path_not_found", `结果路径不存在: ${pointer}`);
      current = current[index];
      continue;
    }
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, token)) {
      throw storeError("tool_result_path_not_found", `结果路径不存在: ${pointer}`);
    }
    current = current[token];
  }
  return current;
}

function publicResultRef(record, logicalValue) {
  return {
    resultId: record.resultId,
    toolName: record.toolName,
    toolCallId: record.toolCallId,
    format: Array.isArray(logicalValue) || isRecord(logicalValue) ? "json" : "text",
    bytes: record.bytes,
    sha256: record.contentHash,
    recoverable: true,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt
  };
}

async function listResultFiles(rootPath) {
  const output = [];
  let scopes;
  try {
    scopes = await fs.readdir(rootPath, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return output;
    throw error;
  }
  for (const scope of scopes) {
    if (!scope.isDirectory()) continue;
    const scopePath = path.join(rootPath, scope.name);
    for (const entry of await fs.readdir(scopePath, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const filePath = path.join(scopePath, entry.name);
      const stats = await fs.stat(filePath);
      output.push({ path: filePath, size: stats.size, mtimeMs: stats.mtimeMs });
    }
  }
  return output;
}

function normalizePointer(value) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || !value.startsWith("/")) {
    throw storeError("tool_result_path_invalid", "path 必须是以 / 开头的 JSON Pointer。");
  }
  return value;
}

function requireThreadId(value) {
  const normalized = normalizeIdentifier(value);
  if (!normalized) throw storeError("tool_result_thread_required", "恢复工具结果需要有效的 threadId。");
  return normalized;
}

function requireResultId(value) {
  const normalized = normalizeIdentifier(value);
  if (!normalized || !/^tool-result-[A-Za-z0-9-]+$/.test(normalized)) {
    throw storeError("tool_result_id_invalid", "resultId 格式无效。");
  }
  return normalized;
}

function normalizeIdentifier(value) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= 256 ? normalized : undefined;
}

function storeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error(typeof signal.reason === "string" ? signal.reason : "工具结果读取已中断。");
  error.name = "AbortError";
  throw error;
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function typeOfValue(value) {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function previewValue(value) {
  const serialized = typeof value === "string" ? value : safeJson(value) ?? String(value);
  return serialized.length <= 360 ? serialized : `${serialized.slice(0, 360)}...`;
}

function escapePointerToken(value) {
  return String(value).replaceAll("~", "~0").replaceAll("/", "~1");
}

function unescapePointerToken(value) {
  return value.replaceAll("~1", "/").replaceAll("~0", "~");
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : undefined;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function toIsoString(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw storeError("tool_result_time_invalid", "工具结果时间无效。");
  return date.toISOString();
}
