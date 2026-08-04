import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { AgentTool } from "../index.mjs";

const gatewayBaseUrl = process.env.AGENT_TOOL_GATEWAY_BASE_URL;
if (!gatewayBaseUrl) {
  throw new Error("AGENT_TOOL_GATEWAY_BASE_URL is required.");
}

const workspace = process.env.AGENT_TOOL_REAL_IMAGE_WORKSPACE
  ? path.resolve(process.env.AGENT_TOOL_REAL_IMAGE_WORKSPACE)
  : await fs.mkdtemp(path.join(os.tmpdir(), "agent-tool-real-seedream-"));
await fs.mkdir(workspace, { recursive: true });

const tool = new AgentTool({
  workspace,
  tools: ["ecommerce_image_generate", "ecommerce_image_edit", "ecommerce_image_list"]
});

try {
  const generated = await tool.execute("ecommerce_image_generate", {
    modelId: "doubao-seedream-5-0",
    requests: [{
      key: "seedream-real-smoke",
      prompt: "一只白色陶瓷咖啡杯，居中摆放在纯白摄影棚背景，柔和阴影，电商商品主图，不添加文字或标志",
      size: { width: 2048, height: 2048 },
      quality: "high"
    }],
    output: { format: "png" }
  }, { workspace, toolCallId: `real-seedream-generate-${Date.now()}` });

  assert.equal(generated.status, "completed");
  assert.equal(generated.details.modelId, "doubao-seedream-5-0");
  assert.equal(generated.details.deliveryReady, true);
  assert.equal(generated.artifacts.length, 1);
  const first = generated.details.items[0];

  const edited = await tool.execute("ecommerce_image_edit", {
    modelId: "doubao-seedream-5-0",
    edits: [{
      assetId: first.assetId,
      versionId: first.versionId,
      prompt: "保持咖啡杯的形状、颜色和构图不变，只把纯白背景替换成浅灰色摄影棚背景",
      size: { width: 2048, height: 2048 },
      quality: "high"
    }],
    output: { format: "png" }
  }, { workspace, toolCallId: `real-seedream-edit-${Date.now()}` });

  assert.equal(edited.status, "completed");
  assert.equal(edited.details.modelId, "doubao-seedream-5-0");
  assert.equal(edited.details.items[0].assetId, first.assetId);
  assert.equal(edited.details.items[0].versionId, "v2");
  assert.equal(edited.details.items[0].parentVersionId, "v1");

  const history = await tool.execute("ecommerce_image_list", {
    assetId: first.assetId
  }, { workspace });
  assert.deepEqual(history.details.assets[0].versions.map((version) => version.versionId), ["v1", "v2"]);
  assert.deepEqual(history.details.assets[0].versions.map((version) => version.modelId), [
    "doubao-seedream-5-0",
    "doubao-seedream-5-0"
  ]);

  console.log(JSON.stringify({
    ok: true,
    gatewayBaseUrl,
    workspace,
    batchIds: [generated.details.batchId, edited.details.batchId],
    assetId: first.assetId,
    versions: history.details.assets[0].versions.map((version) => ({
      versionId: version.versionId,
      modelId: version.modelId,
      path: version.path,
      contentHash: version.contentHash
    }))
  }, null, 2));
} finally {
  await tool.dispose();
}
