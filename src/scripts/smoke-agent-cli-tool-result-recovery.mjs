/**
 * 【文件说明】
 * 本文件联调真实 AgentCli 与 AgentTool 对象，验证模型可以从超长 MCP 风格结果
 * 中获得 resultId，并在下一次工具循环按路径恢复数据。只有 LLM 决策使用本地
 * 可控 runtime，Provider、压缩、磁盘与 thread 生命周期均走正式实现。
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { AgentTool } from "../index.mjs";

const agentCliRepo = process.env.AGENT_CLI_REPO || "C:/Users/ddger/Documents/agent-cli-brick";
const { AgentCli } = await import(pathToFileURL(path.join(agentCliRepo, "src", "index.mjs")));
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-tool-cli-recovery-"));
const workspace = path.join(tempRoot, "workspace");
const threadsPath = path.join(tempRoot, "threads");
const threadId = `thread-tool-result-integration-${Date.now()}`;
await fs.mkdir(workspace, { recursive: true });

const provider = createProvider();
const toolRuntime = new AgentTool({
  workspace,
  tools: ["seller_mcp"],
  toolProviders: [provider]
});
const llmRequests = [];
let resultId;
const llmRuntime = {
  kind: "tool-result-recovery-integration",
  async chat(request) {
    llmRequests.push(request);
    if (llmRequests.length === 1) {
      return {
        assistantContent: "",
        toolCalls: [{ id: "call-seller-large", name: "seller_mcp", arguments: "{}" }]
      };
    }
    if (llmRequests.length === 2) {
      const toolMessage = request.messages.findLast((message) => message.role === "tool");
      const summary = JSON.parse(toolMessage.content);
      resultId = summary.resultRef?.resultId ?? summary.recovery?.resultRef?.resultId;
      assert.equal(typeof resultId, "string");
      assert.equal(summary.recoverable ?? summary.recovery?.resultRef?.recoverable, true);
      return {
        assistantContent: "",
        toolCalls: [{
          id: "call-read-needed-page",
          name: "tool_result_read",
          arguments: JSON.stringify({ resultId, path: "/data/price", offset: 250, limit: 3 })
        }]
      };
    }
    const toolMessage = request.messages.findLast((message) => message.role === "tool");
    const wrappedPage = JSON.parse(toolMessage.content);
    const page = JSON.parse(wrappedPage.content);
    assert.equal(page.items[0].day, 250);
    assert.equal(page.items.length, 3);
    request.emit({ type: "assistant_delta", content: "已从外置结果读取第 250-252 条证据。" });
    return { assistantContent: "已从外置结果读取第 250-252 条证据。", toolCalls: [] };
  }
};

const agent = new AgentCli({
  agentId: "tool-result-smoke",
  workspace,
  threadsPath,
  threadId,
  toolRuntime,
  llmRuntime,
  env: { AGENT_CLI_AUTO_COMPACT_ENABLED: "false" }
});

const events = [];
for await (const event of agent.chat("读取很长的价格历史，只分析第 250-252 条。", { threadId })) {
  events.push(event);
}
assert.equal(llmRequests.length, 3);
assert.equal(events.filter((event) => event.type === "tool_end").length, 2);
assert.equal(events.some((event) => event.type === "assistant_delta" && event.content.includes("250-252")), true, JSON.stringify(events));
assert.equal(llmRequests[1].messages.findLast((message) => message.role === "tool").content.length < 24_000, true);

const resultPath = path.join(os.homedir(), ".agent-cli", "tool-results", threadId, `${resultId}.json`);
assert.equal((await fs.stat(resultPath)).size > 250_000, true);
agent.deleteThread(threadId);
await waitUntilMissing(resultPath);

agent.dispose();
await toolRuntime.dispose();
await fs.rm(tempRoot, { recursive: true, force: true });
console.log("[smoke-agent-cli-tool-result-recovery] ok");

function createProvider() {
  const rows = Array.from({ length: 366 }, (_, day) => ({
    day,
    asin: `ASIN-${day}`,
    value: 100 + day,
    evidence: `price-evidence-${day}-${"z".repeat(850)}`
  }));
  const value = { code: "OK", data: { price: rows, buyBox: rows } };
  return {
    id: "seller-integration",
    toolDescriptors: [{
      name: "seller_mcp",
      defaultVisible: true,
      schema: {
        type: "function",
        function: {
          name: "seller_mcp",
          description: "返回大型价格历史。",
          parameters: { type: "object", properties: {} }
        }
      }
    }],
    async execute() {
      const result = { content: [{ type: "text", text: JSON.stringify(value) }], isError: false };
      return {
        status: "completed",
        content: JSON.stringify({ serverId: "seller", result }),
        details: { serverId: "seller", result }
      };
    }
  };
}

async function waitUntilMissing(filePath) {
  for (let index = 0; index < 50; index += 1) {
    try {
      await fs.access(filePath);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`结果文件未随 thread 删除: ${filePath}`);
}
