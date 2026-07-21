/**
 * 面向模型的工具结果压缩。
 *
 * 工具输出可能远大于模型单轮应该直接接收的内容。本模块保留稳定的
 * status、error、details 字段，同时用 hash 和 head/tail 摘要压缩噪声
 * 内容，包括终端 stdout/stderr。
 */

import crypto from "node:crypto";

export const TOOL_RESULT_COMPRESSION_MARKER = "[agent-tool-result-compressed]";

const TOKEN_TO_CHAR_ESTIMATE = 4;
const DEFAULT_GLOBAL_BUDGET_TOKENS = 8_000;
const RUN_SHELL_BUDGET_TOKENS = 4_000;
const HIGH_NOISE_BUDGET_TOKENS = 2_000;
const MAX_SUMMARY_DEPTH = 3;
const MAX_ARTIFACT_PATHS = 30;

export function isToolResultCompressionEnabled(env = process.env) {
  const value = env.AGENT_TOOL_RESULT_COMPRESSION?.trim().toLowerCase();
  return !(value === "0" || value === "false" || value === "no" || value === "off");
}

export function compressToolExecutionResult(input) {
  const normalizedResult = normalizeExecutionResult(input.result);
  const rawSerialized = safeJson(normalizedResult) ?? String(normalizedResult);
  const contentText = stringifyContent(normalizedResult.content);
  const detailsSerialized = safeJson(normalizedResult.details) ?? "";
  const policy = selectPolicy(input.toolName, normalizedResult, contentText, detailsSerialized);
  const alreadyCompressed = contentText.includes(TOOL_RESULT_COMPRESSION_MARKER) ||
    detailsSerialized.includes(TOOL_RESULT_COMPRESSION_MARKER);
  // skill 内容会由 AgentCli 识别并提升为专门上下文块。若在 HTTP 工具层先
  // 压缩正文，CLI 将无法恢复完整 reference，因此这里保留受控 payload 原样传递。
  const promotedSkillContext = hasPromotedSkillContext(normalizedResult);
  const enabled = input.compressionEnabled ?? isToolResultCompressionEnabled(input.env ?? process.env);
  const shouldCompress = enabled && !alreadyCompressed && !promotedSkillContext && (
    policy.forceStructured === true ||
    contentText.length > policy.maxChars ||
    detailsSerialized.length > policy.maxChars ||
    rawSerialized.length > policy.maxChars
  );

  if (!shouldCompress) {
    return {
      changed: false,
      result: input.result,
      metadata: buildMetadata({
        input,
        policy,
        rawSerialized,
        originalContentChars: contentText.length,
        originalDetailsChars: detailsSerialized.length,
        originalResultChars: rawSerialized.length,
        compressedResult: normalizedResult,
        truncated: false,
        reason: promotedSkillContext ? "promoted_skill_context" : alreadyCompressed ? "already_compressed" : "within_budget"
      })
    };
  }

  const compressedResult = buildCompressedToolResult(input, normalizedResult, policy, rawSerialized);
  return {
    changed: true,
    result: compressedResult,
    metadata: buildMetadata({
      input,
      policy,
      rawSerialized,
      originalContentChars: contentText.length,
      originalDetailsChars: detailsSerialized.length,
      originalResultChars: rawSerialized.length,
      compressedResult,
      truncated: true,
      reason: policy.forceStructured === true ? "structured_tool_result" : "over_budget"
    })
  };
}

/**
 * 判断结果是否携带会被 AgentCli 升级为专门上下文的 skill 正文。
 *
 * 这两类正文需要原样穿过工具 HTTP 服务，才能由 CLI 做独立预算校验、持久化和
 * 跨轮注入。它们不是普通终端输出，因此不能套用通用的 head/tail 压缩策略。
 */
function hasPromotedSkillContext(result) {
  const details = result?.details;
  if (!isRecord(details)) return false;

  return (
    isRecord(details.loadedSkill) && typeof details.loadedSkill.content === "string"
  ) || (
    isRecord(details.loadedSkillReference) && typeof details.loadedSkillReference.content === "string"
  );
}

