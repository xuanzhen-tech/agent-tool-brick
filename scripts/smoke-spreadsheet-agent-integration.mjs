/**
 * 【文件说明】
 * 使用真实 AgentCli、AgentTool、Python worker 和 XLSX，验证完整表格工具循环。
 * LLM 仅使用确定性测试适配器来选择下一步工具，不伪造任何表格计算结果。
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { AgentTool } from "../src/index.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agentCliRepo = process.env.AGENT_CLI_REPO || path.join(path.dirname(repoRoot), "agent-cli-brick");
const { AgentCli } = await import(pathToFileURL(path.join(agentCliRepo, "src", "index.mjs")));
const pythonBin = process.env.AGENT_TOOL_PYTHON_BIN || "python";
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "agent-tool-spreadsheet-agent-"));
let agent;
let toolRuntime;

try {
  const fixtureScript = path.join(repoRoot, "src", "scripts", "create-spreadsheet-fixtures.py");
  const fixture = spawnSync(pythonBin, [fixtureScript, workspace], { encoding: "utf8", windowsHide: true });
  assert.equal(fixture.status, 0, fixture.stderr || fixture.stdout);

  toolRuntime = new AgentTool({
    workspace,
    runtimeDependencies: [{ type: "python-runtime", bin: pythonBin }],
    tools: ["spreadsheet_inspect", "spreadsheet_compute", "spreadsheet_validate"]
  });

  const modelRequests = [];
  const llmRuntime = {
    async chat(request) {
      modelRequests.push(request);
      if (modelRequests.length === 1) {
        assertToolVisible(request, "spreadsheet_inspect");
        return toolCall("inspect", "spreadsheet_inspect", {
          path: "uploads/advertising.xlsx",
          sheets: ["Campaign", "Partial"]
        });
      }
      if (modelRequests.length === 2) {
        const inspection = readLatestToolPayload(request);
        const campaign = inspection.tables.find((table) => table.declaredName === "CampaignData");
        const partial = inspection.tables.find((table) => table.declaredName === "PartialData");
        assert.ok(campaign && partial, "inspect 必须返回两个明确的 Excel Table。");
        return toolCall("compute", "spreadsheet_compute", {
          analysisId: inspection.analysisId,
          queries: [
            {
              id: "campaign-total",
              tableId: campaign.tableId,
              measures: [{ id: "spend", operation: "sum", column: "spend" }]
            },
            {
              id: "partial-total",
              tableId: partial.tableId,
              measures: [{ id: "spend", operation: "sum", column: "spend" }]
            }
          ]
        });
      }
      if (modelRequests.length === 3) {
        const calculation = readLatestToolPayload(request);
        const campaign = calculation.results.find((result) => result.queryId === "campaign-total");
        const partial = calculation.results.find((result) => result.queryId === "partial-total");
        assert.equal(campaign.preview[0].spend, "39541.62");
        assert.equal(partial.preview[0].spend, "29607.13");
        return toolCall("validate", "spreadsheet_validate", {
          analysisId: calculation.analysisId,
          resultIds: [campaign.resultId, partial.resultId],
          checks: [{
            id: "spend-reconciliation",
            type: "numeric_compare",
            left: { resultId: campaign.resultId, rowIndex: 0, field: "spend" },
            operator: "eq",
            right: { resultId: partial.resultId, rowIndex: 0, field: "spend" },
            absoluteTolerance: "0.01"
          }]
        });
      }
      if (modelRequests.length === 4) {
        const validation = readLatestToolPayload(request);
        assert.equal(validation.validationStatus, "failed");
        assert.equal(validation.checks[0].absoluteDifference, "9934.49");
        const content = "两张表的花费分别为 39541.62 与 29607.13，差额 9934.49；数据未闭环，停止输出正式预算策略。";
        request.emit({ type: "assistant_delta", content });
        return { assistantContent: content, toolCalls: [] };
      }
      throw new Error("Agent 发起了非预期的额外模型请求。");
    }
  };

  agent = new AgentCli({
    agentId: "spreadsheet-smoke",
    workspace,
    threadStore: createInMemoryThreadStore(),
    toolRuntime,
    llmRuntime,
    env: { AGENT_CLI_AUTO_COMPACT_ENABLED: "false" }
  });

  const events = [];
  for await (const event of agent.chat("核对两张广告花费表；不一致时停止正式策略。", {
    threadId: "spreadsheet-agent-integration",
    workspace
  })) {
    events.push(event);
  }

  assert.deepEqual(
    events.filter((event) => event.type === "tool_start").map((event) => event.toolName),
    ["spreadsheet_inspect", "spreadsheet_compute", "spreadsheet_validate"]
  );
  assert.equal(modelRequests.length, 4);
  assert.match(events.filter((event) => event.type === "assistant_delta").map((event) => event.content).join(""), /数据未闭环/);
  console.log("[smoke-spreadsheet-agent-integration] ok");
} finally {
  await agent?.dispose?.();
  await toolRuntime?.dispose?.();
  await fs.rm(workspace, { recursive: true, force: true });
}

function toolCall(id, name, args) {
  return {
    assistantContent: "",
    toolCalls: [{ id: `call-${id}`, name, arguments: JSON.stringify(args) }]
  };
}

function assertToolVisible(request, name) {
  assert.equal(
    request.tools.some((tool) => tool.function?.name === name),
    true,
    `${name} 必须出现在 AgentCli 发送给模型的工具 schema 中。`
  );
}

function readLatestToolPayload(request) {
  const message = [...request.messages].reverse().find((item) => item.role === "tool");
  assert.ok(message, "下一次模型请求必须携带上一条 tool result。");
  const result = JSON.parse(String(message.content));
  assert.equal(typeof result.content, "string", "表格工具应在标准 Tool Result 的 content 中返回摘要。");
  return JSON.parse(result.content);
}

function createInMemoryThreadStore() {
  const records = new Map();
  const threads = new Map();
  return {
    filePath: "memory://spreadsheet-agent-integration",
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
