import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { AgentTool } from "../main/agent-tool.mjs";
import { createEcommerceVideoRuntime } from "../main/ecommerce-video-runtime.mjs";

const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-tool-video-"));

try {
  await smokeVisibility(await createWorkspace("visibility"));
  await smokeGenerateAndIdempotency(await createWorkspace("generate"));
  await smokeRestartRecovery(await createWorkspace("restart"));
  await smokeCancelAndRetry(await createWorkspace("cancel"));
  await smokeConcurrency(await createWorkspace("concurrency"));
  await smokeSubmissionErrors(await createWorkspace("errors"));
  await smokeValidation(await createWorkspace("validation"));
  console.log("ecommerce video smoke passed");
} finally {
  await fs.rm(workspaceRoot, { recursive: true, force: true });
}

async function createWorkspace(name) {
  const workspace = path.join(workspaceRoot, name);
  const imagePath = path.join(workspace, "uploads", "product.png");
  await fs.mkdir(path.dirname(imagePath), { recursive: true });
  await fs.writeFile(imagePath, pngBytes());
  return workspace;
}

async function smokeVisibility(root) {
  const hidden = new AgentTool({ workspace: root, tools: [] });
  const visible = new AgentTool({
    workspace: root,
    tools: [
      "ecommerce_video_generate",
      "ecommerce_video_status",
      "ecommerce_video_cancel",
      "ecommerce_video_retry",
      "ecommerce_video_list"
    ]
  });
  try {
    assert.equal(readToolNames(hidden).includes("ecommerce_video_generate"), false);
    assert.deepEqual(
      readToolNames(visible).filter((name) => name.startsWith("ecommerce_video_")),
      [
        "ecommerce_video_generate",
        "ecommerce_video_status",
        "ecommerce_video_cancel",
        "ecommerce_video_retry",
        "ecommerce_video_list"
      ]
    );
  } finally {
    await hidden.dispose();
    await visible.dispose();
  }
}