function buildCompressedToolResult(input, result, policy, rawSerialized) {
  if (policy.forceStructured === true && isTerminalLikePolicy(policy.name)) {
    const shellSummary = buildRunShellSummary(input, result, policy, rawSerialized);
    return {
      ...result,
      content: JSON.stringify(shellSummary.modelVisible, null, 2),
      details: shellSummary.details
    };
  }

  const text = stringifyContent(result.content);
  const parsed = parseJson(text) ?? (isRecord(result.details) ? result.details : undefined);
  const summaryPayload = {
    marker: TOOL_RESULT_COMPRESSION_MARKER,
    toolName: input.toolName,
    toolCallId: input.toolCallId,
    policy: policy.name,
    original: {
      contentChars: text.length,
      detailsChars: (safeJson(result.details) ?? "").length,
      resultChars: rawSerialized.length,
      hash: stableHash(rawSerialized)
    },
    summary: parsed ? summarizeJsonValue(parsed) : summarizeText(text, policy),
    artifactPaths: extractArtifactPaths(parsed ?? result.details ?? result.artifacts)
  };

  return {
    ...result,
    content: JSON.stringify(pruneUndefined(summaryPayload), null, 2),
    details: attachCompressionMetadata(
      compressUnknownValue(result.details, policy.channelMaxChars, []),
      input,
      policy,
      rawSerialized
    )
  };
}

function buildRunShellSummary(input, result, policy, rawSerialized) {
  const parsedContent = parseJson(stringifyContent(result.content));
  const details = isRecord(result.details)
    ? result.details
    : isRecord(parsedContent)
      ? parsedContent
      : {};
  const stdout = stringField(details.stdout);
  const stderr = stringField(details.stderr);
  const stdoutSummary = summarizeOutputChannel(stdout, policy, "stdout");
  const stderrSummary = summarizeOutputChannel(stderr, policy, "stderr");
  const artifacts = Array.isArray(result.artifacts) ? result.artifacts : undefined;
  const modelVisible = pruneUndefined({
    marker: TOOL_RESULT_COMPRESSION_MARKER,
    toolName: input.toolName,
    toolCallId: input.toolCallId,
    policy: policy.name,
    original: {
      resultChars: rawSerialized.length,
      hash: stableHash(rawSerialized)
    },
    status: pickDefined({
      sessionId: details.sessionId,
      session_id: details.session_id,
      running: details.running,
      exitCode: details.exitCode,
      timedOut: details.timedOut,
      blocked: details.blocked,
      truncated: details.truncated,
      signal: details.signal,
      errorType: details.errorType,
      interrupted: details.interrupted
    }),
    cwd: details.cwd,
    command: details.command,
    stdout: stdoutSummary,
    stderr: stderrSummary,
    artifactPaths: extractArtifactPaths(details) ?? extractArtifactPaths(artifacts)
  });

  return {
    modelVisible,
    details: pruneUndefined({
      ...pickDefined({
        sessionId: details.sessionId,
        session_id: details.session_id,
        running: details.running,
        command: details.command,
        mode: details.mode,
        exitCode: details.exitCode,
        timedOut: details.timedOut,
        blocked: details.blocked,
        truncated: details.truncated,
        signal: details.signal,
        cwd: details.cwd,
        errorType: details.errorType,
        interrupted: details.interrupted,
        startedAt: details.startedAt,
        lastUsedAt: details.lastUsedAt,
        yieldedAfterMs: details.yieldedAfterMs,
        stdinBytes: details.stdinBytes
      }),
      stdout: renderChannelForDetails(stdoutSummary),
      stderr: renderChannelForDetails(stderrSummary),
      stdoutSummary,
      stderrSummary,
      artifactPaths: extractArtifactPaths(details) ?? extractArtifactPaths(artifacts),
      __agentToolCompression: compressionDetails(input, policy, rawSerialized)
    })
  };
}

function selectPolicy(toolName, result, contentText, detailsSerialized) {
  if (["run_shell", "exec_command", "write_stdin"].includes(toolName)) {
    return makePolicy(toolName, RUN_SHELL_BUDGET_TOKENS, true);
  }
  const combined = `${toolName}\n${contentText.slice(0, 10_000)}\n${detailsSerialized.slice(0, 10_000)}`;
  if (looksLikeHighNoiseResult(combined, result.details)) {
    return makePolicy("high_noise_json", HIGH_NOISE_BUDGET_TOKENS);
  }
  return makePolicy("global", DEFAULT_GLOBAL_BUDGET_TOKENS);
}

function isTerminalLikePolicy(policyName) {
  return ["run_shell", "exec_command", "write_stdin"].includes(policyName);
}

function makePolicy(name, budgetTokens, forceStructured = false) {
  const maxChars = budgetTokens * TOKEN_TO_CHAR_ESTIMATE;
  return {
    name,
    budgetTokens,
    maxChars,
    channelMaxChars: Math.max(1_000, Math.floor(maxChars * 0.42)),
    headChars: Math.max(600, Math.floor(maxChars * 0.22)),
    tailChars: Math.max(400, Math.floor(maxChars * 0.12)),
    forceStructured
  };
}

