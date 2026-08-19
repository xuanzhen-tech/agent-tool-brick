/**
 * 商品照片生视频的本地任务运行时。
 *
 * Gateway 持有 Seedance 密钥并代理单个异步任务；本模块负责 workspace 边界、
 * 持久化轮询、重启恢复、MP4 验证和最终 Agent 产物合同。
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  postServerToolGatewayMultipart,
  requestServerToolGatewayBinary,
  requestServerToolGatewayJson
} from "./server-tool-gateway.mjs";

const SCHEMA_VERSION = "agent-ecommerce-video.job.v1";
const MODEL_ID = "doubao-seedance-2-0";
const IMAGE_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"]
]);
const ALLOWED_RATIOS = new Set(["adaptive", "16:9", "9:16", "1:1", "4:3", "3:4"]);
const ALLOWED_RESOLUTIONS = new Set(["720p", "1080p"]);
const TERMINAL_STATUSES = new Set(["completed", "failed"]);
const RECOVERABLE_STATUSES = new Set(["queued", "running", "interrupted"]);
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_PROMPT_CHARS = 20_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_TASK_TIMEOUT_MS = 35 * 60_000;

export function createEcommerceVideoRuntime(config, options = {}) {
  return new EcommerceVideoRuntime(config, options);
}

export class EcommerceVideoRuntime {
  constructor(config, options = {}) {
    this.config = config;
    this.submitTask = options.submitTask ?? postServerToolGatewayMultipart;
    this.readTask = options.readTask ?? requestServerToolGatewayJson;
    this.readContent = options.readContent ?? requestServerToolGatewayBinary;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.taskTimeoutMs = options.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
    this.workspaceInitializers = new Map();
    this.workers = new Map();
    this.controllers = new Map();
    this.disposed = false;
  }

  async generate(call) {
    this.#assertActive();
    const workspace = resolveWorkspace(call);
    await this.#initializeWorkspace(workspace);
    const input = await normalizeGenerateInput(call.arguments ?? {}, workspace);
    const requestHash = hashRequest(input);
    const existing = await this.#findIdempotentJob(workspace, call.toolCallId, requestHash);
    const job = existing ?? await this.#createAndSubmitJob(call, workspace, input);
    const worker = this.#ensureWorker(workspace, job.jobId);
    try {
      const completed = await waitForPromise(worker, call.signal);
      return jobResult(completed);
    } catch (error) {
      if (!call.signal?.aborted) throw error;
      const current = await readJob(workspace, job.jobId);
      return interruptedResult(current);
    }
  }

  async list(call) {
    const workspace = resolveWorkspace(call);
    await this.#initializeWorkspace(workspace);
    const input = normalizeListInput(call.arguments ?? {});
    if (input.jobId) {
      const job = await readJob(workspace, input.jobId);
      return completedResult({ jobs: [publicJob(job)], total: 1 }, createArtifacts(job));
    }
    const jobs = await listJobs(workspace);
    const selected = input.status ? jobs.filter((job) => job.status === input.status) : jobs;
    return completedResult({
      jobs: selected.slice(0, input.limit).map(publicJob),
      total: selected.length
    });
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const controller of this.controllers.values()) controller.abort(new Error("AgentTool is disposing."));
    await Promise.allSettled(this.workers.values());
    this.controllers.clear();
    this.workers.clear();
  }

  async #initializeWorkspace(workspace) {
    let initializing = this.workspaceInitializers.get(workspace);
    if (!initializing) {
      initializing = this.#recoverWorkspace(workspace);
      this.workspaceInitializers.set(workspace, initializing);
    }
    await initializing;
    return workspace;
  }

  async #recoverWorkspace(workspace) {
    await fs.mkdir(workspacePaths(workspace).jobs, { recursive: true });
    const jobs = await listJobs(workspace);
    for (const job of jobs) {
      if (job.status === "submitting" && !job.providerTaskId) {
        job.status = "failed";
        job.error = normalizeFailure(failure("ecommerce_video_submission_interrupted", "任务提交状态不确定，为避免重复计费不会自动重提。", false));
        job.updatedAt = nowIso();
        job.completedAt = job.updatedAt;
        await writeJob(workspace, job);
        continue;
      }
      if (job.providerTaskId && RECOVERABLE_STATUSES.has(job.status)) this.#ensureWorker(workspace, job.jobId);
    }
  }

  async #findIdempotentJob(workspace, toolCallId, requestHash) {
    if (typeof toolCallId !== "string" || !toolCallId.trim()) return undefined;
    const jobs = await listJobs(workspace);
    const job = jobs.find((candidate) => candidate.toolCallId === toolCallId.trim());
    if (job && job.requestHash !== requestHash) {
      throw failure("ecommerce_video_idempotency_conflict", "同一 toolCallId 不能提交不同的视频生成参数。", false);
    }
    return job;
  }

  async #createAndSubmitJob(call, workspace, input) {
    const job = {
      schemaVersion: SCHEMA_VERSION,
      jobId: createId("video-job"),
      modelId: MODEL_ID,
      status: "submitting",
      prompt: input.prompt,
      sourceImagePath: input.sourceImagePath,
      sourceImageMimeType: input.image.mimeType,
      sourceImageBytes: input.image.bytes.length,
      sourceImageHash: sha256(input.image.bytes),
      aspectRatio: input.aspectRatio,
      duration: input.duration,
      resolution: input.resolution,
      generateAudio: input.generateAudio,
      toolCallId: typeof call.toolCallId === "string" ? call.toolCallId : undefined,
      requestHash: hashRequest(input),
      traceContext: normalizeTraceContext(call.traceContext),
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    await writeJob(workspace, job);
    try {
      const response = await this.submitTask(this.config, "/api/tools/ecommerce/videos/generate", {
        request: {
          prompt: input.prompt,
          aspectRatio: input.aspectRatio,
          duration: input.duration,
          resolution: input.resolution,
          generateAudio: input.generateAudio
        },
        images: [{ bytes: input.image.bytes, mimeType: input.image.mimeType, filename: path.basename(input.absoluteImagePath) }],
        trace: compactObject({
          ...job.traceContext,
          operationId: job.jobId,
          itemId: job.jobId,
          operation: "ecommerce_video_generate"
        })
      }, call.signal);
      const task = response?.task;
      if (!task || typeof task.id !== "string" || task.status !== "queued") {
        throw failure("ecommerce_video_invalid_gateway_response", "Gateway 未返回有效 Seedance 任务。", true);
      }
      job.providerTaskId = task.id;
      job.gatewayTraceId = typeof task.traceId === "string" ? task.traceId : undefined;
      job.status = "queued";
      job.updatedAt = nowIso();
      await writeJob(workspace, job);
      return job;
    } catch (error) {
      job.status = "failed";
      job.error = normalizeFailure(error);
      job.updatedAt = nowIso();
      job.completedAt = job.updatedAt;
      await writeJob(workspace, job);
      return job;
    }
  }

  #ensureWorker(workspace, jobId) {
    const key = `${workspace}\n${jobId}`;
    const existing = this.workers.get(key);
    if (existing) return existing;
    const controller = new AbortController();
    this.controllers.set(key, controller);
    const worker = this.#runJob(workspace, jobId, controller.signal)
      .finally(() => {
        this.controllers.delete(key);
        this.workers.delete(key);
      });
    this.workers.set(key, worker);
    return worker;
  }

  async #runJob(workspace, jobId, signal) {
    let job = await readJob(workspace, jobId);
    if (TERMINAL_STATUSES.has(job.status)) return job;
    if (!job.providerTaskId) return job;
    const deadline = Date.now() + this.taskTimeoutMs;
    let transientFailures = 0;
    try {
      while (Date.now() < deadline) {
        if (signal.aborted) throw signal.reason ?? new Error("Video worker aborted.");
        let response;
        try {
          response = await this.readTask(
            this.config,
            `/api/tools/ecommerce/videos/tasks/${encodeURIComponent(job.providerTaskId)}`,
            { method: "GET" },
            signal
          );
          transientFailures = 0;
        } catch (error) {
          if (error?.retryable !== true || transientFailures >= 4) throw error;
          transientFailures += 1;
          await delay(Math.min(this.pollIntervalMs * (2 ** transientFailures), 30_000), signal);
          continue;
        }
        const providerStatus = response?.task?.status;
        if (providerStatus === "queued" || providerStatus === "running") {
          job.status = providerStatus;
          job.updatedAt = nowIso();
          await writeJob(workspace, job);
          await delay(this.pollIntervalMs, signal);
          continue;
        }
        if (providerStatus === "succeeded") {
          const output = await retrySameTask(
            () => this.readContent(
              this.config,
              `/api/tools/ecommerce/videos/tasks/${encodeURIComponent(job.providerTaskId)}/content`,
              signal
            ),
            signal,
            this.pollIntervalMs
          );
          if (output.mimeType !== "video/mp4" || !looksLikeMp4(output.bytes)) {
            throw failure("ecommerce_video_invalid_gateway_output", "Gateway 返回的结果不是有效 MP4。", true);
          }
          const relativePath = `outputs/ecommerce-videos/jobs/${job.jobId}/result.mp4`;
          const absolutePath = path.join(workspace, ...relativePath.split("/"));
          await atomicWriteBuffer(absolutePath, output.bytes);
          const stored = await fs.readFile(absolutePath);
          if (!looksLikeMp4(stored) || sha256(stored) !== sha256(output.bytes)) {
            throw failure("ecommerce_video_output_verification_failed", "视频落盘校验失败。", true);
          }
          job.status = "completed";
          job.path = relativePath;
          job.mimeType = "video/mp4";
          job.bytes = stored.length;
          job.contentHash = sha256(stored);
          job.updatedAt = nowIso();
          job.completedAt = job.updatedAt;
          delete job.error;
          await writeJob(workspace, job);
          return job;
        }
        if (["failed", "cancelled", "expired"].includes(providerStatus)) {
          job.status = "failed";
          job.error = normalizeFailure(failure(
            response?.task?.errorCode ?? `ecommerce_video_provider_${providerStatus}`,
            `Seedance 任务以 ${providerStatus} 结束。`,
            providerStatus === "expired"
          ));
          job.updatedAt = nowIso();
          job.completedAt = job.updatedAt;
          await writeJob(workspace, job);
          return job;
        }
        throw failure("ecommerce_video_invalid_gateway_response", "Gateway 返回未知视频任务状态。", true);
      }
      throw failure("ecommerce_video_task_timeout", "视频任务超过 35 分钟仍未完成。", true);
    } catch (error) {
      if (signal.aborted) {
        job.status = "interrupted";
        job.error = failure("ecommerce_video_interrupted", "本地进程已停止；下次初始化将继续查询该任务。", true);
        job.updatedAt = nowIso();
        await writeJob(workspace, job);
        return job;
      }
      job.status = "failed";
      job.error = normalizeFailure(error);
      job.updatedAt = nowIso();
      job.completedAt = job.updatedAt;
      await writeJob(workspace, job);
      return job;
    }
  }

  #assertActive() {
    if (this.disposed) throw failure("ecommerce_video_runtime_disposed", "商品视频运行时已释放。", false);
  }
}

async function normalizeGenerateInput(value, workspace) {
  assertRecord(value, "ecommerce_video_generate 参数必须是对象。");
  assertAllowedKeys(value, ["modelId", "imagePath", "prompt", "aspectRatio", "duration", "resolution", "generateAudio"]);
  const modelId = readString(value.modelId) ?? MODEL_ID;
  if (modelId !== MODEL_ID) throw failure("ecommerce_video_invalid_model", "首版只支持 doubao-seedance-2-0。", false);
  const imagePath = readString(value.imagePath);
  if (!imagePath || path.isAbsolute(imagePath)) throw failure("ecommerce_video_invalid_image_path", "imagePath 必须是 workspace 内相对路径。", false);
  const prompt = readString(value.prompt);
  if (!prompt || prompt.length > MAX_PROMPT_CHARS) throw failure("ecommerce_video_invalid_prompt", `prompt 必须是 1 到 ${MAX_PROMPT_CHARS} 个字符。`, false);
  const aspectRatio = readString(value.aspectRatio) ?? "adaptive";
  if (!ALLOWED_RATIOS.has(aspectRatio)) throw failure("ecommerce_video_invalid_aspect_ratio", "aspectRatio 不受支持。", false);
  const duration = value.duration === undefined ? 6 : Number(value.duration);
  if (!Number.isInteger(duration) || duration < 4 || duration > 15) throw failure("ecommerce_video_invalid_duration", "duration 必须是 4 到 15 的整数。", false);
  const resolution = readString(value.resolution) ?? "1080p";
  if (!ALLOWED_RESOLUTIONS.has(resolution)) throw failure("ecommerce_video_invalid_resolution", "resolution 必须是 720p 或 1080p。", false);
  if (value.generateAudio !== undefined && typeof value.generateAudio !== "boolean") throw failure("ecommerce_video_invalid_audio", "generateAudio 必须是 boolean。", false);

  const absoluteImagePath = path.resolve(workspace, imagePath);
  const realWorkspace = await fs.realpath(workspace);
  const realImage = await fs.realpath(absoluteImagePath).catch(() => undefined);
  if (!realImage || !isInside(realWorkspace, realImage)) throw failure("ecommerce_video_workspace_escape", "商品图片必须位于当前 workspace 内。", false);
  const stat = await fs.stat(realImage);
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_IMAGE_BYTES) throw failure("ecommerce_video_invalid_image_size", "商品图片必须是 20MB 以内的非空文件。", false);
  const bytes = await fs.readFile(realImage);
  const mimeType = detectImageMime(bytes, path.extname(realImage));
  return {
    modelId,
    prompt,
    sourceImagePath: toWorkspacePath(workspace, realImage),
    absoluteImagePath: realImage,
    image: { bytes, mimeType },
    aspectRatio,
    duration,
    resolution,
    generateAudio: value.generateAudio === true
  };
}

function normalizeListInput(value) {
  assertRecord(value, "ecommerce_video_list 参数必须是对象。");
  assertAllowedKeys(value, ["jobId", "status", "limit"]);
  const jobId = readString(value.jobId);
  if (jobId && !/^video-job-[a-f0-9-]{16,}$/.test(jobId)) throw failure("ecommerce_video_invalid_job_id", "jobId 无效。", false);
  const status = readString(value.status);
  if (status && !["submitting", "queued", "running", "interrupted", "completed", "failed"].includes(status)) {
    throw failure("ecommerce_video_invalid_status", "status 无效。", false);
  }
  const limit = value.limit === undefined ? 50 : Number(value.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw failure("ecommerce_video_invalid_limit", "limit 必须是 1 到 200 的整数。", false);
  return { jobId, status, limit };
}

function jobResult(job) {
  const artifacts = createArtifacts(job);
  const details = {
    job: publicJob(job),
    deliveryReady: job.status === "completed" && artifacts.length === 1,
    artifacts
  };
  if (job.status === "completed") return completedResult(details, artifacts);
  if (job.status === "interrupted") return interruptedResult(job);
  return {
    status: "failed",
    content: JSON.stringify(details, null, 2),
    details,
    artifacts,
    error: job.error ?? failure("ecommerce_video_failed", "视频任务失败。", false)
  };
}

function interruptedResult(job) {
  const details = { job: publicJob(job), deliveryReady: false, artifacts: [] };
  return {
    status: "interrupted",
    content: JSON.stringify(details, null, 2),
    details,
    artifacts: [],
    error: failure("ecommerce_video_wait_interrupted", "本次等待已中断；任务状态仍可通过 ecommerce_video_list 查询。", true)
  };
}

function completedResult(details, artifacts = []) {
  return { status: "completed", content: JSON.stringify(details, null, 2), details, artifacts };
}

function createArtifacts(job) {
  if (job.status !== "completed" || !job.path) return [];
  return [{
    schemaVersion: "agent-output.v1",
    kind: "video",
    renderer: "ecommerce-video",
    id: `ecommerce-video-${job.jobId}`,
    title: `商品视频 ${job.jobId}`,
    files: [{
      path: job.path,
      mimeType: job.mimeType,
      bytes: job.bytes
    }],
    data: {
      schemaVersion: "agent-ecommerce-video.v1",
      jobId: job.jobId,
      modelId: job.modelId,
      path: job.path,
      mimeType: job.mimeType,
      bytes: job.bytes,
      contentHash: job.contentHash,
      aspectRatio: job.aspectRatio,
      duration: job.duration,
      resolution: job.resolution,
      generateAudio: job.generateAudio
    }
  }];
}

function publicJob(job) {
  return compactObject({
    jobId: job.jobId,
    modelId: job.modelId,
    status: job.status,
    sourceImagePath: job.sourceImagePath,
    aspectRatio: job.aspectRatio,
    duration: job.duration,
    resolution: job.resolution,
    generateAudio: job.generateAudio,
    providerTaskId: job.providerTaskId,
    path: job.path,
    mimeType: job.mimeType,
    bytes: job.bytes,
    contentHash: job.contentHash,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt
  });
}

async function listJobs(workspace) {
  const root = workspacePaths(workspace).jobs;
  const entries = await fs.readdir(root, { withFileTypes: true }).catch((error) => error?.code === "ENOENT" ? [] : Promise.reject(error));
  const jobs = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("video-job-")) continue;
    const job = await readJob(workspace, entry.name).catch(() => undefined);
    if (job?.schemaVersion === SCHEMA_VERSION) jobs.push(job);
  }
  return jobs.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

async function readJob(workspace, jobId) {
  try {
    const job = JSON.parse(await fs.readFile(jobManifestPath(workspace, jobId), "utf8"));
    if (job?.schemaVersion !== SCHEMA_VERSION || job.jobId !== jobId) throw new Error("invalid manifest");
    return job;
  } catch (error) {
    if (error?.code === "ENOENT") throw failure("ecommerce_video_job_not_found", "视频任务不存在。", false);
    throw failure("ecommerce_video_manifest_invalid", `视频任务记录损坏：${formatError(error)}`, false);
  }
}

async function writeJob(workspace, job) {
  await atomicWriteJson(jobManifestPath(workspace, job.jobId), job);
}

function workspacePaths(workspace) {
  const root = path.join(workspace, "outputs", "ecommerce-videos");
  return { root, jobs: path.join(root, "jobs") };
}

function jobManifestPath(workspace, jobId) {
  return path.join(workspacePaths(workspace).jobs, jobId, "manifest.json");
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

function resolveWorkspace(call) {
  const workspace = call?.workspace?.root;
  if (typeof workspace !== "string" || !workspace.trim() || !path.isAbsolute(workspace)) {
    throw failure("ecommerce_video_workspace_required", "商品视频工具需要绝对 workspace 路径。", false);
  }
  return path.resolve(workspace);
}

function detectImageMime(bytes, extension) {
  let actual;
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) actual = "image/png";
  else if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) actual = "image/jpeg";
  else if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") actual = "image/webp";
  const expected = IMAGE_TYPES.get(extension.toLowerCase());
  if (!actual || actual !== expected) throw failure("ecommerce_video_invalid_image_type", "商品图片扩展名与内容必须一致，并且只能是 PNG、JPEG 或 WebP。", false);
  return actual;
}

function looksLikeMp4(bytes) {
  return Buffer.isBuffer(bytes) && bytes.length >= 12 && bytes.toString("ascii", 4, 8) === "ftyp";
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function toWorkspacePath(workspace, absolutePath) {
  return path.relative(workspace, absolutePath).replaceAll(path.sep, "/");
}

function normalizeTraceContext(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result = {};
  for (const key of ["traceId", "threadId", "turnId", "requestId", "toolCallId", "deviceId"]) {
    const entry = readString(value[key]);
    if (entry) result[key] = entry.slice(0, 256);
  }
  return result;
}

function failure(code, message, retryable) {
  const error = new Error(message);
  error.code = code;
  error.retryable = retryable === true;
  return error;
}

function normalizeFailure(error) {
  return {
    code: typeof error?.code === "string" ? error.code : "ecommerce_video_failed",
    message: error instanceof Error ? error.message : String(error),
    retryable: error?.retryable === true
  };
}

function assertRecord(value, message) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw failure("ecommerce_video_invalid_arguments", message, false);
}

function assertAllowedKeys(value, allowed) {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length) throw failure("ecommerce_video_unknown_field", `不支持字段：${extras.join(", ")}。`, false);
}

function readString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hashRequest(input) {
  return sha256(Buffer.from(JSON.stringify({
    modelId: input.modelId,
    sourceImagePath: input.sourceImagePath,
    sourceImageHash: sha256(input.image.bytes),
    prompt: input.prompt,
    aspectRatio: input.aspectRatio,
    duration: input.duration,
    resolution: input.resolution,
    generateAudio: input.generateAudio
  })));
}

function createId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function nowIso() {
  return new Date().toISOString();
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? new Error("任务已取消。"));
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

function waitForPromise(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("任务已取消。"));
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function retrySameTask(operation, signal, baseDelayMs) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (error?.retryable !== true || attempt === 2) throw error;
      await delay(Math.min(baseDelayMs * (2 ** (attempt + 1)), 30_000), signal);
    }
  }
  throw lastError;
}
