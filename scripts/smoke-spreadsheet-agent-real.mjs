/**
 * 【文件说明】
 * 使用真实 AgentCli、AgentTool、Gateway 和文本模型验证表格数据闭环。
 *
 * 这是会消耗真实模型额度的人工验收脚本，不进入 release:local。表格读取、计算、
 * 校验和工作簿文件都是真实实现；脚本只负责准备已知答案 fixture 并检查 Agent 行为。
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
const gatewayBaseUrl = String(
  process.env.AGENT_CLI_LLM_GATEWAY_URL || "http://47.109.82.99/agent-llm-gateway"
).replace(/\/+$/, "");
const modelId = process.env.AGENT_TOOL_REAL_SPREADSHEET_MODEL || "gpt-5.6-sol";
const timeoutMs = Number(process.env.AGENT_TOOL_REAL_SPREADSHEET_TIMEOUT_MS || 360_000);
const threadId = `spreadsheet-real-${crypto.randomUUID()}`;
const traceId = `spreadsheet-real-trace-${crypto.randomUUID()}`;
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-tool-spreadsheet-real-"));
let agent;
let agentTool;

try {
  const fixtureScript = path.join(repoRoot, "src", "scripts", "create-spreadsheet-fixtures.py");
  const fixture = spawnSync(pythonBin, [fixtureScript, tempRoot], { encoding: "utf8", windowsHide: true });
  assert.equal(fixture.status, 0, fixture.stderr || fixture.stdout);

  agentTool = new AgentTool({
    workspace: tempRoot,
    runtimeDependencies: [{ type: "python-runtime", bin: pythonBin }],
    tools: ["spreadsheet_inspect", "spreadsheet_compute", "spreadsheet_validate"]
  });
  agent = new AgentCli({
    agentId: "spreadsheet-real",
    env: {
      AGENT_CLI_AI_MODEL: modelId,
      AGENT_CLI_LLM_GATEWAY_URL: gatewayBaseUrl,
      AGENT_CLI_AUTO_COMPACT_ENABLED: "false",
      AGENT_CLI_REQUEST_TIMEOUT_MS: String(timeoutMs)
    },
    workspace: tempRoot,
    threadId,
    threadStore: createInMemoryThreadStore(),
    toolRuntime: agentTool
  });

  console.log(`[smoke-spreadsheet-agent-real] gateway=${gatewayBaseUrl} model=${modelId} threadId=${threadId} traceId=${traceId}`);
  const events = await collectEvents(agent, [
    "请检查 uploads/advertising.xlsx。只比较 Excel Table CampaignData 与 PartialData 的 spend 总额，并用确定性质量门核对两者是否一致。",
    "你必须依次使用 spreadsheet_inspect、spreadsheet_compute、spreadsheet_validate；不能用 shell、不能心算、不能信任公式缓存。",
    "货币绝对容差为 0.01。若不一致，只报告两边总额、差额、差异比例和数据未闭环，不得继续提出预算或广告策略。"
  ].join("\n"), { traceId, timeoutMs });

  const toolNames = events.filter((event) => event.type === "tool_start").map((event) => event.toolName);
  assertOrderedTools(toolNames, ["spreadsheet_inspect", "spreadsheet_compute", "spreadsheet_validate"]);
  const validationEnd = events.find((event) => event.type === "tool_end" && event.toolName === "spreadsheet_validate");
  assert.ok(validationEnd, "真实 Agent 必须完成 spreadsheet_validate 调用。");
  const finalText = events
    .filter((event) => event.type === "assistant_delta")
    .map((event) => event.content || "")
    .join("");
  assert.match(finalText, /39[,，]?541\.62|39541\.62/);
  assert.match(finalText, /29[,，]?607\.13|29607\.13/);
  assert.match(finalText, /9[,，]?934\.49|9934\.49/);
  assert.match(finalText, /未闭环|不一致|对账失败/);
  assert.doesNotMatch(finalText, /建议(?:增加|降低|调整).{0,8}预算/);
  console.log("[smoke-spreadsheet-agent-real] ok");
} finally {
  await agent?.dispose?.();
  await agentTool?.dispose?.();
  await fs.rm(tempRoot, { recursive: true, force: true });
}

async function collectEvents(currentAgent, message, { traceId: currentTraceId, timeoutMs: currentTimeout }) {
  const events = [];
  let timer;
  try {
    return await Promise.race([
      (async () => {
        for await (const event of currentAgent.chat(message, {
          traceId: currentTraceId,
          workspace: tempRoot,
          includeInternalEvents: true
        })) {
          events.push(event);
        }
        return events;
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`真实表格 Agent 验收超过 ${currentTimeout}ms。`)), currentTimeout);
        timer.unref?.();
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function assertOrderedTools(actual, expected) {
  let cursor = -1;
  for (const name of expected) {
    cursor = actual.indexOf(name, cursor + 1);
    assert.notEqual(cursor, -1, `工具调用顺序缺少 ${name}，实际为 ${actual.join(", ")}`);
  }
}

function createInMemoryThreadStore() {
  const records = new Map();
  const threads = new Map();
  return {
    filePath: "memory://spreadsheet-agent-real",
    markStaleRunningThreadsInterrupted() {},
    markUserInput(id, userInputAt) {
      threads.set(id, { ...(threads.get(id) ?? { threadId: id }), userInputAt });
    },
    upsertThread(thread) {
      const next = { ...(threads.get(thread.threadId) ?? {}), ...thread };
      threads.set(thread.threadId, next);
      return next;
    },
    getThread(id) { return threads.get(id) ?? null; },
    listThreads() { return [...threads.values()]; },
    appendEvent(id, runId, event) {
      const items = records.get(id) ?? [];
      const seq = items.length + 1;
      const stored = { ...event, threadId: id, runId, seq };
      items.push({ threadId: id, runId, seq, type: stored.type, event: stored });
      records.set(id, items);
      return { event: stored };
    },
    loadEvents(id, afterSeq = 0) {
      return (records.get(id) ?? []).filter((record) => record.seq > afterSeq);
    }
  };
}
