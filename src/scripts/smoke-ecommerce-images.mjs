import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { AgentTool } from "../index.mjs";

const TOOL_NAMES = [
  "ecommerce_image_generate",
  "ecommerce_image_edit",
  "ecommerce_image_batch",
  "ecommerce_image_list"
];
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "agent-tool-ecommerce-"));
const outsideDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-tool-ecommerce-outside-"));
const outsideImage = path.join(outsideDirectory, "outside.png");
const originalFetch = globalThis.fetch;
const originalGateway = process.env.AGENT_TOOL_GATEWAY_BASE_URL;
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
let activeRequests = 0;
let maxActiveRequests = 0;
let transientFailures = 0;
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
let tool;
let toolServer;
try {
  await fs.mkdir(path.join(workspace, "uploads"), { recursive: true });
  await fs.writeFile(path.join(workspace, "uploads", "product.png"), png);
  await fs.writeFile(outsideImage, png);

  hiddenTool = new AgentTool({ workspace });
  const hiddenNames = hiddenTool.definitions.map((definition) => definition.function.name);
  assert.equal(hiddenNames.some((name) => TOOL_NAMES.includes(name)), false);
  await hiddenTool.dispose();
  hiddenTool = undefined;

  tool = new AgentTool({ workspace, tools: TOOL_NAMES });
  assert.deepEqual(tool.definitions.map((definition) => definition.function.name).sort(), [...TOOL_NAMES].sort());

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
  assert.equal(generated.details.status, "queued");
  assert.equal(Object.hasOwn(generated.details, "jobCount"), false);
  assert.equal(generated.details.imageCount, 4);

  const completed = await waitForBatch(tool, generated.details.batchId);
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
    assert.equal(await pathExists(path.join(workspace, ...artifact.files[0].path.split("/"))), true);
  }
  assert.equal(providerRequests.filter((request) => request.images === 1).length, 4);

  toolServer = await tool.createServer({
    config: { ...tool.config, host: "127.0.0.1", port: 0 }
  });
  const serverAddress = await toolServer.listen();
  const manifestResponse = await originalFetch(`${serverAddress.url}/api/tools/manifest`);
  const manifest = await manifestResponse.json();
  assert.deepEqual(manifest.tools.map((entry) => entry.name).sort(), [...TOOL_NAMES].sort());
  const httpStatusResponse = await originalFetch(`${serverAddress.url}/api/tools/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schemaVersion: "agent-cli-tool.call.v1",
      toolCallId: "call-http-shared-batch",
      toolName: "ecommerce_image_batch",
      arguments: { action: "status", batchId: generated.details.batchId },
      workspace: { root: workspace }
    })
  });
  const httpStatus = await httpStatusResponse.json();
  assert.equal(httpStatus.details.batchId, generated.details.batchId);
  assert.equal(httpStatus.details.status, "completed");
  await toolServer.close();
  toolServer = undefined;

  const first = completed.details.items[0];
  const edited = await tool.execute("ecommerce_image_edit", {
    edits: [{
      assetId: first.assetId,
      versionId: "v1",
      prompt: "只替换为浅灰棚拍背景，保持商品结构、颜色和 Logo 不变",
      size: { width: 1024, height: 1024 },
      quality: "high"
    }]
  }, { workspace });
  const editCompleted = await waitForBatch(tool, edited.details.batchId);
  assert.equal(editCompleted.details.status, "completed");
  assert.equal(editCompleted.details.items[0].assetId, first.assetId);
  assert.equal(editCompleted.details.items[0].versionId, "v2");
  assert.equal(editCompleted.details.items[0].parentVersionId, "v1");
  assert.equal(providerRequests.at(-1).url.endsWith("/api/tools/ecommerce/images/edit"), true);
  assert.equal(providerRequests.at(-1).images, 1);

  const history = await tool.execute("ecommerce_image_list", { assetId: first.assetId }, { workspace });
  assert.equal(history.status, "completed");
  assert.deepEqual(history.details.assets[0].versions.map((version) => version.versionId), ["v1", "v2"]);
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
  const concurrentCompleted = await Promise.all(concurrentEdits.map((entry) => waitForBatch(tool, entry.details.batchId)));
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
  const transientCompleted = await waitForBatch(tool, transient.details.batchId);
  assert.equal(transientCompleted.details.status, "completed");
  assert.equal(transientCompleted.details.items[0].attempts, 3);
  assert.equal(transientFailures, 2);

  const rejected = await tool.execute("ecommerce_image_generate", {
    prompt: "REJECT",
    size: { width: 1024, height: 1024 }
  }, { workspace });
  const rejectedCompleted = await waitForBatch(tool, rejected.details.batchId);
  assert.equal(rejectedCompleted.details.status, "failed");
  assert.equal(rejectedCompleted.details.items[0].attempts, 1);
  assert.equal(rejectedCompleted.details.items[0].error.code, "ecommerce_image_moderation_blocked");

  rejectEnabled = false;
  const retried = await tool.execute("ecommerce_image_batch", {
    action: "retry",
    batchId: rejected.details.batchId
  }, { workspace });
  assert.notEqual(retried.details.batchId, rejected.details.batchId);
  const retryCompleted = await waitForBatch(tool, retried.details.batchId);
  assert.equal(retryCompleted.details.status, "completed");
  assert.notEqual(retryCompleted.details.items[0].assetId, rejectedCompleted.details.items[0].assetId);

  const slow = await tool.execute("ecommerce_image_generate", {
    prompt: "SLOW",
    size: { width: 1024, height: 1024 },
    count: 3
  }, { workspace });
  await delay(50);
  await tool.execute("ecommerce_image_batch", {
    action: "cancel",
    batchId: slow.details.batchId
  }, { workspace });
  const cancelled = await waitForBatch(tool, slow.details.batchId);
  assert.equal(cancelled.details.status, "cancelled");
  assert.equal(cancelled.details.progress.cancelled, 3);

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

  tool = new AgentTool({ workspace, tools: TOOL_NAMES });
  const recovered = await tool.execute("ecommerce_image_batch", {
    action: "status",
    batchId: transient.details.batchId
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
  globalThis.fetch = originalFetch;
  if (originalGateway === undefined) delete process.env.AGENT_TOOL_GATEWAY_BASE_URL;
  else process.env.AGENT_TOOL_GATEWAY_BASE_URL = originalGateway;
  await fs.rm(workspace, { recursive: true, force: true });
  await fs.rm(outsideDirectory, { recursive: true, force: true });
}

async function waitForBatch(agentTool, batchId) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await agentTool.execute("ecommerce_image_batch", {
      action: "status",
      batchId,
      waitMs: 1_000
    }, { workspace });
    if (["partial", "completed", "failed", "cancelled", "interrupted"].includes(result.details.status)) return result;
  }
  throw new Error(`Timed out waiting for ${batchId}`);
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

async function pathExists(filePath) {
  return await fs.access(filePath).then(() => true, () => false);
}
