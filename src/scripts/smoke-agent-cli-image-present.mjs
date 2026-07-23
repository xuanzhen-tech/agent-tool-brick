/**
 * 【文件说明】
 * 本脚本验证 AgentTool、AgentCli 与 Gateway 模型能力目录的图片呈递链路。
 *
 * 它使用真实 AgentTool 读取 workspace 图片，使用真实 AgentCli 编排工具循环；
 * 只将 LLM 回复替换为可控的本地 runtime，避免 smoke 消耗模型额度。重点断言
 * 图片不会转成 observation，而是仅在视觉模型紧随的一次请求中成为 image_url。
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const toolRepo = path.resolve(scriptDir, "../..");
const cliRepo = process.env.AGENT_CLI_REPO ?? "C:/Users/ddger/Documents/agent-cli-brick";
const { AgentTool } = await import(pathToFileURL(path.join(toolRepo, "src", "index.mjs")));
const { AgentCli } = await import(pathToFileURL(path.join(cliRepo, "src", "index.mjs")));

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-cli-image-present-integration-"));
let agent;
let agentTool;
try {
  const workspace = path.join(tempRoot, "workspace");
  const threadsPath = path.join(tempRoot, "threads");
  await fs.mkdir(path.join(workspace, "outputs"), { recursive: true });
  const image = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  await fs.writeFile(path.join(workspace, "outputs", "preview.png"), image);
  const expectedDataUrl = `data:image/png;base64,${image.toString("base64")}`;

  agentTool = new AgentTool({ workspace, tools: ["image_present"] });
  const requests = [];
  let modelCallCount = 0;
  agent = new AgentCli({
    env: {
      AGENT_CLI_LLM_GATEWAY_URL: "https://gateway.integration.test",
      AGENT_CLI_AUTO_COMPACT_ENABLED: "false"
    },
    modelId: "kimi-k3",
    workspace,
    threadsPath,
    toolRuntime: agentTool,
    fetchImpl: async (url) => {
      assert.equal(String(url), "https://gateway.integration.test/api/models");
      return Response.json({ ok: true, models: [{ id: "kimi-k3", capabilities: { vision: true } }] });
    },
    llmRuntime: {
      async chat(request) {
        requests.push(request);
        modelCallCount += 1;
        if (modelCallCount === 1) {
          return {
            assistantContent: "",
            toolCalls: [{ id: "call-image-present", name: "image_present", arguments: JSON.stringify({ path: "outputs/preview.png" }) }]
          };
        }
        request.emit({ type: "assistant_delta", content: "已根据图片继续处理。" });
        return { assistantContent: "已根据图片继续处理。", toolCalls: [] };
      }
    }
  });

  const events = [];
  for await (const event of agent.chat("请呈递刚生成的图片并继续处理。")) events.push(event);

  assert.equal(events.some((event) => event.type === "agent_output" && event.artifact?.renderer === "image-present"), true);
  const nextRequest = requests[1];
  const transientImageMessage = nextRequest.messages.find((message) => {
    return message.role === "user" && Array.isArray(message.content) && message.content.some((part) => part.type === "image_url");
  });
  assert.equal(transientImageMessage.content[1].image_url.url, expectedDataUrl);
  assert.equal(JSON.stringify(nextRequest.messages).includes("observation"), false);

  const transcript = agent.getThreadTranscript(agent.status().currentThreadId, { includeEvents: true });
  assert.equal(JSON.stringify(transcript).includes(image.toString("base64")), false);
  assert.equal(JSON.stringify(transcript).includes("observation"), false);
  assert.equal(crypto.createHash("sha256").update(image).digest("hex").length, 64);
  console.log("[smoke-agent-cli-image-present] ok");
} finally {
  agent?.dispose();
  await agentTool?.dispose();
  await fs.rm(tempRoot, { recursive: true, force: true });
}
