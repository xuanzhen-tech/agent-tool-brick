/**
 * 【文件说明】
 * 本脚本验证真实 AgentCli、AgentTool、Server Gateway 与 Kimi K3 的图片呈递链路。
 *
 * 图片先由本地 image_present 校验为 artifact；AgentCli 依据 Gateway 能力目录，仅在
 * 紧随的一次请求把原生图片交给 Kimi。脚本不读取 provider key，也不 mock 模型。
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
const { AgentCli } = await import(pathToFileURL(path.join(cliRepo, "src", "index.mjs")));
const { AgentTool } = await import(pathToFileURL(path.join(toolRepo, "src", "index.mjs")));

const gatewayBaseUrl = String(process.env.AGENT_TOOL_LLM_GATEWAY_URL ?? "http://47.109.82.99/agent-llm-gateway").replace(/\/+$/, "");
const traceId = `image-present-kimi-${crypto.randomUUID()}`;
const threadId = `image-present-kimi-thread-${crypto.randomUUID()}`;
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-tool-kimi-image-present-"));

let agent;
let tool;
try {
  const workspace = path.join(tempRoot, "workspace");
  await fs.mkdir(path.join(workspace, "outputs"), { recursive: true });
  // 这是一个经过标准 PNG 编码的蓝底金色折线图，用于确认 Kimi 实际收到图片。
  await fs.writeFile(path.join(workspace, "outputs", "vision-smoke.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAGAAAABACAIAAABqVuVZAAABrklEQVR4nO3c/Y2CQBAFcDTUcluIFOFVQ66aa+Is5HVjoonhhN3Zb2Tmvb+MKGZ/eQ6I0dPX9W9g/DkHtjEEksMGCSGQEAIJIZAQAgkZfRvwexmMxX3f1neyQUIIlPsWCxdPU8LDhA0SQiAhBBJiDgjzlPT4s0EdpBgZAsLCBfMUyWQI6C3uJ+pSqhUg/O9LpI4VICQOZltAWOnE10c/EMp0lAOhWEc5ULmOZiDkHrZMAKHgsKUfCDVGj1ogVNXZGQjpHx1TU6gTdcm1g87LqHA9tQbzzkDwV+a5KW9hjZrYGwgRy8goVPXRswMQPDTPlWxujZRqp9MPCFvrXy7jdTtVqqlODyAEi+O73/cscUjV1WkOBKk4vkQWKmPPnwKESmsIS3XI+FHFKZFqUZ8mZ9JooPO2q/XeGulUbhAa02zuFvPUTqdmg9BRp+dLVGgQ+g6FzhkPWpwDAEF1cUqBoL04+UCwUZxMIJgpTuZh3nU8Qzv8kHbaaTJPFN3DxYhO5pm0M6Oj8Hux6iFQ8ZCGvZ/9LMMGCSGQkBP/WCAcNkgIgYQQSAiBhBBICIGGcO5xHa/e+pRtlgAAAABJRU5ErkJggg==", "base64"));

  tool = new AgentTool({ workspace, tools: ["image_present"] });
  agent = new AgentCli({
    env: {
      AGENT_CLI_AI_MODEL: "kimi-k3",
      AGENT_CLI_LLM_GATEWAY_URL: gatewayBaseUrl,
      AGENT_CLI_AUTO_COMPACT_ENABLED: "false",
      AGENT_CLI_REQUEST_TIMEOUT_MS: "240000"
    },
    workspace,
    threadsPath: path.join(tempRoot, "threads"),
    toolRuntime: tool
  });

  const events = [];
  console.log(`[smoke-agent-cli-gateway-kimi-image-present] gateway=${gatewayBaseUrl} traceId=${traceId} threadId=${threadId}`);
  for await (const event of agent.chat([
    "这是图片呈递验收。workspace 的 outputs/vision-smoke.png 已存在。",
    "现在必须调用 image_present 呈递这个文件。工具成功后，依据图片实际内容回答其中的折线是什么颜色。",
    "不要使用 shell，不要说你已通过文字描述看图，也不要跳过工具调用。"
  ].join("\n"), { threadId, traceId, includeInternalEvents: true })) {
    events.push(event);
  }

  assert.equal(events.some((event) => event.type === "tool_start" && event.toolName === "image_present"), true, "Kimi must call image_present.");
  assert.equal(events.some((event) => event.type === "tool_end" && event.toolName === "image_present" && event.status === "completed"), true, "image_present must complete.");
  const answer = events.filter((event) => event.type === "assistant_delta").map((event) => event.content ?? "").join("");
  assert.match(answer, /金色|黄色|黄/, `Kimi did not identify the gold line from the presented image: ${answer}`);
  console.log("[smoke-agent-cli-gateway-kimi-image-present] ok");
} finally {
  agent?.dispose();
  await tool?.dispose();
  await fs.rm(tempRoot, { recursive: true, force: true });
}