async function smokeGenerateAndIdempotency(root) {
  let submissions = 0;
  let statusReads = 0;
  let contentReads = 0;
  const runtime = createEcommerceVideoRuntime({ toolGatewayBaseUrl: "https://gateway.test" }, {
    pollIntervalMs: 1,
    submitTask: async (_config, endpoint, input) => {
      submissions += 1;
      assert.equal(endpoint, "/api/tools/ecommerce/videos/generate");
      assert.equal(input.request.duration, 6);
      assert.equal(input.request.resolution, "1080p");
      assert.equal(input.images.length, 1);
      assert.equal(input.images[0].mimeType, "image/png");
      assert.equal(input.trace.operation, "ecommerce_video_generate");
      return { ok: true, task: { id: "cgt-tool-video-1", status: "queued", traceId: "trace-video-1" } };
    },
    readTask: async () => {
      if (statusReads++ === 0) throw retryableError("temporary status failure");
      return {
        ok: true,
        task: {
          id: "cgt-tool-video-1",
          status: statusReads === 2 ? "running" : "succeeded",
          resolution: "1280x720",
          aspectRatio: "16:9",
          duration: 6,
          usage: { completionTokens: 194940, totalTokens: 194940, amountUsd: 0.4567 }
        }
      };
    },
    readContent: async () => {
      if (contentReads++ === 0) throw retryableError("temporary content failure");
      return { mimeType: "video/mp4", bytes: mp4Bytes() };
    }
  });
  try {
    const call = videoCall(root, "call-video-idempotent");
    const first = await runtime.generate(call);
    assert.equal(first.status, "completed");
    assert.equal(first.details.accepted, true);
    assert.equal(first.details.deliveryReady, false);
    assert.equal(first.artifacts.length, 0);

    await waitUntil(async () => (await runtime.status({
      workspace: { root },
      arguments: { jobId: first.details.job.jobId }
    })).details.deliveryReady);
    const completed = await runtime.status({ workspace: { root }, arguments: { jobId: first.details.job.jobId } });
    assert.equal(completed.artifacts.length, 1);
    assert.equal(completed.artifacts[0].schemaVersion, "agent-output.v1");
    assert.equal(completed.artifacts[0].kind, "video");
    assert.equal(completed.artifacts[0].renderer, "ecommerce-video");
    assert.match(completed.artifacts[0].id, /^ecommerce-video-video-job-/);
    assert.equal(completed.artifacts[0].files.length, 1);
    assert.equal(path.isAbsolute(completed.artifacts[0].files[0].path), false);
    assert.equal(completed.artifacts[0].files[0].mimeType, "video/mp4");
    assert.equal(completed.artifacts[0].data.schemaVersion, "agent-ecommerce-video.v1");
    assert.equal(completed.artifacts[0].data.path, completed.artifacts[0].files[0].path);
    assert.match(completed.artifacts[0].data.contentHash, /^[a-f0-9]{64}$/);
    assert.equal(completed.artifacts[0].data.actual.resolution, "1280x720");
    assert.equal(completed.artifacts[0].data.actual.aspectRatio, "16:9");
    assert.deepEqual(completed.artifacts[0].data.actual.usage, {
      completionTokens: 194940,
      totalTokens: 194940,
      amountUsd: 0.4567
    });
    assert.deepEqual(await fs.readFile(path.join(root, ...completed.artifacts[0].files[0].path.split("/"))), mp4Bytes());
    await assert.rejects(
      runtime.retry({ workspace: { root }, arguments: { jobId: completed.details.job.jobId, confirm: true } }),
      /只有 failed、cancelled 或 interrupted/
    );

    const second = await runtime.generate(call);
    assert.equal(second.status, "completed");
    assert.equal(submissions, 1, "same toolCallId must not submit a second billable task");
    await assert.rejects(
      runtime.generate({
        ...call,
        arguments: { ...call.arguments, prompt: `${call.arguments.prompt} changed` }
      }),
      /同一 toolCallId/
    );

    const listed = await runtime.list({ workspace: { root }, arguments: { status: "completed" } });
    assert.equal(listed.status, "completed");
    assert.ok(listed.details.total >= 1);
    const manifest = JSON.parse(await fs.readFile(
      path.join(root, "outputs", "ecommerce-videos", "jobs", first.details.job.jobId, "manifest.json"),
      "utf8"
    ));
    assert.equal(manifest.sourceImagePath, "uploads/product.png");
    assert.equal(JSON.stringify(manifest).includes(root), false);
    assert.equal(JSON.stringify(manifest).includes("base64"), false);
  } finally {
    await runtime.dispose();
    await assert.rejects(
      runtime.list({ workspace: { root }, arguments: {} }),
      /商品视频运行时已释放/
    );
  }
}

async function smokeRestartRecovery(root) {
  const toolCallId = "call-video-restart";
  const first = createEcommerceVideoRuntime({ toolGatewayBaseUrl: "https://gateway.test" }, {
    pollIntervalMs: 60_000,
    submitTask: async () => ({ ok: true, task: { id: "cgt-tool-video-restart", status: "queued" } }),
    readTask: async () => ({ ok: true, task: { id: "cgt-tool-video-restart", status: "running" } }),
    readContent: async () => ({ mimeType: "video/mp4", bytes: mp4Bytes() })
  });
  const pending = first.generate(videoCall(root, toolCallId));
  const accepted = await pending;
  await waitUntil(async () => {
    const manifest = await readManifest(root, accepted.details.job.jobId);
    return manifest.providerTaskId === "cgt-tool-video-restart";
  });
  await first.dispose();
  assert.equal((await readManifest(root, accepted.details.job.jobId)).status, "interrupted");

  const second = createEcommerceVideoRuntime({ toolGatewayBaseUrl: "https://gateway.test" }, {
    pollIntervalMs: 1,
    submitTask: async () => { throw new Error("recovery must not resubmit"); },
    readTask: async () => ({ ok: true, task: { id: "cgt-tool-video-restart", status: "succeeded" } }),
    readContent: async () => ({ mimeType: "video/mp4", bytes: mp4Bytes() })
  });
  try {
    await second.list({ workspace: { root }, arguments: {} });
    await waitUntil(async () => {
      const result = await second.status({ workspace: { root }, arguments: { jobId: accepted.details.job.jobId } });
      return result.details.job.status === "completed";
    });
  } finally {
    await second.dispose();
  }
}

