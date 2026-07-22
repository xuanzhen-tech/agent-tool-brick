/**
 * 【文件说明】
 * 本脚本验证 AgentCli 与 AgentTool 内置可视化工具的真实对象联调。
 *
 * LLM 使用确定性测试运行时，只负责发起一次工具调用；Vega-Lite 渲染、outputs 文件、
 * agent_output 事件、下一轮模型消息和 thread transcript 均走正式代码，避免把
 * “工具 schema 可见”误当成“产品链路已经可用”。
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { AgentTool } from "../src/index.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-tool-visualization-agent-"));

try {
  const { AgentCli } = await import(pathToFileURL(path.join(resolveAgentCliRepo(), "src", "index.mjs")));
  const workspace = path.join(tempRoot, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  const threadStore = createInMemoryThreadStore();
  const toolRuntime = new AgentTool({
    workspace,
    tools: ["visualization_create_dashboard"]
  });
  const modelRequests = [];
  const agent = new AgentCli({
    workspace,
    threadStore,
    toolRuntime,
    llmRuntime: {
      async chat(request) {
        modelRequests.push(request);
        if (modelRequests.length === 1) {
          return {
            assistantContent: "",
            toolCalls: [{
              id: "call-dashboard",
              name: "visualization_create_dashboard",
              arguments: JSON.stringify({
                title: "渠道概览",
                kpis: [{ label: "总销售额", value: "195 万", tone: "positive" }],
                panels: [{
                  id: "channels",
                  kind: "chart",
                  title: "渠道销售额",
                  data: [{ channel: "A", sales: 120 }, { channel: "B", sales: 45 }, { channel: "C", sales: 30 }],
                  spec: {
                    mark: "bar",
                    encoding: {
                      x: { field: "channel", type: "nominal" },
                      y: { field: "sales", type: "quantitative" }
                    }
                  }
                }]
              })
            }]
          };
        }
        request.emit({ type: "assistant_delta", content: "看板已生成。" });
        return { assistantContent: "看板已生成。", toolCalls: [] };
      }
    }
  });

  const events = [];
  for await (const event of agent.chat("请生成渠道销售看板", { threadId: "visualization-agent", workspace })) {
    events.push(event);
  }
  const output = events.find((event) => event.type === "agent_output");
  assert.equal(output?.artifact?.kind, "visualization");
  assert.equal(output?.artifact?.renderer, "dashboard");
  const dashboardFile = output.artifact.files.find((file) => file.path.endsWith("/dashboard.json"));
  assert.ok(dashboardFile, "可视化 artifact 必须包含 dashboard.json。");
  assert.match(await fs.readFile(path.join(workspace, dashboardFile.path), "utf8"), /渠道概览/);
  assert.equal(modelRequests.length, 2);
  const toolMessage = modelRequests[1].messages.find((message) => message.role === "tool");
  assert.match(String(toolMessage?.content), /dashboard-/);
  assert.equal(String(toolMessage?.content).includes('"spec"'), false, "完整图表 spec 不应回填到下一轮模型消息。");
  const transcript = agent.getThreadTranscript("visualization-agent");
  assert.equal(
    transcript.messages.some((message) => message.subtype === "agent_output" && message.artifact?.id === output.artifact.id),
    true
  );

  await agent.dispose();
  await toolRuntime.dispose();
  console.log("[smoke-visualization-agent-integration] ok");
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}

function resolveAgentCliRepo() {
  // 仅供开发联调：默认发现同级仓库，CI 或任意目录布局可通过环境变量覆盖。
  return process.env.AGENT_CLI_REPO || path.join(path.resolve(repoRoot, ".."), "agent-cli-brick");
}

function createInMemoryThreadStore() {
  const records = new Map();
  const threads = new Map();
  return {
    filePath: "memory://visualization-agent-integration",
    markStaleRunningThreadsInterrupted() {},
    markUserInput(threadId, userInputAt) {
      threads.set(threadId, { ...(threads.get(threadId) ?? { threadId }), userInputAt });
    },
    upsertThread(thread) {
      const next = { ...(threads.get(thread.threadId) ?? {}), ...thread };
      threads.set(thread.threadId, next);
      return next;
    },
    getThread(threadId) { return threads.get(threadId) ?? null; },
    listThreads() { return [...threads.values()]; },
    appendEvent(threadId, runId, event) {
      const items = records.get(threadId) ?? [];
      const seq = items.length + 1;
      const stored = { ...event, threadId, runId, seq };
      items.push({ threadId, runId, seq, type: stored.type, event: stored });
      records.set(threadId, items);
      return { event: stored };
    },
    loadEvents(threadId, afterSeq = 0) {
      return (records.get(threadId) ?? []).filter((item) => item.seq > afterSeq);
    }
  };
}
