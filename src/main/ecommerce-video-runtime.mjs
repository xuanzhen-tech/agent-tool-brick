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
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const RECOVERABLE_STATUSES = new Set(["queued", "running", "interrupted"]);
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_PROMPT_CHARS = 20_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_TASK_TIMEOUT_MS = 65 * 60_000;
const DEFAULT_MAX_CONCURRENT_JOBS = 2;
const DEFAULT_MAX_CONCURRENT_JOBS_PER_WORKSPACE = 1;
const MAX_STATUS_WAIT_MS = 30_000;
const JOB_WRITE_QUEUES = new Map();

export function createEcommerceVideoRuntime(config, options = {}) {
  return new EcommerceVideoRuntime(config, options);
}

export class EcommerceVideoRuntime {
  constructor(config, options = {}) {
    this.config = config;
    this.submitTask = options.submitTask ?? postServerToolGatewayMultipart;
    this.readTask = options.readTask ?? requestServerToolGatewayJson;
    this.readContent = options.readContent ?? requestServerToolGatewayBinary;
    this.cancelTask = options.cancelTask ?? requestServerToolGatewayJson;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.taskTimeoutMs = options.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
    this.maxConcurrentJobs = options.maxConcurrentJobs ?? DEFAULT_MAX_CONCURRENT_JOBS;
    this.maxConcurrentJobsPerWorkspace = options.maxConcurrentJobsPerWorkspace ?? DEFAULT_MAX_CONCURRENT_JOBS_PER_WORKSPACE;
    this.workspaceInitializers = new Map();
    this.workers = new Map();
    this.controllers = new Map();
    this.activeJobs = 0;
    this.activeJobsByWorkspace = new Map();
    this.permitWaiters = [];
    this.disposed = false;
  }

  async generate(call) {
    this.#assertActive();
    const workspace = resolveWorkspace(call);
    await this.#initializeWorkspace(workspace);
    const input = await normalizeGenerateInput(call.arguments ?? {}, workspace);
    const requestHash = hashRequest(input);
    const existing = await this.#findIdempotentJob(workspace, call.toolCallId, requestHash);
    const job = existing ?? await this.#createJob(call, workspace, input);
    if (!TERMINAL_STATUSES.has(job.status)) this.#ensureWorker(workspace, job.jobId);
    return queryResult(job, { accepted: !existing });
  }

  async status(call) {
    this.#assertActive();
    const workspace = resolveWorkspace(call);
    await this.#initializeWorkspace(workspace);
    const input = normalizeStatusInput(call.arguments ?? {});
    let job = await readJob(workspace, input.jobId);
    const baseline = job.updatedAt;
    if (input.waitMs > 0 && !TERMINAL_STATUSES.has(job.status)) {
      job = await waitForJobUpdate(workspace, job.jobId, baseline, input.waitMs, call.signal, this.pollIntervalMs);
    }
    return queryResult(job);
  }

  async cancel(call) {
    this.#assertActive();
    const workspace = resolveWorkspace(call);
    await this.#initializeWorkspace(workspace);
    const input = normalizeJobActionInput(call.arguments ?? {}, "cancel");
    let job = await readJob(workspace, input.jobId);
    if (TERMINAL_STATUSES.has(job.status)) return queryResult(job);

    job.status = "cancelled";
    job.error = normalizeFailure(failure("ecommerce_video_cancelled", "视频任务已取消。", false));
    job.updatedAt = nowIso();
    job.completedAt = job.updatedAt;
    await writeJob(workspace, job);
    this.#abortWorker(workspace, job.jobId, new Error("Video job cancelled."));

    if (job.providerTaskId) {
      try {
        await this.cancelTask(
          this.config,
          `/api/tools/ecommerce/videos/tasks/${encodeURIComponent(job.providerTaskId)}/cancel`,
          { method: "POST" },
          call.signal
        );
      } catch (error) {
        job = await readJob(workspace, job.jobId);
        job.error = normalizeFailure(failure(
          "ecommerce_video_cancel_uncertain",
          `本地已停止等待，但 Provider 取消结果不确定：${formatError(error)}`,
          true
        ));
        job.updatedAt = nowIso();
        await writeJob(workspace, job);
      }
    }
    return queryResult(await readJob(workspace, job.jobId));
  }