function looksLikeHighNoiseResult(text, details) {
  const normalized = text.toLowerCase();
  if (/inventory|structure[_ -]?extraction|structureextraction|output[_ -]?inventory|preview|rendered[_ -]?previews/.test(normalized)) {
    return true;
  }
  if (/"(?:rows|columns|sheets|worksheets|tables|cells|stdout|stderr)"\s*:/.test(normalized) && normalized.length > 4_000) {
    return true;
  }
  if (isRecord(details)) {
    const keys = Object.keys(details).join(" ").toLowerCase();
    return /inventory|structure|preview|rows|columns|sheets|stdout|stderr/.test(keys) && (safeJson(details)?.length ?? 0) > 4_000;
  }
  return false;
}

function summarizeOutputChannel(text, policy, label) {
  const parsed = parseJson(text);
  const summary = summarizeText(text, policy, policy.channelMaxChars);
  return pruneUndefined({
    label,
    type: parsed ? "json" : "text",
    length: text.length,
    hash: stableHash(text),
    truncated: summary.truncated,
    text: summary.truncated ? undefined : text,
    head: summary.truncated ? summary.head : undefined,
    tail: summary.truncated ? summary.tail : undefined,
    omittedChars: summary.truncated ? summary.omittedChars : undefined,
    jsonSummary: parsed ? summarizeJsonValue(parsed) : undefined,
    artifactPaths: parsed ? extractArtifactPaths(parsed) : undefined
  });
}

function summarizeText(text, policy, maxChars = policy.maxChars) {
  if (text.length <= maxChars) {
    return { truncated: false, length: text.length, hash: stableHash(text), text };
  }
  const headChars = Math.min(policy.headChars, Math.floor(maxChars * 0.7));
  const tailChars = Math.min(policy.tailChars, Math.max(0, maxChars - headChars - 256));
  return {
    truncated: true,
    length: text.length,
    hash: stableHash(text),
    head: text.slice(0, headChars),
    tail: tailChars > 0 ? text.slice(-tailChars) : "",
    omittedChars: Math.max(0, text.length - headChars - tailChars)
  };
}

function renderChannelForDetails(summary) {
  if (typeof summary.text === "string") {
    return summary.text;
  }
  return [
    TOOL_RESULT_COMPRESSION_MARKER,
    `channel=${String(summary.label ?? "output")}`,
    `length=${String(summary.length ?? 0)}`,
    `hash=${String(summary.hash ?? "")}`,
    `omittedChars=${String(summary.omittedChars ?? 0)}`,
    "--- head ---",
    String(summary.head ?? ""),
    "--- tail ---",
    String(summary.tail ?? "")
  ].join("\n");
}

function summarizeJsonValue(value, depth = 0) {
  if (depth > MAX_SUMMARY_DEPTH) {
    return summarizeLeaf(value);
  }
  if (typeof value === "string") {
    return value.length > 1_000 ? summarizeStringLeaf(value) : value;
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      sampleHead: value.slice(0, 5).map((item) => summarizeJsonValue(item, depth + 1)),
      ...(value.length > 5 ? { sampleTail: value.slice(-2).map((item) => summarizeJsonValue(item, depth + 1)) } : {}),
      ...(value.length > 7 ? { omittedItems: value.length - 7 } : {})
    };
  }
  const record = value;
  const keys = Object.keys(record);
  const selected = {};
  for (const key of keys.slice(0, 40)) {
    const entry = record[key];
    if (isSummaryPriorityKey(key) || keys.length <= 12) {
      selected[key] = summarizeJsonValue(entry, depth + 1);
    } else if (isPrimitive(entry)) {
      selected[key] = entry;
    }
  }
  return {
    type: "object",
    keys: keys.slice(0, 80),
    keyCount: keys.length,
    selected
  };
}

function summarizeLeaf(value) {
  if (typeof value === "string") return summarizeStringLeaf(value);
  if (Array.isArray(value)) return { type: "array", length: value.length };
  if (isRecord(value)) return { type: "object", keys: Object.keys(value).slice(0, 40), keyCount: Object.keys(value).length };
  return value;
}

function summarizeStringLeaf(value) {
  return {
    type: "string",
    length: value.length,
    hash: stableHash(value),
    preview: value.slice(0, 300)
  };
}

