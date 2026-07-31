import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { AgentTool } from "../index.mjs";
import { createEcommerceImageRuntime } from "../main/ecommerce-image-runtime.mjs";

const MODEL_TOOL_NAMES = [
  "ecommerce_image_generate",
  "ecommerce_image_edit",
  "ecommerce_image_list"
];
const COMPATIBILITY_TOOL_NAMES = [
  "ecommerce_image_job_status",
  "ecommerce_image_job_cancel",
  "ecommerce_image_job_retry",
  "ecommerce_image_batch"
];
const SELECTED_TOOL_NAMES = [...MODEL_TOOL_NAMES, ...COMPATIBILITY_TOOL_NAMES];
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "agent-tool-ecommerce-"));
const outsideDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-tool-ecommerce-outside-"));
const outsideImage = path.join(outsideDirectory, "outside.png");
const originalFetch = globalThis.fetch;
const originalGateway = process.env.AGENT_TOOL_GATEWAY_BASE_URL;
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
let activeRequests = 0;
let maxActiveRequests = 0;
let transientFailures = 0;
let networkFailures = 0;
let partialFailures = 0;
let rejectEnabled = true;
const providerRequests = [];

process.env.AGENT_TOOL_GATEWAY_BASE_URL = "http://gateway.test";
globalThis.fetch = async (url, init) => {
  activeRequests += 1;
  maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
  try {
    const form = init?.body;
    assert.ok(form instanceof FormData);
    const request = JSON.parse(String(form.get("request")));
    await delay(request.prompt.includes("SLOW") ? 2_000 : 30, init?.signal);
    providerRequests.push({
      url: String(url),
      request,
      images: form.getAll("image").length
    });
    if (request.prompt.includes("TRANSIENT") && transientFailures < 2) {
      transientFailures += 1;
      return jsonResponse({
        ok: false,
        error: { code: "ecommerce_image_rate_limited", message: "busy", retryable: true }
      }, 429);
    }
    if (request.prompt.includes("REJECT") && rejectEnabled) {
      return jsonResponse({
        ok: false,
        error: { code: "ecommerce_image_moderation_blocked", message: "blocked", retryable: false }
      }, 400);
    }
    if (request.prompt.includes("NETWORK_UNKNOWN")) {
      networkFailures += 1;
      throw new TypeError("socket closed after request upload");
    }
    if (request.prompt.includes("PARTIAL") && partialFailures < 1) {
      partialFailures += 1;
      return jsonResponse({
        ok: false,
        error: { code: "ecommerce_image_moderation_blocked", message: "partial blocked", retryable: false }
      }, 400);
    }
    if (request.prompt.includes("INVALID_OUTPUT")) {
      return jsonResponse({
        ok: true,
        modelId: "gpt-image-2",
        imageBase64: png.toString("base64"),
        mimeType: "image/jpeg",
        providerRequestId: "provider-invalid-output"
      });
    }
    return jsonResponse({
      ok: true,
      modelId: "gpt-image-2",
      imageBase64: png.toString("base64"),
      mimeType: "image/png",
      providerRequestId: `provider-${providerRequests.length}`
    });
  } finally {
    activeRequests -= 1;
  }
};