async function smokeCancelAndRetry(root) {
  let cancelledProviderTask;
  let submissions = 0;
  const runtime = createEcommerceVideoRuntime({ toolGatewayBaseUrl: "https://gateway.test" }, {
    pollIntervalMs: 5,
    submitTask: async () => ({ ok: true, task: { id: `cgt-cancel-${++submissions}`, status: "queued" } }),
    readTask: async () => ({ ok: true, task: { status: "running" } }),
    readContent: async () => ({ mimeType: "video/mp4", bytes: mp4Bytes() }),
    cancelTask: async (_config, endpoint) => {
      cancelledProviderTask = endpoint;
      return { ok: true };
    }
  });
  try {
    const accepted = await runtime.generate(videoCall(root, "call-video-cancel"));
    await waitUntil(async () => Boolean((await readManifest(root, accepted.details.job.jobId)).providerTaskId));
    assert.equal(Object.hasOwn((await runtime.status({
      workspace: { root },
      arguments: { jobId: accepted.details.job.jobId }
    })).details.job, "providerTaskId"), false, "public Tool result must not expose Provider task ids");
    const cancelled = await runtime.cancel({ workspace: { root }, arguments: { jobId: accepted.details.job.jobId } });
    assert.equal(cancelled.details.job.status, "cancelled");
    assert.match(cancelledProviderTask, /\/cancel$/);
    await assert.rejects(
      runtime.retry({ workspace: { root }, arguments: { jobId: accepted.details.job.jobId, confirm: false } }),
      /confirm=true/
    );
    const retried = await runtime.retry({
      workspace: { root },
      toolCallId: "call-video-retry",
      arguments: { jobId: accepted.details.job.jobId, confirm: true }
    });
    assert.equal(retried.details.retriedFromJobId, accepted.details.job.jobId);
    assert.notEqual(retried.details.job.jobId, accepted.details.job.jobId);
    await waitUntil(async () => Boolean((await readManifest(root, retried.details.job.jobId)).providerTaskId));
    const retriedCancelled = await runtime.cancel({
      workspace: { root },
      arguments: { jobId: retried.details.job.jobId }
    });
    assert.equal(retriedCancelled.details.job.status, "cancelled");
  } finally {
    await runtime.dispose();
  }
}

async function smokeConcurrency(root) {
  let submissions = 0;
  let releaseFirst = false;
  const runtime = createEcommerceVideoRuntime({ toolGatewayBaseUrl: "https://gateway.test" }, {
    pollIntervalMs: 5,
    maxConcurrentJobs: 2,
    maxConcurrentJobsPerWorkspace: 1,
    submitTask: async () => ({ ok: true, task: { id: `cgt-concurrency-${++submissions}`, status: "queued" } }),
    readTask: async (_config, endpoint) => ({
      ok: true,
      task: { status: endpoint.includes("concurrency-1") && !releaseFirst ? "running" : "succeeded" }
    }),
    readContent: async () => ({ mimeType: "video/mp4", bytes: mp4Bytes() })
  });
  try {
    const first = await runtime.generate(videoCall(root, "call-video-concurrency-1"));
    const second = await runtime.generate(videoCall(root, "call-video-concurrency-2"));
    await waitUntil(() => submissions === 1);
    assert.equal(submissions, 1, "same workspace must only have one active provider task");
    releaseFirst = true;
    await waitUntil(async () => (await runtime.status({ workspace: { root }, arguments: { jobId: first.details.job.jobId } })).details.deliveryReady);
    await waitUntil(() => submissions === 2);
    await waitUntil(async () => (await runtime.status({ workspace: { root }, arguments: { jobId: second.details.job.jobId } })).details.deliveryReady);
  } finally {
    await runtime.dispose();
  }
}