function compressUnknownValue(value, maxChars, pathSegments) {
  const serialized = safeJson(value);
  if (!serialized || serialized.length <= maxChars) {
    return value;
  }
  if (typeof value === "string") {
    return renderChannelForDetails(summarizeOutputChannel(value, makePolicy("high_noise_json", HIGH_NOISE_BUDGET_TOKENS), pathSegments.at(-1) ?? "text"));
  }
  if (Array.isArray(value)) {
    return summarizeJsonValue(value, 0);
  }
  if (!isRecord(value)) {
    return summarizeLeaf(value);
  }
  const compressed = {};
  for (const [key, entry] of Object.entries(value)) {
    const entryJson = safeJson(entry) ?? String(entry);
    if (entryJson.length > Math.max(1_000, Math.floor(maxChars / 4))) {
      compressed[key] = compressUnknownValue(entry, Math.max(1_000, Math.floor(maxChars / 4)), [...pathSegments, key]);
    } else {
      compressed[key] = entry;
    }
  }
  return compressed;
}

function attachCompressionMetadata(details, input, policy, rawSerialized) {
  const metadata = compressionDetails(input, policy, rawSerialized);
  if (isRecord(details)) {
    return { ...details, __agentToolCompression: metadata };
  }
  return { value: details, __agentToolCompression: metadata };
}

function compressionDetails(input, policy, rawSerialized) {
  return {
    marker: TOOL_RESULT_COMPRESSION_MARKER,
    toolName: input.toolName,
    toolCallId: input.toolCallId,
    policy: policy.name,
    budgetChars: policy.maxChars,
    originalResultChars: rawSerialized.length,
    rawHash: stableHash(rawSerialized)
  };
}

function buildMetadata(args) {
  const compressedContent = stringifyContent(args.compressedResult.content);
  const compressedDetails = safeJson(args.compressedResult.details) ?? "";
  const compressedSerialized = safeJson(args.compressedResult) ?? "";
  return {
    marker: TOOL_RESULT_COMPRESSION_MARKER,
    toolName: args.input.toolName,
    toolCallId: args.input.toolCallId,
    policyName: args.policy.name,
    budgetChars: args.policy.maxChars,
    originalContentChars: args.originalContentChars,
    originalDetailsChars: args.originalDetailsChars,
    originalResultChars: args.originalResultChars,
    rawHash: stableHash(args.rawSerialized),
    compressedContentChars: compressedContent.length,
    compressedDetailsChars: compressedDetails.length,
    compressedHash: stableHash(compressedSerialized),
    truncated: args.truncated,
    reason: args.reason
  };
}

function extractArtifactPaths(value) {
  const paths = new Set();
  visit(value, (entry, key) => {
    if (paths.size >= MAX_ARTIFACT_PATHS) return;
    if (typeof entry !== "string") return;
    const normalizedKey = key.toLowerCase();
    if (
      normalizedKey.includes("path") ||
      normalizedKey.includes("file") ||
      /\.(?:png|jpe?g|webp|gif|svg|html|csv|xlsx|json|md|txt|pdf)$/i.test(entry)
    ) {
      paths.add(entry);
    }
  });
  return paths.size ? [...paths] : undefined;
}

function visit(value, callback, key = "", depth = 0) {
  if (depth > 5) return;
  callback(value, key);
  if (Array.isArray(value)) {
    value.slice(0, 80).forEach((entry, index) => visit(entry, callback, String(index), depth + 1));
    return;
  }
  if (isRecord(value)) {
    Object.entries(value).slice(0, 120).forEach(([childKey, entry]) => visit(entry, callback, childKey, depth + 1));
  }
}

function normalizeExecutionResult(result) {
  return {
    ...result,
    content: stringifyContent(result?.content)
  };
}

function stringifyContent(content) {
  if (typeof content === "string") return content;
  if (content === undefined || content === null) return "";
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part;
      if (isRecord(part) && part.type === "text" && typeof part.text === "string") return part.text;
      return safeJson(part) ?? String(part);
    }).join("\n");
  }
  return safeJson(content) ?? String(content);
}

function isSummaryPriorityKey(key) {
  return /^(?:ok|error|message|summary|title|path|file|name|id|status|exitCode|stderr|stdout|artifact|artifacts|diagnostics)$/i.test(key);
}

function pickDefined(record) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function pruneUndefined(record) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function parseJson(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function stringField(value) {
  return typeof value === "string" ? value : "";
}

function stableHash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPrimitive(value) {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}