let hiddenTool;
let newOnlyTool;
let tool;
let toolServer;
try {
  await fs.mkdir(path.join(workspace, "uploads"), { recursive: true });
  await fs.writeFile(path.join(workspace, "uploads", "product.png"), png);
  await fs.writeFile(outsideImage, png);

  hiddenTool = new AgentTool({ workspace });
  const hiddenNames = hiddenTool.definitions.map((definition) => definition.function.name);
  assert.equal(hiddenNames.some((name) => SELECTED_TOOL_NAMES.includes(name)), false);
  await hiddenTool.dispose();
  hiddenTool = undefined;

  newOnlyTool = new AgentTool({ workspace, tools: MODEL_TOOL_NAMES });
  assert.deepEqual(
    newOnlyTool.definitions.map((definition) => definition.function.name).sort(),
    [...MODEL_TOOL_NAMES].sort()
  );
  await newOnlyTool.dispose();
  newOnlyTool = undefined;

  tool = new AgentTool({ workspace, tools: SELECTED_TOOL_NAMES });
  assert.deepEqual(
    tool.definitions.map((definition) => definition.function.name).sort(),
    [...MODEL_TOOL_NAMES].sort()
  );
  const schemas = new Map(tool.definitions.map((definition) => [definition.function.name, definition.function]));
  assert.match(schemas.get("ecommerce_image_generate").description, /deliveryReady=true/);
  assert.match(schemas.get("ecommerce_image_generate").description, /不需要调用状态、取消或重试工具/);
  assert.equal(schemas.has("ecommerce_image_job_status"), false);
  assert.equal(schemas.has("ecommerce_image_job_cancel"), false);
  assert.equal(schemas.has("ecommerce_image_job_retry"), false);
  assert.equal(schemas.has("ecommerce_image_batch"), false);

  const generated = await tool.execute("ecommerce_image_generate", {
    prompt: "生成白底商品主图",
    size: { width: 1024, height: 1024 },
    quality: "high",
    count: 4,
    referenceImages: [{
      path: "uploads/product.png",
      role: "product",
      preserve: "strict"
    }]
  }, { workspace });
  assert.equal(generated.status, "completed");
  assert.equal(generated.details.status, "completed");
  assert.equal(generated.details.operationStatus, "completed");
  assert.equal(generated.details.completed, true);
  assert.equal(generated.details.allSucceeded, true);
  assert.equal(generated.details.deliveryReady, true);
  assert.equal(generated.details.terminal, true);
  assert.equal(Object.hasOwn(generated.details, "nextAction"), false);
  assert.equal(generated.details.operationId, generated.details.batchId);
  assert.equal(Object.hasOwn(generated.details, "jobCount"), false);
  const completed = generated;
  assert.equal(completed.details.status, "completed");
  assert.equal(completed.details.count, 4);
  assert.equal(completed.details.progress.completed, 4);
  assert.deepEqual(completed.details.items.map((item) => item.outputIndex), [1, 2, 3, 4]);
  assert.equal(completed.artifacts.length, 4);
  assert.equal(new Set(completed.details.items.map((item) => item.assetId)).size, 4);
  assert.equal(maxActiveRequests, 2);
  const generatedManifest = JSON.parse(await fs.readFile(path.join(
    workspace,
    "outputs",
    "ecommerce-images",
    "batches",
    generated.details.batchId,
    "manifest.json"
  ), "utf8"));
  assert.equal(generatedManifest.count, 4);
  assert.deepEqual(generatedManifest.items.map((item) => item.outputIndex), [1, 2, 3, 4]);
  assert.equal(generatedManifest.items.some((item) => "jobIndex" in item || "copyIndex" in item), false);
  for (const artifact of completed.artifacts) {
    assert.equal(artifact.schemaVersion, "agent-output.v1");
    assert.equal(artifact.kind, "image");
    assert.equal(artifact.renderer, "ecommerce-image");
    assert.equal(artifact.data.versionId, "v1");
    assert.equal(artifact.data.versionScope, "asset");
    const artifactPath = path.join(workspace, ...artifact.files[0].path.split("/"));
    assert.equal(await pathExists(artifactPath), true);
    const artifactBytes = await fs.readFile(artifactPath);
    assert.equal(artifact.files[0].bytes, artifactBytes.byteLength);
    assert.equal(artifact.data.contentHash, sha256(artifactBytes));
  }
  assert.equal(providerRequests.filter((request) => request.images === 1).length, 4);
  assert.equal(
    providerRequests
      .filter((request) => request.images === 1)
      .every((request) => request.request.prompt.includes("图片 1: role=product; preserve=strict")),
    true
  );

  const requestsBeforeIdempotency = providerRequests.length;
  const idempotentInput = {
    prompt: "验证幂等提交",
    size: { width: 1024, height: 1024 }
  };
  const [idempotentFirst, idempotentReplay] = await Promise.all([
    tool.execute(
      "ecommerce_image_generate",
      idempotentInput,
      { workspace, toolCallId: "call-idempotent-generate" }
    ),
    tool.execute(
      "ecommerce_image_generate",
      idempotentInput,
      { workspace, toolCallId: "call-idempotent-generate" }
    )
  ]);
  assert.equal(idempotentReplay.details.operationId, idempotentFirst.details.operationId);
  assert.equal(providerRequests.length, requestsBeforeIdempotency + 1);
  await fs.rm(path.join(
    workspace,
    "outputs",
    "ecommerce-images",
    "idempotency",
    `${sha256("call-idempotent-generate")}.json`
  ));
  const recoveredIdempotency = await tool.execute(
    "ecommerce_image_generate",
    idempotentInput,
    { workspace, toolCallId: "call-idempotent-generate" }
  );
  assert.equal(recoveredIdempotency.details.operationId, idempotentFirst.details.operationId);
  assert.equal(providerRequests.length, requestsBeforeIdempotency + 1);
  const idempotencyConflict = await tool.execute(
    "ecommerce_image_generate",
    { ...idempotentInput, prompt: "同一调用 ID 的不同请求" },
    { workspace, toolCallId: "call-idempotent-generate" }
  );
  assert.equal(idempotencyConflict.status, "failed");
  assert.equal(idempotencyConflict.error.code, "ecommerce_image_idempotency_conflict");

  toolServer = await tool.createServer({
    config: { ...tool.config, host: "127.0.0.1", port: 0 }
  });
  const serverAddress = await toolServer.listen();
  const manifestResponse = await originalFetch(`${serverAddress.url}/api/tools/manifest`);
  const manifest = await manifestResponse.json();
  assert.deepEqual(manifest.tools.map((entry) => entry.name).sort(), [...SELECTED_TOOL_NAMES].sort());
  const httpStatusResponse = await originalFetch(`${serverAddress.url}/api/tools/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schemaVersion: "agent-cli-tool.call.v1",
      toolCallId: "call-http-shared-batch",
      toolName: "ecommerce_image_job_status",
      arguments: { operationId: generated.details.operationId, waitMs: 0 },
      workspace: { root: workspace }
    })
  });
  const httpStatus = await httpStatusResponse.json();
  assert.equal(httpStatus.details.batchId, generated.details.batchId);
  assert.equal(httpStatus.details.status, "completed");
  const legacyStatus = await tool.execute("ecommerce_image_batch", {
    batchId: generated.details.batchId
  }, { workspace });
  assert.equal(legacyStatus.details.status, "completed");
  await toolServer.close();
  toolServer = undefined;

  const first = completed.details.items[0];
  const edited = await tool.execute("ecommerce_image_edit", {
    edits: [{
      assetId: first.assetId,
      versionId: "v1",
      prompt: "只替换为浅灰棚拍背景，保持商品结构、颜色和 Logo 不变",
      size: { width: 1024, height: 1024 },
      quality: "high",
      additionalReferenceImages: [{
        path: "uploads/product.png",
        role: "style",
        preserve: "loose"
      }]
    }]
  }, { workspace });
  const editCompleted = edited;
  assert.equal(editCompleted.details.status, "completed");
  assert.equal(editCompleted.details.items[0].assetId, first.assetId);
  assert.equal(editCompleted.details.items[0].versionId, "v2");
  assert.equal(editCompleted.details.items[0].parentVersionId, "v1");
  assert.equal(providerRequests.at(-1).url.endsWith("/api/tools/ecommerce/images/edit"), true);
  assert.equal(providerRequests.at(-1).images, 2);
  assert.match(providerRequests.at(-1).request.prompt, /图片 1 是待编辑的目标版本/);
  assert.match(providerRequests.at(-1).request.prompt, /图片 2: role=style; preserve=loose/);

  const history = await tool.execute("ecommerce_image_list", { assetId: first.assetId }, { workspace });
  assert.equal(history.status, "completed");
  assert.deepEqual(history.details.assets[0].versions.map((version) => version.versionId), ["v1", "v2"]);
  assert.equal(history.details.assets[0].versions.every((version) => version.versionScope === "asset"), true);
  assert.equal(history.artifacts.length, 2);

  const concurrentEdits = await Promise.all([
    tool.execute("ecommerce_image_edit", {
      edits: [{
        assetId: first.assetId,
        versionId: "v1",
        prompt: "并发版本 A",
        size: { width: 1024, height: 1024 }
      }]
    }, { workspace }),
    tool.execute("ecommerce_image_edit", {
      edits: [{
        assetId: first.assetId,
        versionId: "v1",
        prompt: "并发版本 B",
        size: { width: 1024, height: 1024 }
      }]
    }, { workspace })
  ]);
  const concurrentCompleted = concurrentEdits;
  assert.deepEqual(
    concurrentCompleted.map((entry) => entry.details.items[0].versionId).sort(),
    ["v3", "v4"]
  );
  const concurrentHistory = await tool.execute("ecommerce_image_list", { assetId: first.assetId }, { workspace });
  assert.deepEqual(
    concurrentHistory.details.assets[0].versions.map((version) => version.versionId),
    ["v1", "v2", "v3", "v4"]
  );

  const duplicateEdit = await tool.execute("ecommerce_image_edit", {
    edits: [{
      assetId: first.assetId,
      versionId: "v1",
      prompt: "重复 A",
      size: { width: 1024, height: 1024 }
    }, {
      assetId: first.assetId,
      versionId: "v1",
      prompt: "重复 B",
      size: { width: 1024, height: 1024 }
    }]
  }, { workspace });
  assert.equal(duplicateEdit.status, "failed");
  assert.equal(duplicateEdit.error.code, "ecommerce_image_duplicate_asset_edit");

  const transient = await tool.execute("ecommerce_image_generate", {
    prompt: "TRANSIENT 后生成",
    size: { width: 1024, height: 1024 }
  }, { workspace });
  const transientCompleted = transient;
  assert.equal(transientCompleted.details.status, "completed");
  assert.equal(transientCompleted.details.items[0].attempts, 3);
  assert.equal(transientFailures, 2);

  const rejected = await tool.execute("ecommerce_image_generate", {
    prompt: "REJECT",
    size: { width: 1024, height: 1024 }
  }, { workspace });
  const rejectedCompleted = rejected;
  assert.equal(rejectedCompleted.status, "failed");
  assert.equal(rejectedCompleted.details.status, "failed");
  assert.equal(rejectedCompleted.details.items[0].attempts, 1);
  assert.equal(rejectedCompleted.details.items[0].error.code, "ecommerce_image_moderation_blocked");

  const networkUnknown = await tool.execute("ecommerce_image_generate", {
    prompt: "NETWORK_UNKNOWN",
    size: { width: 1024, height: 1024 }
  }, { workspace });
  const networkUnknownCompleted = networkUnknown;
  assert.equal(networkUnknownCompleted.status, "failed");
  assert.equal(networkUnknownCompleted.details.status, "failed");
  assert.equal(networkUnknownCompleted.details.items[0].attempts, 1);
  assert.equal(networkUnknownCompleted.details.items[0].error.retryable, false);
  assert.equal(networkFailures, 1);

  const partial = await tool.execute("ecommerce_image_generate", {
    prompt: "PARTIAL 生成两个候选",
    size: { width: 1024, height: 1024 },
    count: 2
  }, { workspace });
  assert.equal(partial.status, "failed");
  assert.equal(partial.details.operationStatus, "partial");
  assert.equal(partial.details.terminal, true);
  assert.equal(partial.details.completed, false);
  assert.equal(partial.details.allSucceeded, false);
  assert.equal(partial.details.deliveryReady, true);
  assert.equal(partial.artifacts.length, 1);
  assert.equal(Object.hasOwn(partial.details, "nextAction"), false);
  assert.match(partial.details.message, /未全部成功/);

  const invalidOutput = await tool.execute("ecommerce_image_generate", {
    prompt: "INVALID_OUTPUT",
    size: { width: 1024, height: 1024 }
  }, { workspace });
  assert.equal(invalidOutput.status, "failed");
  assert.equal(invalidOutput.details.deliveryReady, false);
  assert.equal(invalidOutput.artifacts.length, 0);
  assert.equal(invalidOutput.error.code, "ecommerce_image_invalid_gateway_response");

  const legacyRejected = await tool.execute("ecommerce_image_generate", {
    prompt: "REJECT legacy retry",
    size: { width: 1024, height: 1024 }
  }, { workspace });
  assert.equal(legacyRejected.status, "failed");

  rejectEnabled = false;
  const retried = await tool.execute("ecommerce_image_job_retry", {
    operationId: rejected.details.operationId
  }, { workspace });
  assert.notEqual(retried.details.batchId, rejected.details.batchId);
  const retryCompleted = retried;
  assert.equal(retryCompleted.details.status, "completed");
  assert.notEqual(retryCompleted.details.items[0].assetId, rejectedCompleted.details.items[0].assetId);

  const legacyRetried = await tool.execute("ecommerce_image_batch", {
    action: "retry",
    batchId: legacyRejected.details.batchId
  }, { workspace });
  assert.equal(legacyRetried.details.status, "queued");
  const legacyRetryCompleted = await tool.execute("ecommerce_image_job_status", {
    operationId: legacyRetried.details.operationId,
    waitMs: 1_000
  }, { workspace });
  assert.equal(legacyRetryCompleted.details.operationStatus, "completed");

  // 使用真实运行时和可中断异步函数验证：多图任务经历中间状态时，
  // generate 自身会持续阻塞到终态，不再把轮询责任交给模型。
  const longPollRuntime = createEcommerceImageRuntime(tool.config, {
    imageTimeoutMs: 500,
    batchSettleMs: 20,
    fetchImage: async (_config, _endpoint, _input, signal) => {
      await delay(150, signal);
      return {
        imageBase64: png.toString("base64"),
        mimeType: "image/png",
        providerRequestId: "provider-long-poll"
      };
    }
  });
  const longPollStartedAt = Date.now();
  const longPolled = await longPollRuntime.generate(runtimeCall({
    toolCallId: "call-long-poll-submit",
    workspace,
    arguments: {
      prompt: "验证真实长轮询",
      size: { width: 1024, height: 1024 },
      count: 2
    }
  }));
  assert.equal(longPolled.details.operationStatus, "completed");
  assert.equal(longPolled.details.deliveryReady, true);
  assert.equal(Object.hasOwn(longPolled.details, "nextAction"), false);
  assert.ok(Date.now() - longPollStartedAt >= 120, "generate 不能在 queued -> running 时提前返回");
  await longPollRuntime.dispose();

  // 批次总预算包含排队时间。即使前一个批次占满并发槽，后续批次到期后
  // 也必须收敛并取消本地任务，不能在模型收到结果后继续后台生图。
  const batchTimeoutRuntime = createEcommerceImageRuntime(tool.config, {
    imageTimeoutMs: 200,
    batchSettleMs: 20,
    fetchImage: async (_config, _endpoint, _input, signal) => {
      await delay(150, signal);
      return {
        imageBase64: png.toString("base64"),
        mimeType: "image/png",
        providerRequestId: "provider-batch-timeout"
      };
    }
  });
  const blockerPromise = batchTimeoutRuntime.generate(runtimeCall({
    toolCallId: "call-batch-timeout-blocker",
    workspace,
    arguments: {
      prompt: "占用并发槽",
      size: { width: 1024, height: 1024 },
      count: 2
    }
  }));
  await delay(20);
  const timedOutBatch = await batchTimeoutRuntime.generate(runtimeCall({
    toolCallId: "call-batch-timeout-target",
    workspace,
    arguments: {
      prompt: "验证批次总预算",
      size: { width: 1024, height: 1024 }
    }
  }));
  assert.equal(timedOutBatch.status, "interrupted");
  assert.equal(timedOutBatch.details.operationStatus, "interrupted");
  assert.equal(timedOutBatch.details.allSucceeded, false);
  assert.equal(timedOutBatch.details.deliveryReady, false);
  assert.equal(timedOutBatch.details.items[0].error.code, "ecommerce_image_batch_timeout");
  assert.equal(timedOutBatch.details.items[0].error.retryable, false);
  assert.equal(Object.hasOwn(timedOutBatch.details, "nextAction"), false);
  assert.equal(
    [...batchTimeoutRuntime.workerPromises.keys()].some((key) => key.includes(timedOutBatch.details.batchId)),
    false,
    "批次超时结果返回前必须结束对应本地 worker"
  );
  assert.equal((await blockerPromise).details.operationStatus, "completed");
  await batchTimeoutRuntime.dispose();

  // 状态工具不向模型暴露，但 SDK/HTTP 调用仍可在另一个控制流中取消任务。
  const slowPromise = tool.execute("ecommerce_image_generate", {
    prompt: "SLOW",
    size: { width: 1024, height: 1024 },
    count: 3
  }, { workspace, toolCallId: "call-cancel-submit" });
  const slowBatchId = await waitForBatchByPrompt(workspace, "SLOW");
  const cancelled = await tool.execute("ecommerce_image_job_cancel", {
    operationId: slowBatchId
  }, { workspace, toolCallId: "call-cancel-action" });
  assert.equal(cancelled.details.status, "cancelled");
  assert.equal(cancelled.details.progress.cancelled, 3);
  assert.equal(
    cancelled.details.items.every((item) => item.error.message.includes("仍可能继续生成并计费")),
    true
  );
  const slowResult = await slowPromise;
  assert.equal(slowResult.status, "interrupted");
  assert.equal(slowResult.details.operationStatus, "cancelled");
  assert.equal(
    [...tool.ecommerceImageRuntime.workerPromises.keys()].some((key) => key.includes(slowBatchId)),
    false,
    "取消结果返回前必须结束对应本地 worker"
  );

  const legacySlowPromise = tool.execute("ecommerce_image_generate", {
    prompt: "SLOW legacy cancel",
    size: { width: 1024, height: 1024 },
    count: 2
  }, { workspace, toolCallId: "call-legacy-cancel-submit" });
  const legacySlowBatchId = await waitForBatchByPrompt(workspace, "SLOW legacy cancel");
  const legacyCancelled = await tool.execute("ecommerce_image_batch", {
    action: "cancel",
    batchId: legacySlowBatchId
  }, { workspace, toolCallId: "call-legacy-cancel-action" });
  assert.equal(legacyCancelled.details.status, "cancelled");
  const legacySlowResult = await legacySlowPromise;
  assert.equal(legacySlowResult.status, "interrupted");

  const interruptRuntime = createEcommerceImageRuntime(tool.config, {
    imageTimeoutMs: 5_000,
    batchSettleMs: 20,
    fetchImage: async (_config, _endpoint, _input, signal) => {
      await delay(2_000, signal);
      return {
        imageBase64: png.toString("base64"),
        mimeType: "image/png",
        providerRequestId: "provider-interrupt"
      };
    }
  });
  const interruptController = new AbortController();
  const interruptedPromise = interruptRuntime.generate(runtimeCall({
    toolCallId: "call-interrupt-submit",
    workspace,
    signal: interruptController.signal,
    arguments: {
      prompt: "验证中断",
      size: { width: 1024, height: 1024 }
    }
  }));
  setTimeout(() => interruptController.abort("测试中断"), 30);
  const interruptedResult = await interruptedPromise;
  assert.equal(interruptedResult.status, "interrupted");
  assert.equal(interruptedResult.details.operationStatus, "interrupted");
  assert.equal(interruptedResult.details.deliveryReady, false);
  await interruptRuntime.dispose();

  const oversized = await tool.execute("ecommerce_image_generate", {
    prompt: "数量越界",
    size: { width: 1024, height: 1024 },
    count: 10
  }, { workspace });
  assert.equal(oversized.status, "failed");
  assert.match(oversized.error.message, /1 到 9/);

  const legacyJobs = await tool.execute("ecommerce_image_generate", {
    jobs: [{
      prompt: "旧版 jobs 合同",
      size: { width: 1024, height: 1024 },
      count: 2
    }]
  }, { workspace });
  assert.equal(legacyJobs.status, "failed");
  assert.equal(legacyJobs.error.code, "ecommerce_image_unknown_field");

  const escaped = await tool.execute("ecommerce_image_generate", {
    prompt: "越界参考图",
    size: { width: 1024, height: 1024 },
    referenceImages: [{
      path: outsideImage,
      role: "product",
      preserve: "strict"
    }]
  }, { workspace });
  assert.equal(escaped.status, "failed");
  assert.match(escaped.error.message, /workspace/);

  await tool.dispose();
  tool = undefined;
  const interruptedBatchPath = path.join(
    workspace,
    "outputs",
    "ecommerce-images",
    "batches",
    transient.details.batchId,
    "manifest.json"
  );
  const interruptedBatch = JSON.parse(await fs.readFile(interruptedBatchPath, "utf8"));
  interruptedBatch.status = "running";
  interruptedBatch.items[0].status = "running";
  await fs.writeFile(interruptedBatchPath, `${JSON.stringify(interruptedBatch, null, 2)}\n`);
  const interruptedAssetId = interruptedBatch.items[0].assetId;
  const interruptedAssetPath = path.join(
    workspace,
    "outputs",
    "ecommerce-images",
    "assets",
    interruptedAssetId,
    "manifest.json"
  );
  const interruptedAsset = JSON.parse(await fs.readFile(interruptedAssetPath, "utf8"));
  interruptedAsset.versions[0].status = "running";
  await fs.writeFile(interruptedAssetPath, `${JSON.stringify(interruptedAsset, null, 2)}\n`);

  tool = new AgentTool({ workspace, tools: SELECTED_TOOL_NAMES });
  const recovered = await tool.execute("ecommerce_image_job_status", {
    operationId: transient.details.operationId,
    waitMs: 0
  }, { workspace });
  assert.equal(recovered.details.status, "interrupted");
  const recoveredAsset = await tool.execute("ecommerce_image_list", {
    assetId: interruptedAssetId
  }, { workspace });
  assert.equal(recoveredAsset.details.assets[0].versions[0].status, "interrupted");

  console.log("[smoke-ecommerce-images] default hidden ok");
  console.log("[smoke-ecommerce-images] one prompt x count outputs ok");
  console.log("[smoke-ecommerce-images] edit history v1 -> v2 ok");
  console.log("[smoke-ecommerce-images] concurrent edit version lock ok");
  console.log("[smoke-ecommerce-images] concurrency and retry policy ok");
  console.log("[smoke-ecommerce-images] cancel, retry, and restart recovery ok");
  console.log("[smoke-ecommerce-images] workspace and contract validation ok");
} finally {
  if (tool) await tool.dispose();
  if (toolServer) await toolServer.close();
  if (hiddenTool) await hiddenTool.dispose();
  if (newOnlyTool) await newOnlyTool.dispose();
  globalThis.fetch = originalFetch;
  if (originalGateway === undefined) delete process.env.AGENT_TOOL_GATEWAY_BASE_URL;
  else process.env.AGENT_TOOL_GATEWAY_BASE_URL = originalGateway;
  await fs.rm(workspace, { recursive: true, force: true });
  await fs.rm(outsideDirectory, { recursive: true, force: true });
}

function runtimeCall({ toolCallId, workspace: callWorkspace, arguments: args, signal }) {
  return {
    toolCallId,
    arguments: args,
    workspace: { root: callWorkspace },
    signal
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const abort = () => {
      clearTimeout(timer);
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

async function waitForBatchByPrompt(workspaceRoot, prompt, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  const batchesDirectory = path.join(workspaceRoot, "outputs", "ecommerce-images", "batches");
  while (Date.now() < deadline) {
    const entries = await fs.readdir(batchesDirectory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const manifest = await fs.readFile(
        path.join(batchesDirectory, entry.name, "manifest.json"),
        "utf8"
      ).then((content) => JSON.parse(content), () => undefined);
      if (manifest?.items?.some((item) => item.prompt === prompt)) return manifest.batchId;
    }
    await delay(10);
  }
  throw new Error(`等待图片批次落盘超时：${prompt}`);
}

async function pathExists(filePath) {
  return await fs.access(filePath).then(() => true, () => false);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
