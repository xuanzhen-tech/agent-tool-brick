import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { AgentTool } from "../main/agent-tool.mjs";
import { createEcommerceVideoRuntime } from "../main/ecommerce-video-runtime.mjs";

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "agent-tool-video-"));
const imagePath = path.join(workspace, "uploads", "product.png");
await fs.mkdir(path.dirname(imagePath), { recursive: true });
await fs.writeFile(imagePath, pngBytes());

try {
  await smokeVisibility(workspace);
  await smokeGenerateAndIdempotency(workspace);
  await smokeRestartRecovery(workspace);
  await smokeValidation(workspace);
  console.log("ecommerce video smoke passed");
} finally {
  await fs.rm(workspace, { recursive: true, force: true });
}

async function smokeVisibility(root) {
  const hidden = new AgentTool({ workspace: root, tools: [] });
  const visible = new AgentTool({
    workspace: root,
    tools: ["ecommerce_video_generate", "ecommerce_video_list"]
  });
  try {
    assert.equal(readToolNames(hidden).includes("ecommerce_video_generate"), false);
    assert.deepEqual(
      readToolNames(visible).filter((name) => name.startsWith("ecommerce_video_")),
      ["ecommerce_video_generate", "ecommerce_video_list"]
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
        task: { id: "cgt-tool-video-1", status: statusReads === 2 ? "running" : "succeeded" }
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
    assert.equal(first.details.deliveryReady, true);
    assert.equal(first.artifacts.length, 1);
    assert.equal(first.artifacts[0].schemaVersion, "agent-output.v1");
    assert.equal(first.artifacts[0].kind, "video");
    assert.equal(first.artifacts[0].renderer, "ecommerce-video");
    assert.match(first.artifacts[0].id, /^ecommerce-video-video-job-/);
    assert.equal(first.artifacts[0].files.length, 1);
    assert.equal(path.isAbsolute(first.artifacts[0].files[0].path), false);
    assert.equal(first.artifacts[0].files[0].mimeType, "video/mp4");
    assert.equal(first.artifacts[0].data.schemaVersion, "agent-ecommerce-video.v1");
    assert.equal(first.artifacts[0].data.path, first.artifacts[0].files[0].path);
    assert.match(first.artifacts[0].data.contentHash, /^[a-f0-9]{64}$/);
    assert.deepEqual(await fs.readFile(path.join(root, ...first.artifacts[0].files[0].path.split("/"))), mp4Bytes());

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
  await waitUntil(async () => {
    const jobs = await first.list({ workspace: { root }, arguments: {} });
    return jobs.details.jobs.some((job) => job.providerTaskId === "cgt-tool-video-restart");
  });
  await first.dispose();
  const interrupted = await pending;
  assert.equal(interrupted.status, "interrupted");

  const second = createEcommerceVideoRuntime({ toolGatewayBaseUrl: "https://gateway.test" }, {
    pollIntervalMs: 1,
    submitTask: async () => { throw new Error("recovery must not resubmit"); },
    readTask: async () => ({ ok: true, task: { id: "cgt-tool-video-restart", status: "succeeded" } }),
    readContent: async () => ({ mimeType: "video/mp4", bytes: mp4Bytes() })
  });
  try {
    await second.list({ workspace: { root }, arguments: {} });
    await waitUntil(async () => {
      const jobs = await second.list({ workspace: { root }, arguments: {} });
      return jobs.details.jobs.some((job) => job.providerTaskId === "cgt-tool-video-restart" && job.status === "completed");
    });
  } finally {
    await second.dispose();
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

async function waitUntil(predicate, timeoutMs = 2_000) {
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