async function smokeSubmissionErrors(root) {
  const rejected = createEcommerceVideoRuntime({ toolGatewayBaseUrl: "https://gateway.test" }, {
    submitTask: async () => {
      const error = new Error("ImaRouter balance is insufficient.");
      error.code = "ecommerce_video_provider_quota_exceeded";
      error.statusCode = 402;
      error.retryable = false;
      throw error;
    }
  });
  try {
    const accepted = await rejected.generate(videoCall(root, "call-video-rejected"));
    await waitUntil(async () => (await readManifest(root, accepted.details.job.jobId)).status === "failed");
    const manifest = await readManifest(root, accepted.details.job.jobId);
    assert.equal(manifest.submissionState, "rejected");
    assert.equal(manifest.error.code, "ecommerce_video_provider_quota_exceeded");
  } finally {
    await rejected.dispose();
  }

  const uncertain = createEcommerceVideoRuntime({ toolGatewayBaseUrl: "https://gateway.test" }, {
    submitTask: async () => {
      const error = new Error("socket closed before the response arrived");
      error.code = "server_tool_gateway_network_error";
      error.retryable = false;
      throw error;
    }
  });
  try {
    const accepted = await uncertain.generate(videoCall(root, "call-video-uncertain"));
    await waitUntil(async () => (await readManifest(root, accepted.details.job.jobId)).status === "failed");
    const manifest = await readManifest(root, accepted.details.job.jobId);
    assert.equal(manifest.submissionState, "unknown");
    assert.equal(manifest.error.code, "ecommerce_video_submission_uncertain");
  } finally {
    await uncertain.dispose();
  }
}

async function smokeValidation(root) {
  let submissions = 0;
  const runtime = createEcommerceVideoRuntime({ toolGatewayBaseUrl: "https://gateway.test" }, {
    submitTask: async () => { submissions += 1; }
  });
  try {
    for (const argumentsValue of [
      { imagePath: path.resolve(root, "uploads/product.png"), prompt: "test" },
      { imagePath: "uploads/product.png", prompt: "test", duration: 3 },
      { imagePath: "uploads/product.png", prompt: "test", resolution: "4K" },
      { imagePath: "uploads/product.png", prompt: "test", unknown: true }
    ]) {
      await assert.rejects(
        runtime.generate({ workspace: { root }, arguments: argumentsValue, toolCallId: `call-invalid-${Math.random()}` }),
        /imagePath|duration|resolution|不支持字段/
      );
    }
    assert.equal(submissions, 0);
  } finally {
    await runtime.dispose();
  }
}

function videoCall(root, toolCallId) {
  return {
    toolCallId,
    workspace: { root },
    traceContext: { traceId: "trace-tool-video", threadId: "thread-tool-video", turnId: "turn-tool-video" },
    arguments: {
      imagePath: "uploads/product.png",
      prompt: "Lock product identity. Use one slow clockwise orbit, clean studio light, no text mutation.",
      aspectRatio: "1:1"
    }
  };
}

function readToolNames(agentTool) {
  return agentTool.definitions.map((tool) => tool.function.name);
}

async function readManifest(root, jobId) {
  return JSON.parse(await fs.readFile(
    path.join(root, "outputs", "ecommerce-videos", "jobs", jobId, "manifest.json"),
    "utf8"
  ));
}

async function waitUntil(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Condition was not reached before timeout.");
}

function pngBytes() {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
}

function mp4Bytes() {
  return Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00]);
}

function retryableError(message) {
  const error = new Error(message);
  error.retryable = true;
  return error;
}
