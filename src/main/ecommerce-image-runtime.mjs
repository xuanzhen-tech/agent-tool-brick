/**
 * 电商图片工具的本地异步运行时。
 *
 * Gateway 只执行无状态的单图请求；这里负责 workspace 边界、参考图去重、
 * 批次队列、不可覆盖的资产版本和重启后的 interrupted 收敛。
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { postServerToolGatewayMultipart } from "./server-tool-gateway.mjs";

const SCHEMA_VERSION = "agent-ecommerce-image.manifest.v1";
const MODEL_ID = "gpt-image-2";
const MAX_BATCH_IMAGES = 9;
const MAX_REFERENCES = 5;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_REFERENCE_BYTES = 30 * 1024 * 1024;
const MAX_WAIT_MS = 30_000;
const SINGLE_IMAGE_TIMEOUT_MS = 390_000;
const MAX_RETRIES = 2;
const CONCURRENCY = 2;
const TERMINAL_ITEM_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);
const TERMINAL_BATCH_STATUSES = new Set(["partial", "completed", "failed", "cancelled", "interrupted"]);
const IMAGE_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"]
]);
const OUTPUT_EXTENSIONS = {
  png: ".png",
  jpeg: ".jpg",
  webp: ".webp"
};
const REFERENCE_ROLES = new Set(["product", "logo", "style", "scene", "layout"]);
const PRESERVE_MODES = new Set(["strict", "balanced", "loose"]);
const QUALITY_VALUES = new Set(["auto", "low", "medium", "high"]);
const OUTPUT_FORMATS = new Set(["png", "jpeg", "webp"]);

export function createEcommerceImageRuntime(config) {
  return new EcommerceImageRuntime(config);
}

export class EcommerceImageRuntime {
  constructor(config, options = {}) {
    this.config = config;
    this.fetchImage = options.fetchImage ?? postServerToolGatewayMultipart;
    this.queue = [];
    this.running = 0;
    this.controllers = new Map();
    this.workspaceInitializers = new Map();
    this.batchWaiters = new Map();
    this.batchLocks = new Map();
    this.assetLocks = new Map();
    this.disposed = false;
  }

  async generate(call) {
    this.#assertActive();
    const workspace = await this.#initializeWorkspace(resolveWorkspace(call));
    const input = await normalizeGenerateInput(call.arguments ?? {}, workspace);
    const batch = {
      schemaVersion: SCHEMA_VERSION,
      batchId: createId("batch"),
      type: "generate",
      modelId: input.modelId,
      status: "queued",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      count: input.count,
      output: input.output,
      items: []
    };

    for (let outputIndex = 1; outputIndex <= input.count; outputIndex += 1) {
      const assetId = createId("asset");
      const item = {
        itemId: createId("item"),
        kind: "generate",
        status: "queued",
        outputIndex,
        prompt: input.prompt,
        size: input.size,
        quality: input.quality,
        output: input.output,
        references: input.references,
        assetId,
        versionId: "v1",
        attempts: 0,
        createdAt: nowIso(),
        updatedAt: nowIso()
      };
      batch.items.push(item);
      await this.#writeAssetManifest(workspace, createAssetManifest({
        assetId,
        batchId: batch.batchId,
        item
      }));
    }

    await this.#writeBatch(workspace, batch);
    this.#enqueueBatch(workspace, batch.batchId, batch.items.map((item) => item.itemId));
    return queuedResult(call, batch);
  }

  async edit(call) {
    this.#assertActive();
    const workspace = await this.#initializeWorkspace(resolveWorkspace(call));
    const input = await normalizeEditInput(call.arguments ?? {}, workspace);
    const batch = {
      schemaVersion: SCHEMA_VERSION,
      batchId: createId("batch"),
      type: "edit",
      modelId: input.modelId,
      status: "queued",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      output: input.output,
      items: []
    };

    for (let index = 0; index < input.edits.length; index += 1) {
      const edit = input.edits[index];
      const item = await this.#withAssetLock(workspace, edit.assetId, async () => {
        const asset = await this.#readAssetManifest(workspace, edit.assetId);
        const sourceVersion = asset.versions.find((version) => version.versionId === edit.versionId);
        if (!sourceVersion || sourceVersion.status !== "completed" || !sourceVersion.path) {
          throw invalidInput("ecommerce_image_version_not_found", `资产 ${edit.assetId} 不存在可编辑版本 ${edit.versionId}。`);
        }
        const versionId = nextVersionId(asset.versions);
        const nextItem = {
          itemId: createId("item"),
          kind: "edit",
          status: "queued",
          editIndex: index + 1,
          prompt: edit.prompt,
          size: edit.size,
          quality: edit.quality,
          output: input.output,
          references: edit.references,
          sourcePath: sourceVersion.path,
          assetId: edit.assetId,
          versionId,
          parentVersionId: edit.versionId,
          attempts: 0,
          createdAt: nowIso(),
          updatedAt: nowIso()
        };
        asset.versions.push(createAssetVersion({ batchId: batch.batchId, item: nextItem }));
        asset.updatedAt = nowIso();
        await this.#writeAssetManifest(workspace, asset);
        return nextItem;
      });
      batch.items.push(item);
    }

    await this.#writeBatch(workspace, batch);
    this.#enqueueBatch(workspace, batch.batchId, batch.items.map((item) => item.itemId));
    return queuedResult(call, batch);
  }

  async batch(call) {
    const workspace = await this.#initializeWorkspace(resolveWorkspace(call));
    const input = normalizeBatchInput(call.arguments ?? {});
    if (input.action === "cancel") return await this.#cancelBatch(call, workspace, input.batchId);
    if (input.action === "retry") return await this.#retryBatch(call, workspace, input.batchId);

    let batch = await this.#readBatch(workspace, input.batchId);
    if (input.waitMs > 0 && !TERMINAL_BATCH_STATUSES.has(batch.status)) {
      await this.#waitForBatch(workspace, input.batchId, input.waitMs, call.signal);
      batch = await this.#readBatch(workspace, input.batchId);
    }
    return batchStatusResult(call, batch);
  }

  async list(call) {
    const workspace = await this.#initializeWorkspace(resolveWorkspace(call));
    const input = normalizeListInput(call.arguments ?? {});
    if (input.assetId) {
      const asset = await this.#readAssetManifest(workspace, input.assetId);
      return completedResult(call, {
        query: { assetId: input.assetId },
        assets: [asset],
        batches: []
      }, createAssetArtifacts(asset));
    }
    if (input.batchId) {
      const batch = await this.#readBatch(workspace, input.batchId);
      return completedResult(call, {
        query: { batchId: input.batchId },
        batches: [publicBatch(batch)],
        assets: []
      }, createBatchArtifacts(batch));
    }

    const batchDirectory = workspacePaths(workspace).batches;
    const entries = await fs.readdir(batchDirectory, { withFileTypes: true });
    const batches = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const batch = await readJson(path.join(batchDirectory, entry.name, "manifest.json")).catch(() => undefined);
      if (!batch || (input.status && batch.status !== input.status)) continue;
      batches.push(publicBatch(batch));
    }
    batches.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
    return completedResult(call, {
      query: input,
      batches: batches.slice(0, input.limit),
      assets: []
    });
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const controller of this.controllers.values()) controller.abort("AgentTool 已释放。");

    for (const entry of this.queue.splice(0)) {
      await this.#markItemTerminal(entry.workspace, entry.batchId, entry.itemId, {
        status: "interrupted",
        error: { code: "ecommerce_image_interrupted", message: "AgentTool 在任务开始前已释放。", retryable: true }
      });
    }
    while (this.running > 0) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  #assertActive() {
    if (this.disposed) throw invalidInput("ecommerce_image_runtime_disposed", "电商图片运行时已释放。");
  }

  async #initializeWorkspace(workspaceInput) {
    const workspace = await fs.realpath(workspaceInput).catch(() => {
      throw invalidInput("ecommerce_image_workspace_not_found", "当前 workspace 不存在。");
    });
    if (!this.workspaceInitializers.has(workspace)) {
      this.workspaceInitializers.set(workspace, this.#prepareWorkspace(workspace));
    }
    await this.workspaceInitializers.get(workspace);
    return workspace;
  }

  async #prepareWorkspace(workspace) {
    const paths = workspacePaths(workspace);
    await Promise.all([
      fs.mkdir(paths.sources, { recursive: true }),
      fs.mkdir(paths.batches, { recursive: true }),
      fs.mkdir(paths.assets, { recursive: true })
    ]);
    const entries = await fs.readdir(paths.batches, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const manifestPath = path.join(paths.batches, entry.name, "manifest.json");
      const batch = await readJson(manifestPath).catch(() => undefined);
      if (!batch || !["queued", "running"].includes(batch.status)) continue;
      for (const item of batch.items ?? []) {
        if (!["queued", "running"].includes(item.status)) continue;
        item.status = "interrupted";
        item.updatedAt = nowIso();
        item.error = {
          code: "ecommerce_image_restart_interrupted",
          message: "AgentTool 重启时任务尚未完成，已标记为 interrupted。",
          retryable: true
        };
        await this.#updateAssetVersion(workspace, item);
      }
      batch.status = deriveBatchStatus(batch.items ?? []);
      batch.updatedAt = nowIso();
      await atomicWriteJson(manifestPath, batch);
    }
  }

  #enqueueBatch(workspace, batchId, itemIds) {
    for (const itemId of itemIds) this.queue.push({ workspace, batchId, itemId });
    this.#drainQueue();
  }

  #drainQueue() {
    while (!this.disposed && this.running < CONCURRENCY && this.queue.length > 0) {
      const entry = this.queue.shift();
      this.running += 1;
      void this.#runQueueItem(entry).finally(() => {
        this.running -= 1;
        this.#drainQueue();
      });
    }
  }

  async #runQueueItem(entry) {
    const controller = new AbortController();
    const key = itemKey(entry.workspace, entry.batchId, entry.itemId);
    this.controllers.set(key, controller);
    try {
      const item = await this.#withBatchLock(entry.workspace, entry.batchId, async () => {
        const batch = await this.#readBatch(entry.workspace, entry.batchId);
        const currentItem = batch.items.find((candidate) => candidate.itemId === entry.itemId);
        if (!currentItem || currentItem.status !== "queued") return undefined;
        currentItem.status = "running";
        currentItem.startedAt = nowIso();
        currentItem.updatedAt = nowIso();
        batch.status = deriveBatchStatus(batch.items);
        batch.updatedAt = nowIso();
        await this.#writeBatch(entry.workspace, batch);
        return currentItem;
      });
      if (!item) return;
      await this.#updateAssetVersion(entry.workspace, item);

      const response = await retryTransient(async () => {
        item.attempts += 1;
        await this.#persistItem(entry.workspace, entry.batchId, item);
        return await this.#requestImage(entry.workspace, item, controller.signal);
      }, controller.signal);
      const outputBytes = decodeOutputImage(response, item.output.format);
      const outputPath = assetVersionPath(item.assetId, item.versionId, response.mimeType);
      await atomicWriteBuffer(path.join(entry.workspace, ...outputPath.split("/")), outputBytes);
      item.status = "completed";
      item.path = outputPath;
      item.mimeType = response.mimeType;
      item.bytes = outputBytes.byteLength;
      item.contentHash = sha256(outputBytes);
      item.providerRequestId = response.providerRequestId;
      item.finishedAt = nowIso();
      item.updatedAt = nowIso();
      delete item.error;
      await this.#persistItem(entry.workspace, entry.batchId, item);
    } catch (error) {
      const cancelled = controller.signal.aborted;
      const interrupted = cancelled && this.disposed;
      await this.#markItemTerminal(entry.workspace, entry.batchId, entry.itemId, {
        status: cancelled ? (interrupted ? "interrupted" : "cancelled") : "failed",
        error: normalizeFailure(error, { cancelled, interrupted })
      });
    } finally {
      this.controllers.delete(key);
    }
  }

  async #requestImage(workspace, item, signal) {
    const images = [];
    if (item.kind === "edit") {
      images.push(await readStoredImage(workspace, item.sourcePath));
    }
    for (const reference of item.references ?? []) {
      images.push(await readStoredImage(workspace, reference.sourcePath));
    }
    const request = {
      modelId: MODEL_ID,
      prompt: renderProviderPrompt(item.prompt, item.references ?? [], item.kind === "edit"),
      size: item.size,
      quality: item.quality,
      output: item.output
    };
    const endpoint = item.kind === "edit" || images.length > 0
      ? "/api/tools/ecommerce/images/edit"
      : "/api/tools/ecommerce/images/generate";
    return await withTimeout(
      (timeoutSignal) => this.fetchImage(this.config, endpoint, { request, images }, timeoutSignal),
      SINGLE_IMAGE_TIMEOUT_MS,
      signal
    );
  }

  async #persistItem(workspace, batchId, currentItem) {
    await this.#withBatchLock(workspace, batchId, async () => {
      const batch = await this.#readBatch(workspace, batchId);
      const index = batch.items.findIndex((item) => item.itemId === currentItem.itemId);
      if (index < 0) return;
      batch.items[index] = currentItem;
      await this.#updateAssetVersion(workspace, currentItem);
      batch.status = deriveBatchStatus(batch.items);
      batch.updatedAt = nowIso();
      await this.#writeBatch(workspace, batch);
    });
  }

  async #markItemTerminal(workspace, batchId, itemId, patch) {
    const item = await this.#withBatchLock(workspace, batchId, async () => {
      const batch = await this.#readBatch(workspace, batchId).catch(() => undefined);
      if (!batch) return undefined;
      const currentItem = batch.items.find((candidate) => candidate.itemId === itemId);
      if (!currentItem || TERMINAL_ITEM_STATUSES.has(currentItem.status)) return undefined;
      Object.assign(currentItem, patch, { finishedAt: nowIso(), updatedAt: nowIso() });
      await this.#updateAssetVersion(workspace, currentItem);
      batch.status = deriveBatchStatus(batch.items);
      batch.updatedAt = nowIso();
      await this.#writeBatch(workspace, batch);
      return currentItem;
    });
    if (!item) return;
  }

  async #cancelBatch(call, workspace, batchId) {
    const runningItems = [];
    const cancelledItems = [];
    await this.#withBatchLock(workspace, batchId, async () => {
      const batch = await this.#readBatch(workspace, batchId);
      for (const item of batch.items) {
        if (item.status === "queued") {
          item.status = "cancelled";
          item.error = {
            code: "ecommerce_image_cancelled",
            message: "批次已取消。上游是同步生图接口，已发出的请求仍可能继续生成并计费。",
            retryable: false
          };
          item.finishedAt = nowIso();
          item.updatedAt = nowIso();
          cancelledItems.push(item);
        } else if (item.status === "running") {
          runningItems.push(item.itemId);
        }
      }
      batch.status = deriveBatchStatus(batch.items);
      batch.updatedAt = nowIso();
      await this.#writeBatch(workspace, batch, { notify: false });
    });
    for (const item of cancelledItems) await this.#updateAssetVersion(workspace, item);
    this.#notifyBatch(workspace, batchId);
    this.queue = this.queue.filter((entry) => !(entry.workspace === workspace && entry.batchId === batchId));
    for (const itemId of runningItems) {
      this.controllers.get(itemKey(workspace, batchId, itemId))?.abort(
        "批次已取消。上游是同步生图接口，已发出的请求仍可能继续生成并计费。"
      );
    }
    return batchStatusResult(call, await this.#readBatch(workspace, batchId));
  }

  async #retryBatch(call, workspace, batchId) {
    const original = await this.#readBatch(workspace, batchId);
    const retryable = original.items.filter((item) => ["failed", "interrupted"].includes(item.status));
    if (!retryable.length) {
      throw invalidInput("ecommerce_image_nothing_to_retry", "该批次没有 failed 或 interrupted 项目。");
    }
    if (original.type === "generate") {
      const first = retryable[0];
      return await this.generate({
        ...call,
        arguments: {
          modelId: original.modelId,
          prompt: first.prompt,
          size: first.size,
          quality: first.quality,
          count: retryable.length,
          referenceImages: (first.references ?? []).map(storedReferenceToInput),
          output: original.output
        }
      });
    }
    return await this.edit({
      ...call,
      arguments: {
        modelId: original.modelId,
        edits: retryable.map((item) => ({
          assetId: item.assetId,
          versionId: item.parentVersionId,
          prompt: item.prompt,
          size: item.size,
          quality: item.quality,
          additionalReferenceImages: (item.references ?? []).map(storedReferenceToInput)
        })),
        output: original.output
      }
    });
  }

  async #waitForBatch(workspace, batchId, waitMs, signal) {
    const key = batchKey(workspace, batchId);
    await new Promise((resolve, reject) => {
      const waiter = { resolve, timer: undefined };
      const waiters = this.batchWaiters.get(key) ?? new Set();
      waiters.add(waiter);
      this.batchWaiters.set(key, waiters);
      let onAbort;
      const cleanup = () => {
        clearTimeout(waiter.timer);
        waiters.delete(waiter);
        if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      };
      waiter.cleanup = cleanup;
      waiter.timer = setTimeout(() => {
        cleanup();
        resolve();
      }, waitMs);
      if (signal) {
        onAbort = () => {
          cleanup();
          reject(signal.reason ?? new Error("批次查询已取消。"));
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  #notifyBatch(workspace, batchId) {
    const key = batchKey(workspace, batchId);
    const waiters = this.batchWaiters.get(key);
    if (!waiters) return;
    this.batchWaiters.delete(key);
    for (const waiter of waiters) {
      waiter.cleanup?.();
      waiter.resolve();
    }
  }

  async #readBatch(workspace, batchId) {
    validateId(batchId, "batch", "batchId");
    return await readJson(path.join(workspacePaths(workspace).batches, batchId, "manifest.json")).catch((error) => {
      throw invalidInput("ecommerce_image_batch_not_found", `找不到批次 ${batchId}：${formatError(error)}`);
    });
  }

  async #writeBatch(workspace, batch, options = {}) {
    const filePath = path.join(workspacePaths(workspace).batches, batch.batchId, "manifest.json");
    await atomicWriteJson(filePath, batch);
    if (options.notify !== false) this.#notifyBatch(workspace, batch.batchId);
  }

  async #readAssetManifest(workspace, assetId) {
    validateId(assetId, "asset", "assetId");
    return await readJson(path.join(workspacePaths(workspace).assets, assetId, "manifest.json")).catch((error) => {
      throw invalidInput("ecommerce_image_asset_not_found", `找不到资产 ${assetId}：${formatError(error)}`);
    });
  }

  async #writeAssetManifest(workspace, asset) {
    await atomicWriteJson(path.join(workspacePaths(workspace).assets, asset.assetId, "manifest.json"), asset);
  }

  async #updateAssetVersion(workspace, item) {
    if (!item?.assetId || !item?.versionId) return;
    await this.#withAssetLock(workspace, item.assetId, async () => {
      const asset = await this.#readAssetManifest(workspace, item.assetId).catch(() => undefined);
      if (!asset) return;
      const version = asset.versions.find((candidate) => candidate.versionId === item.versionId);
      if (!version) return;
      Object.assign(version, createAssetVersion({ batchId: version.batchId, item }));
      asset.updatedAt = nowIso();
      await this.#writeAssetManifest(workspace, asset);
    });
  }

  async #withAssetLock(workspace, assetId, operation) {
    const key = `${workspace}\0${assetId}`;
    const previous = this.assetLocks.get(key) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    const chained = previous.then(() => current);
    this.assetLocks.set(key, chained);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.assetLocks.get(key) === chained) this.assetLocks.delete(key);
    }
  }

  async #withBatchLock(workspace, batchId, operation) {
    const key = batchKey(workspace, batchId);
    const previous = this.batchLocks.get(key) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    const chained = previous.then(() => current);
    this.batchLocks.set(key, chained);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.batchLocks.get(key) === chained) this.batchLocks.delete(key);
    }
  }
}

async function normalizeGenerateInput(value, workspace) {
  assertRecord(value, "ecommerce_image_generate 参数必须是对象。");
  assertAllowedKeys(value, ["modelId", "prompt", "size", "quality", "count", "referenceImages", "output"]);
  const modelId = normalizeModel(value.modelId);
  return {
    modelId,
    prompt: normalizePrompt(value.prompt),
    size: normalizeSize(value.size),
    quality: normalizeQuality(value.quality),
    count: value.count === undefined ? 1 : normalizeInteger(value.count, "count", 1, MAX_BATCH_IMAGES),
    references: await normalizeReferences(value.referenceImages, workspace),
    output: normalizeOutput(value.output)
  };
}

async function normalizeEditInput(value, workspace) {
  assertRecord(value, "ecommerce_image_edit 参数必须是对象。");
  assertAllowedKeys(value, ["modelId", "edits", "output"]);
  const modelId = normalizeModel(value.modelId);
  if (!Array.isArray(value.edits) || !value.edits.length || value.edits.length > MAX_BATCH_IMAGES) {
    throw invalidInput("ecommerce_image_edits_required", `edits 必须是 1 到 ${MAX_BATCH_IMAGES} 项的数组。`);
  }
  const seenAssets = new Set();
  const edits = [];
  for (const rawEdit of value.edits) {
    assertRecord(rawEdit, "每个 edit 必须是对象。");
    assertAllowedKeys(rawEdit, ["assetId", "versionId", "prompt", "size", "quality", "additionalReferenceImages"]);
    const assetId = normalizeId(rawEdit.assetId, "asset", "assetId");
    if (seenAssets.has(assetId)) {
      throw invalidInput("ecommerce_image_duplicate_asset_edit", "同一批次不能同时编辑同一个 assetId。");
    }
    seenAssets.add(assetId);
    edits.push({
      assetId,
      versionId: normalizeVersionId(rawEdit.versionId),
      prompt: normalizePrompt(rawEdit.prompt),
      size: normalizeSize(rawEdit.size),
      quality: normalizeQuality(rawEdit.quality),
      references: await normalizeReferences(rawEdit.additionalReferenceImages, workspace)
    });
  }
  return { modelId, edits, output: normalizeOutput(value.output) };
}

function normalizeBatchInput(value) {
  assertRecord(value, "ecommerce_image_batch 参数必须是对象。");
  assertAllowedKeys(value, ["action", "batchId", "waitMs"]);
  const action = String(value.action ?? "").trim();
  if (!["status", "cancel", "retry"].includes(action)) {
    throw invalidInput("ecommerce_image_invalid_batch_action", "action 必须是 status、cancel 或 retry。");
  }
  const waitMs = action === "status" && value.waitMs !== undefined
    ? normalizeInteger(value.waitMs, "waitMs", 0, MAX_WAIT_MS)
    : 0;
  return {
    action,
    batchId: normalizeId(value.batchId, "batch", "batchId"),
    waitMs
  };
}

function normalizeListInput(value) {
  assertRecord(value, "ecommerce_image_list 参数必须是对象。");
  assertAllowedKeys(value, ["batchId", "assetId", "status", "limit"]);
  const batchId = value.batchId === undefined ? undefined : normalizeId(value.batchId, "batch", "batchId");
  const assetId = value.assetId === undefined ? undefined : normalizeId(value.assetId, "asset", "assetId");
  if (batchId && assetId) throw invalidInput("ecommerce_image_ambiguous_query", "batchId 和 assetId 不能同时提供。");
  const status = value.status === undefined ? undefined : String(value.status);
  if (status && !["queued", "running", "partial", "completed", "failed", "cancelled", "interrupted"].includes(status)) {
    throw invalidInput("ecommerce_image_invalid_status", "status 不是受支持的批次状态。");
  }
  return {
    batchId,
    assetId,
    status,
    limit: value.limit === undefined ? 20 : normalizeInteger(value.limit, "limit", 1, 100)
  };
}

async function normalizeReferences(value, workspace) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_REFERENCES) {
    throw invalidInput("ecommerce_image_invalid_references", `参考图必须是数组，且每项最多 ${MAX_REFERENCES} 张。`);
  }
  const references = [];
  let totalBytes = 0;
  for (const item of value) {
    assertRecord(item, "每张参考图必须是对象。");
    assertAllowedKeys(item, ["path", "role", "preserve"]);
    const role = String(item.role ?? "").trim();
    const preserve = String(item.preserve ?? "").trim();
    if (!REFERENCE_ROLES.has(role)) {
      throw invalidInput("ecommerce_image_invalid_reference_role", "参考图 role 必须是 product、logo、style、scene 或 layout。");
    }
    if (!PRESERVE_MODES.has(preserve)) {
      throw invalidInput("ecommerce_image_invalid_preserve_mode", "参考图 preserve 必须是 strict、balanced 或 loose。");
    }
    const source = await importWorkspaceImage(workspace, item.path);
    totalBytes += source.bytes;
    if (totalBytes > MAX_REFERENCE_BYTES) {
      throw invalidInput("ecommerce_image_references_too_large", "单个 job 的参考图总大小不能超过 30MB。");
    }
    references.push({
      path: source.originalPath,
      sourcePath: source.sourcePath,
      contentHash: source.contentHash,
      mimeType: source.mimeType,
      bytes: source.bytes,
      role,
      preserve
    });
  }
  return references;
}

async function importWorkspaceImage(workspace, requestedPath) {
  const raw = typeof requestedPath === "string" ? requestedPath.trim() : "";
  if (!raw || raw.includes("\0")) throw invalidInput("ecommerce_image_invalid_reference_path", "参考图 path 无效。");
  const candidate = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(workspace, raw);
  const realFile = await fs.realpath(candidate).catch((error) => {
    throw invalidInput("ecommerce_image_reference_not_found", `无法读取参考图：${formatError(error)}`);
  });
  assertPathInside(workspace, realFile);
  const stat = await fs.stat(realFile);
  if (!stat.isFile() || !stat.size || stat.size > MAX_IMAGE_BYTES) {
    throw invalidInput("ecommerce_image_invalid_reference_size", "参考图必须是 1 字节到 10MB 的普通文件。");
  }
  const bytes = await fs.readFile(realFile);
  const mimeType = detectInputMime(bytes);
  const extensionMime = IMAGE_TYPES.get(path.extname(realFile).toLowerCase());
  if (!extensionMime || extensionMime !== mimeType) {
    throw invalidInput("ecommerce_image_invalid_reference_type", "参考图扩展名和实际内容必须一致，且仅支持 PNG、JPEG、WebP。");
  }
  const contentHash = sha256(bytes);
  const extension = mimeType === "image/jpeg" ? ".jpg" : mimeType === "image/webp" ? ".webp" : ".png";
  const sourcePath = `outputs/ecommerce-images/sources/${contentHash}${extension}`;
  const absoluteSource = path.join(workspace, ...sourcePath.split("/"));
  await fs.mkdir(path.dirname(absoluteSource), { recursive: true });
  await fs.copyFile(realFile, absoluteSource, fs.constants?.COPYFILE_EXCL).catch(async (error) => {
    if (error.code !== "EEXIST") throw error;
  });
  return {
    originalPath: toWorkspacePath(workspace, realFile),
    sourcePath,
    contentHash,
    mimeType,
    bytes: bytes.byteLength
  };
}

function normalizeModel(value) {
  const modelId = value === undefined ? MODEL_ID : String(value).trim();
  if (modelId !== MODEL_ID) throw invalidInput("ecommerce_image_model_not_supported", "首版只支持 gpt-image-2。");
  return modelId;
}

function normalizePrompt(value) {
  const prompt = typeof value === "string" ? value.trim() : "";
  if (!prompt || prompt.length > 8_000) {
    throw invalidInput("ecommerce_image_invalid_prompt", "prompt 必须是 1 到 8000 个字符。");
  }
  return prompt;
}

function normalizeQuality(value) {
  const quality = value === undefined ? "auto" : String(value).trim();
  if (!QUALITY_VALUES.has(quality)) throw invalidInput("ecommerce_image_invalid_quality", "quality 必须是 auto、low、medium 或 high。");
  return quality;
}

function normalizeSize(value) {
  assertRecord(value, "size 必须包含 width 和 height。");
  assertAllowedKeys(value, ["width", "height"]);
  const width = value.width;
  const height = value.height;
  const longEdge = Math.max(width, height);
  const shortEdge = Math.min(width, height);
  const pixels = width * height;
  if (
    !Number.isInteger(width) || !Number.isInteger(height)
    || width <= 0 || height <= 0
    || width % 16 !== 0 || height % 16 !== 0
    || longEdge > 3840 || longEdge / shortEdge > 3
    || pixels < 655_360 || pixels > 8_294_400
  ) {
    throw invalidInput(
      "ecommerce_image_invalid_size",
      "宽高必须为 16 的倍数，单边不超过 3840，比例不超过 3:1，总像素需位于 655360 到 8294400 之间。"
    );
  }
  return { width, height };
}

function normalizeOutput(value) {
  const output = value === undefined ? {} : value;
  assertRecord(output, "output 必须是对象。");
  assertAllowedKeys(output, ["format", "compression"]);
  const format = output.format === undefined ? "png" : String(output.format).trim();
  if (!OUTPUT_FORMATS.has(format)) throw invalidInput("ecommerce_image_invalid_format", "output.format 必须是 png、jpeg 或 webp。");
  const compression = output.compression === undefined
    ? undefined
    : normalizeInteger(output.compression, "compression", 0, 100);
  if (format === "png" && compression !== undefined) {
    throw invalidInput("ecommerce_image_invalid_compression", "PNG 不支持 output.compression。");
  }
  return { format, ...(compression !== undefined ? { compression } : {}) };
}

function renderProviderPrompt(prompt, references, editing) {
  const lines = [prompt];
  if (editing) {
    lines.push("图片 1 是待编辑的目标版本。未明确要求变更的商品结构、颜色、文字和 Logo 必须保持不变。");
  }
  if (references.length) {
    lines.push(editing ? "额外参考图语义：" : "参考图语义：");
    references.forEach((reference, index) => {
      const imageNumber = index + (editing ? 2 : 1);
      lines.push(`图片 ${imageNumber}: role=${reference.role}; preserve=${reference.preserve}; ${preserveInstruction(reference.preserve)}`);
    });
  }
  return lines.join("\n\n");
}

function preserveInstruction(value) {
  if (value === "strict") return "严格保持该参考图对应主体的身份、结构、颜色、文字与 Logo。";
  if (value === "balanced") return "保持核心视觉特征，允许为场景适配做有限调整。";
  return "仅作为方向参考，允许较大创作变化。";
}

async function readStoredImage(workspace, workspacePath) {
  const absolutePath = path.join(workspace, ...String(workspacePath).split("/"));
  const realFile = await fs.realpath(absolutePath);
  assertPathInside(workspace, realFile);
  const bytes = await fs.readFile(realFile);
  const mimeType = detectInputMime(bytes);
  return {
    bytes,
    mimeType,
    filename: path.basename(realFile)
  };
}

function decodeOutputImage(response, expectedFormat) {
  if (!response || typeof response.imageBase64 !== "string" || typeof response.mimeType !== "string") {
    throw invalidInput("ecommerce_image_invalid_gateway_response", "Gateway 未返回有效图片。");
  }
  const bytes = Buffer.from(response.imageBase64, "base64");
  const actualMime = detectInputMime(bytes);
  if (
    actualMime !== response.mimeType
    || !OUTPUT_EXTENSIONS[mimeToFormat(actualMime)]
    || mimeToFormat(actualMime) !== expectedFormat
  ) {
    throw invalidInput("ecommerce_image_invalid_gateway_response", "Gateway 返回的图片 MIME 与实际内容不一致。");
  }
  return bytes;
}

function createAssetManifest({ assetId, batchId, item }) {
  return {
    schemaVersion: SCHEMA_VERSION,
    assetId,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    versions: [createAssetVersion({ batchId, item })]
  };
}

function createAssetVersion({ batchId, item }) {
  return {
    versionId: item.versionId,
    parentVersionId: item.parentVersionId,
    batchId,
    status: item.status,
    modelId: MODEL_ID,
    outputIndex: item.outputIndex,
    prompt: item.prompt,
    size: item.size,
    quality: item.quality,
    output: item.output,
    references: item.references,
    path: item.path,
    mimeType: item.mimeType,
    bytes: item.bytes,
    contentHash: item.contentHash,
    attempts: item.attempts,
    error: item.error,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    finishedAt: item.finishedAt
  };
}

function queuedResult(call, batch) {
  return completedResult(call, {
    batchId: batch.batchId,
    status: batch.status,
    imageCount: batch.items.length
  });
}

function batchStatusResult(call, batch) {
  return completedResult(call, publicBatch(batch), createBatchArtifacts(batch));
}

function completedResult(call, details, artifacts = []) {
  return {
    status: "completed",
    content: JSON.stringify(details, null, 2),
    details,
    artifacts
  };
}

function publicBatch(batch) {
  return {
    batchId: batch.batchId,
    type: batch.type,
    modelId: batch.modelId,
    status: batch.status,
    createdAt: batch.createdAt,
    updatedAt: batch.updatedAt,
    output: batch.output,
    ...(batch.type === "generate" ? { count: batch.count } : {}),
    progress: {
      total: batch.items.length,
      queued: batch.items.filter((item) => item.status === "queued").length,
      running: batch.items.filter((item) => item.status === "running").length,
      completed: batch.items.filter((item) => item.status === "completed").length,
      failed: batch.items.filter((item) => item.status === "failed").length,
      cancelled: batch.items.filter((item) => item.status === "cancelled").length,
      interrupted: batch.items.filter((item) => item.status === "interrupted").length
    },
    items: batch.items.map((item) => ({
      itemId: item.itemId,
      status: item.status,
      outputIndex: item.outputIndex,
      assetId: item.assetId,
      versionId: item.versionId,
      parentVersionId: item.parentVersionId,
      path: item.path,
      mimeType: item.mimeType,
      bytes: item.bytes,
      contentHash: item.contentHash,
      attempts: item.attempts,
      error: item.error
    }))
  };
}

function createBatchArtifacts(batch) {
  return batch.items
    .filter((item) => item.status === "completed" && item.path)
    .map((item) => createArtifact(item, batch.batchId));
}

function createAssetArtifacts(asset) {
  return asset.versions
    .filter((version) => version.status === "completed" && version.path)
    .map((version) => createArtifact({ ...version, assetId: asset.assetId }, version.batchId));
}

function createArtifact(item, batchId) {
  return {
    schemaVersion: "agent-output.v1",
    kind: "image",
    renderer: "ecommerce-image",
    id: `ecommerce-${item.assetId}-${item.versionId}`,
    title: `电商图片 ${item.assetId} ${item.versionId}`,
    files: [{
      path: item.path,
      mimeType: item.mimeType,
      bytes: item.bytes
    }],
    data: {
      schemaVersion: "agent-ecommerce-image.v1",
      batchId,
      assetId: item.assetId,
      versionId: item.versionId,
      parentVersionId: item.parentVersionId,
      outputIndex: item.outputIndex,
      path: item.path,
      contentHash: item.contentHash,
      modelId: MODEL_ID,
      size: item.size,
      quality: item.quality
    }
  };
}

function deriveBatchStatus(items) {
  if (items.some((item) => item.status === "running")) return "running";
  if (items.some((item) => item.status === "queued")) return "queued";
  const completed = items.filter((item) => item.status === "completed").length;
  if (completed === items.length) return "completed";
  if (completed > 0) return "partial";
  if (items.every((item) => item.status === "cancelled")) return "cancelled";
  if (items.every((item) => item.status === "interrupted")) return "interrupted";
  return "failed";
}

async function retryTransient(operation, signal) {
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (signal.aborted || error?.retryable !== true || attempt === MAX_RETRIES) throw error;
      await abortableDelay(250 * (2 ** attempt), signal);
    }
  }
  throw lastError;
}

async function withTimeout(operation, timeoutMs, parentSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(`单张图片生成超过 ${timeoutMs}ms。`), timeoutMs);
  const abort = () => controller.abort(parentSignal.reason);
  if (parentSignal?.aborted) abort();
  else parentSignal?.addEventListener("abort", abort, { once: true });
  try {
    return await operation(controller.signal);
  } catch (error) {
    if (controller.signal.aborted && !parentSignal?.aborted) {
      const timeoutError = new Error(
        `单张图片生成超过 ${timeoutMs}ms。上游结果未知，不能自动重试。`
      );
      timeoutError.code = "ecommerce_image_timeout";
      timeoutError.retryable = false;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", abort);
  }
}

function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("任务已取消。"));
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

async function atomicWriteJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await fs.rename(temporary, filePath);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function atomicWriteBuffer(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, value);
    await fs.rename(temporary, filePath);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function workspacePaths(workspace) {
  const root = path.join(workspace, "outputs", "ecommerce-images");
  return {
    root,
    sources: path.join(root, "sources"),
    batches: path.join(root, "batches"),
    assets: path.join(root, "assets")
  };
}

function assetVersionPath(assetId, versionId, mimeType) {
  return `outputs/ecommerce-images/assets/${assetId}/versions/${versionId}${OUTPUT_EXTENSIONS[mimeToFormat(mimeType)]}`;
}

function mimeToFormat(mimeType) {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/jpeg") return "jpeg";
  if (mimeType === "image/webp") return "webp";
  return undefined;
}

function detectInputMime(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  throw invalidInput("ecommerce_image_invalid_image_type", "无法识别图片内容，仅支持 PNG、JPEG 和 WebP。");
}

function assertPathInside(workspace, filePath) {
  const relative = path.relative(workspace, filePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw invalidInput("ecommerce_image_workspace_escape", "图片路径必须位于当前 workspace 内。");
  }
}

function toWorkspacePath(workspace, filePath) {
  return path.relative(workspace, filePath).replaceAll(path.sep, "/");
}

function nextVersionId(versions) {
  const maximum = versions.reduce((current, version) => {
    const matched = /^v(\d+)$/.exec(String(version.versionId));
    return matched ? Math.max(current, Number(matched[1])) : current;
  }, 0);
  return `v${maximum + 1}`;
}

function storedReferenceToInput(reference) {
  return {
    path: reference.sourcePath,
    role: reference.role,
    preserve: reference.preserve
  };
}

function resolveWorkspace(call) {
  const workspace = call?.workspace?.root;
  if (typeof workspace !== "string" || !workspace.trim() || !path.isAbsolute(workspace)) {
    throw invalidInput("ecommerce_image_workspace_required", "电商图片工具需要绝对 workspace 路径。");
  }
  return path.resolve(workspace);
}

function normalizeId(value, prefix, field) {
  const normalized = typeof value === "string" ? value.trim() : "";
  validateId(normalized, prefix, field);
  return normalized;
}

function validateId(value, prefix, field) {
  if (!new RegExp(`^${prefix}-[a-f0-9-]{16,}$`).test(String(value))) {
    throw invalidInput("ecommerce_image_invalid_id", `${field} 无效。`);
  }
}

function normalizeVersionId(value) {
  const versionId = typeof value === "string" ? value.trim() : "";
  if (!/^v[1-9]\d*$/.test(versionId)) throw invalidInput("ecommerce_image_invalid_version", "versionId 必须是 v1、v2 等版本号。");
  return versionId;
}

function normalizeInteger(value, field, minimum, maximum) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw invalidInput("ecommerce_image_invalid_integer", `${field} 必须是 ${minimum} 到 ${maximum} 的整数。`);
  }
  return value;
}

function assertRecord(value, message) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidInput("ecommerce_image_invalid_input", message);
}

function assertAllowedKeys(value, allowed) {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length) throw invalidInput("ecommerce_image_unknown_field", `不支持字段：${extras.join(", ")}。`);
}

function invalidInput(code, message) {
  const error = new Error(message);
  error.code = code;
  error.retryable = false;
  return error;
}

function normalizeFailure(error, state) {
  if (state.interrupted) {
    return {
      code: "ecommerce_image_interrupted",
      message: error instanceof Error ? error.message : "图片任务被 AgentTool 关闭中断。",
      retryable: true
    };
  }
  if (state.cancelled) {
    return {
      code: "ecommerce_image_cancelled",
      message: "图片任务已取消。上游是同步生图接口，已发出的请求仍可能继续生成并计费。",
      retryable: false
    };
  }
  return {
    code: typeof error?.code === "string" ? error.code : "ecommerce_image_failed",
    message: formatError(error),
    retryable: error?.retryable === true
  };
}

function createId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function nowIso() {
  return new Date().toISOString();
}

function batchKey(workspace, batchId) {
  return `${workspace}\0${batchId}`;
}

function itemKey(workspace, batchId, itemId) {
  return `${workspace}\0${batchId}\0${itemId}`;
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}