  async retry(call) {
    this.#assertActive();
    const workspace = resolveWorkspace(call);
    await this.#initializeWorkspace(workspace);
    const input = normalizeJobActionInput(call.arguments ?? {}, "retry");
    if (input.confirm !== true) throw failure("ecommerce_video_retry_confirmation_required", "重试会创建新的计费任务，必须传 confirm=true。", false);
    const previous = await readJob(workspace, input.jobId);
    if (previous.status === "interrupted" && previous.providerTaskId) {
      previous.status = "queued";
      delete previous.error;
      delete previous.completedAt;
      previous.updatedAt = nowIso();
      await writeJob(workspace, previous);
      this.#ensureWorker(workspace, previous.jobId);
      return queryResult(previous, { resumed: true });
    }
    if (!["failed", "cancelled", "interrupted"].includes(previous.status)) {
      throw failure("ecommerce_video_retry_not_allowed", "只有 failed、cancelled 或 interrupted 任务可以重试。", false);
    }
    const job = await this.#cloneJobForRetry(call, workspace, previous);
    this.#ensureWorker(workspace, job.jobId);
    return queryResult(job, { accepted: true, retriedFromJobId: previous.jobId });
  }

  async list(call) {
    this.#assertActive();
    const workspace = resolveWorkspace(call);
    await this.#initializeWorkspace(workspace);
    const input = normalizeListInput(call.arguments ?? {});
    if (input.jobId) {
      const job = await readJob(workspace, input.jobId);
      return queryResult(job);
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
    for (const waiter of this.permitWaiters.splice(0)) waiter.reject(new Error("AgentTool is disposing."));
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
      if (RECOVERABLE_STATUSES.has(job.status) && (job.providerTaskId || job.submissionState === "not_submitted")) {
        this.#ensureWorker(workspace, job.jobId);
      }
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

  async #createJob(call, workspace, input, extra = {}) {
    const jobId = createId("video-job");
    const sourceExtension = input.image.mimeType === "image/png" ? ".png" : input.image.mimeType === "image/webp" ? ".webp" : ".jpg";
    const sourceCopyPath = `outputs/ecommerce-videos/jobs/${jobId}/source${sourceExtension}`;
    const job = {
      schemaVersion: SCHEMA_VERSION,
      jobId,
      modelId: MODEL_ID,
      status: "queued",
      submissionState: "not_submitted",
      prompt: input.prompt,
      sourceImagePath: input.sourceImagePath,
      sourceCopyPath,
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
      ...extra,
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    await atomicWriteBuffer(path.join(workspace, ...sourceCopyPath.split("/")), input.image.bytes);
    await writeJob(workspace, job);
    return job;
  }

  async #cloneJobForRetry(call, workspace, previous) {
    const sourceRelativePath = previous.sourceCopyPath ?? previous.sourceImagePath;
    const sourcePath = path.join(workspace, ...sourceRelativePath.split("/"));
    const bytes = await fs.readFile(sourcePath).catch(() => undefined);
    if (!bytes || sha256(bytes) !== previous.sourceImageHash) {
      throw failure("ecommerce_video_retry_source_missing", "原任务的输入图片副本缺失或已损坏，不能安全重试。", false);
    }
    return await this.#createJob(call, workspace, {
      modelId: previous.modelId,
      prompt: previous.prompt,
      sourceImagePath: previous.sourceImagePath,
      absoluteImagePath: sourcePath,
      image: { bytes, mimeType: previous.sourceImageMimeType },
      aspectRatio: previous.aspectRatio,
      duration: previous.duration,
      resolution: previous.resolution,
      generateAudio: previous.generateAudio
    }, { parentJobId: previous.jobId });
  }

  async #submitJob(workspace, job, signal) {
    const sourcePath = path.join(workspace, ...job.sourceCopyPath.split("/"));
    const imageBytes = await fs.readFile(sourcePath);
    if (sha256(imageBytes) !== job.sourceImageHash) {
      throw failure("ecommerce_video_source_copy_invalid", "任务输入图片副本校验失败。", false);
    }
    job.status = "submitting";
    job.submissionState = "submitting";
    job.updatedAt = nowIso();
    await writeJob(workspace, job);
    try {
      const response = await this.submitTask(this.config, "/api/tools/ecommerce/videos/generate", {
        request: {
          prompt: job.prompt,
          aspectRatio: job.aspectRatio,
          duration: job.duration,
          resolution: job.resolution,
          generateAudio: job.generateAudio
        },
        images: [{ bytes: imageBytes, mimeType: job.sourceImageMimeType, filename: path.basename(sourcePath) }],
        trace: compactObject({
          ...job.traceContext,
          operationId: job.jobId,
          itemId: job.jobId,
          operation: "ecommerce_video_generate"
        })
      }, signal);
      const task = response?.task;
      if (!task || typeof task.id !== "string" || task.status !== "queued") {
        throw failure("ecommerce_video_invalid_gateway_response", "Gateway 未返回有效 Seedance 任务。", true);
      }
      job.providerTaskId = task.id;
      job.gatewayTraceId = typeof task.traceId === "string" ? task.traceId : undefined;
      job.status = "queued";
      job.submissionState = "submitted";
      job.updatedAt = nowIso();
      await writeJob(workspace, job);
      return job;
    } catch (error) {
      const current = await readJob(workspace, job.jobId).catch(() => undefined);
      if (current?.status === "cancelled") return current;
      job.status = "failed";
      if (isDefinitiveSubmissionRejection(error)) {
        job.submissionState = "rejected";
        job.error = normalizeFailure(error);
      } else {
        job.submissionState = "unknown";
        job.error = normalizeFailure(failure(
          "ecommerce_video_submission_uncertain",
          `视频任务提交未确认，为避免重复计费不会自动重提：${formatError(error)}`,
          false
        ));
      }
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
    let releasePermit;
    let job = await readJob(workspace, jobId);
    if (TERMINAL_STATUSES.has(job.status)) return job;
    let transientFailures = 0;
    try {
      releasePermit = await this.#acquirePermit(workspace, signal);
      job = await readJob(workspace, jobId);
      if (TERMINAL_STATUSES.has(job.status)) return job;
      if (!job.providerTaskId) {
        if (job.submissionState !== "not_submitted") return job;
        job = await this.#submitJob(workspace, job, signal);
        if (!job.providerTaskId || job.status === "failed") return job;
      }
      const deadline = Date.now() + this.taskTimeoutMs;
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
        const providerTask = response?.task;
        const providerStatus = providerTask?.status;
        applyProviderMetadata(job, providerTask);
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
      job.status = "interrupted";
      job.error = normalizeFailure(failure("ecommerce_video_task_wait_timeout", "本地等待超过 65 分钟；Provider 任务未被判定失败，可稍后继续查询。", true));
      job.updatedAt = nowIso();
      await writeJob(workspace, job);
      return job;
    } catch (error) {
      if (signal.aborted) {
        const current = await readJob(workspace, jobId).catch(() => job);
        if (current.status === "cancelled") return current;
        job = current;
        job.status = "interrupted";
        job.error = normalizeFailure(failure("ecommerce_video_interrupted", "本地进程已停止；下次初始化将继续查询同一个 Provider 任务。", true));
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
    } finally {
      releasePermit?.();
    }
  }

  #abortWorker(workspace, jobId, reason) {
    this.controllers.get(`${workspace}\n${jobId}`)?.abort(reason);
  }

  #acquirePermit(workspace, signal) {
    if (this.#hasPermit(workspace)) {
      this.#takePermit(workspace);
      return Promise.resolve(() => this.#releasePermit(workspace));
    }
    return new Promise((resolve, reject) => {
      const waiter = { workspace, resolve, reject, signal };
      const abort = () => {
        this.permitWaiters = this.permitWaiters.filter((entry) => entry !== waiter);
        reject(signal.reason ?? new Error("Video permit wait aborted."));
      };
      waiter.abort = abort;
      if (signal.aborted) abort();
      else {
        signal.addEventListener("abort", abort, { once: true });
        this.permitWaiters.push(waiter);
      }
    });
  }

  #hasPermit(workspace) {
    return this.activeJobs < this.maxConcurrentJobs
      && (this.activeJobsByWorkspace.get(workspace) ?? 0) < this.maxConcurrentJobsPerWorkspace;
  }

  #takePermit(workspace) {
    this.activeJobs += 1;
    this.activeJobsByWorkspace.set(workspace, (this.activeJobsByWorkspace.get(workspace) ?? 0) + 1);
  }

  #releasePermit(workspace) {
    this.activeJobs = Math.max(0, this.activeJobs - 1);
    const remaining = Math.max(0, (this.activeJobsByWorkspace.get(workspace) ?? 1) - 1);
    if (remaining) this.activeJobsByWorkspace.set(workspace, remaining);
    else this.activeJobsByWorkspace.delete(workspace);
    this.#drainPermitWaiters();
  }

  #drainPermitWaiters() {
    for (const waiter of [...this.permitWaiters]) {
      if (!this.#hasPermit(waiter.workspace)) continue;
      this.permitWaiters = this.permitWaiters.filter((entry) => entry !== waiter);
      waiter.signal.removeEventListener("abort", waiter.abort);
      this.#takePermit(waiter.workspace);
      waiter.resolve(() => this.#releasePermit(waiter.workspace));
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
  if (status && !["submitting", "queued", "running", "interrupted", "completed", "failed", "cancelled"].includes(status)) {
    throw failure("ecommerce_video_invalid_status", "status 无效。", false);
  }
  const limit = value.limit === undefined ? 50 : Number(value.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw failure("ecommerce_video_invalid_limit", "limit 必须是 1 到 200 的整数。", false);
  return { jobId, status, limit };
}

function normalizeStatusInput(value) {
  assertRecord(value, "ecommerce_video_status 参数必须是对象。");
  assertAllowedKeys(value, ["jobId", "waitMs"]);
  const jobId = requireJobId(value.jobId);
  const waitMs = value.waitMs === undefined ? 0 : Number(value.waitMs);
  if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > MAX_STATUS_WAIT_MS) {
    throw failure("ecommerce_video_invalid_wait", `waitMs 必须是 0 到 ${MAX_STATUS_WAIT_MS} 的整数。`, false);
  }
  return { jobId, waitMs };
}

function normalizeJobActionInput(value, action) {
  assertRecord(value, `ecommerce_video_${action} 参数必须是对象。`);
  const allowed = action === "retry" ? ["jobId", "confirm"] : ["jobId"];
  assertAllowedKeys(value, allowed);
  if (action === "retry" && value.confirm !== undefined && typeof value.confirm !== "boolean") {
    throw failure("ecommerce_video_invalid_confirmation", "confirm 必须是 boolean。", false);
  }
  return { jobId: requireJobId(value.jobId), confirm: value.confirm };
}

function requireJobId(value) {
  const jobId = readString(value);
  if (!jobId || !/^video-job-[a-f0-9-]{16,}$/.test(jobId)) {
    throw failure("ecommerce_video_invalid_job_id", "jobId 无效。", false);
  }
  return jobId;
}

function queryResult(job, extra = {}) {
  const artifacts = createArtifacts(job);
  const details = {
    job: publicJob(job),
    deliveryReady: job.status === "completed" && artifacts.length === 1,
    artifacts,
    ...extra
  };
  return completedResult(details, artifacts);
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
      generateAudio: job.generateAudio,
      actual: compactObject({
        duration: job.actualDuration,
        resolution: job.actualResolution,
        aspectRatio: job.actualAspectRatio,
        framesPerSecond: job.framesPerSecond,
        usage: job.usage
      })
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
    actualDuration: job.actualDuration,
    actualResolution: job.actualResolution,
    actualAspectRatio: job.actualAspectRatio,
    framesPerSecond: job.framesPerSecond,
    usage: job.usage,
    parentJobId: job.parentJobId,
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
  const filePath = jobManifestPath(workspace, job.jobId);
  const previous = JOB_WRITE_QUEUES.get(filePath) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(async () => {
    const existing = await fs.readFile(filePath, "utf8")
      .then((value) => JSON.parse(value))
      .catch((error) => {
        if (error?.code === "ENOENT") return undefined;
        throw error;
      });
    if (TERMINAL_STATUSES.has(existing?.status) && existing.status !== job.status) {
      return existing;
    }
    await atomicWriteJson(filePath, job);
    return job;
  });
  JOB_WRITE_QUEUES.set(filePath, current);
  try {
    return await current;
  } finally {
    if (JOB_WRITE_QUEUES.get(filePath) === current) JOB_WRITE_QUEUES.delete(filePath);
  }
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

function isDefinitiveSubmissionRejection(error) {
  if (error?.code === "server_tool_gateway_unavailable") return true;
  const statusCode = Number(error?.statusCode);
  return Number.isInteger(statusCode)
    && statusCode >= 400
    && statusCode < 500
    && ![408, 425, 499].includes(statusCode);
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

function applyProviderMetadata(job, task) {
  if (!task || typeof task !== "object" || Array.isArray(task)) return;
  if (Number.isInteger(task.duration) && task.duration >= 0) job.actualDuration = task.duration;
  if (typeof task.resolution === "string" && task.resolution.trim()) job.actualResolution = task.resolution.trim();
  if (typeof task.aspectRatio === "string" && task.aspectRatio.trim()) job.actualAspectRatio = task.aspectRatio.trim();
  if (Number.isInteger(task.framesPerSecond) && task.framesPerSecond > 0) job.framesPerSecond = task.framesPerSecond;
  if (task.usage && typeof task.usage === "object" && !Array.isArray(task.usage)) {
    const completionTokens = Number.isInteger(task.usage.completionTokens) ? task.usage.completionTokens : undefined;
    const totalTokens = Number.isInteger(task.usage.totalTokens) ? task.usage.totalTokens : undefined;
    const amountUsd = Number.isFinite(task.usage.amountUsd) && task.usage.amountUsd >= 0 ? task.usage.amountUsd : undefined;
    if (completionTokens !== undefined || totalTokens !== undefined || amountUsd !== undefined) {
      job.usage = compactObject({ completionTokens, totalTokens, amountUsd });
    }
  }
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

async function waitForJobUpdate(workspace, jobId, baseline, waitMs, signal, pollIntervalMs) {
  const deadline = Date.now() + waitMs;
  let job = await readJob(workspace, jobId);
  while (Date.now() < deadline && !TERMINAL_STATUSES.has(job.status) && job.updatedAt === baseline) {
    await delay(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())), signal);
    job = await readJob(workspace, jobId);
  }
  return job;
}
