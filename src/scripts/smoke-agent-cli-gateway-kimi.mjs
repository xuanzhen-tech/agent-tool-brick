/**
 * AgentCli、AgentTool 与 Server Gateway 的真实 Kimi 验收。
 *
 * 此脚本不使用 provider key，也不 mock 模型或 Gateway。它创建一个临时工作区，
 * 让真实 Kimi 自行选择 AgentTool，在 outputs/ 中写入 UTF-8 中文文件，并验证：
 * 1. 首轮模型可见工具中没有 write_stdin；2. 模型实际选择 run_shell；
 * 3. 文件确实落盘；4. 在诊断接口可访问时，Gateway 能按 traceId 查询到请求现场。
 *    公网收到 403 代表 trace 读取已被隔离，需从服务器本机复核持久化。
 *
 * 这是需要网络和模型额度的人工验收脚本，不放入 release:local。
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const agentCliRepo = await resolveAgentCliRepo();
const { AgentCli } = await import(pathToFileURL(path.join(agentCliRepo, "src", "index.mjs")));
const { AgentTool } = await import(pathToFileURL(path.join(repoRoot, "src", "index.mjs")));

const gatewayBaseUrl = normalizeGatewayBaseUrl(
  process.env.AGENT_TOOL_LLM_GATEWAY_URL
  || process.env.AGENT_CLI_LLM_GATEWAY_URL
  || "http://47.109.82.99/agent-llm-gateway"
);
const modelId = process.env.AGENT_TOOL_REAL_KIMI_MODEL || "kimi-k3";
const timeoutMs = readPositiveInteger(process.env.AGENT_TOOL_REAL_KIMI_TIMEOUT_MS, 240_000);
const traceId = `tool-gateway-kimi-${crypto.randomUUID()}`;
const threadId = `tool-gateway-kimi-thread-${crypto.randomUUID()}`;
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-tool-gateway-kimi-"));

let agent;
let agentTool;
try {
  const workspace = path.join(tempRoot, "workspace");
  await fs.mkdir(workspace, { recursive: true });

  agentTool = new AgentTool({ workspace });
  const observedDefinitions = [];
  const toolRuntime = createObservedToolRuntime(agentTool, observedDefinitions);
  const threadStore = createInMemoryThreadStore();

  agent = new AgentCli({
    env: {
      AGENT_CLI_AI_MODEL: modelId,
      AGENT_CLI_LLM_GATEWAY_URL: gatewayBaseUrl,
      AGENT_CLI_AUTO_COMPACT_ENABLED: "false",
      AGENT_CLI_REQUEST_TIMEOUT_MS: String(timeoutMs)
    },
    workspace,
    threadId,
    toolRuntime,
    threadStore
  });

  // AgentCli 会在构造时规范化工具 schema；该快照就是首轮模型请求的工具集合。
  console.log(`[smoke-agent-cli-gateway-kimi] gateway=${gatewayBaseUrl} model=${modelId} traceId=${traceId} threadId=${threadId}`);
  const events = await collectChatEvents(agent, createPrompt(), {
    traceId,
    timeoutMs
  });

  await assertLocalResult({ workspace, events, observedDefinitions });
  await assertGatewayTrace({ gatewayBaseUrl, traceId });
  console.log("[smoke-agent-cli-gateway-kimi] ok");
} finally {
  agent?.dispose();
  await agentTool?.dispose();
  await fs.rm(tempRoot, { recursive: true, force: true });
}

function createObservedToolRuntime(agentTool, observedDefinitions) {
  return {
    get definitions() {
      const definitions = agentTool.definitions;
      observedDefinitions.push(definitions.map((tool) => tool.function?.name).filter(Boolean));
      return definitions;
    },
    execute(name, args, context) {
      return agentTool.execute(name, args, context);
    }
  };
}

function createPrompt() {
  return [
    "这是一次终端工具验收。请在当前 workspace 的 outputs/你好.txt 创建 UTF-8 文本文件；文件解码后的内容必须严格等于两个字符：你好。不得写成“你好。”，不得添加任何标点、标题、解释、空白或换行。",
    "outputs 目录一开始可能不存在。请自行依据工具定义选择合适工具，并在同一次命令中完成：创建目录、以 UTF-8 无 BOM 写入精确内容、读回后以严格相等比较验证目标文件存在且内容正确。",
    "workspace 已是 shell 的当前工作目录，不是环境变量。请使用 outputs/你好.txt 这类相对路径；不要使用 $env:WORKSPACE、%WORKSPACE%、$WORKSPACE、\\outputs 或 C:\\outputs。",
    "不要启动持续服务。只有工具结果明确成功后，才回答：文件已生成。"
  ].join("\n");
}

async function collectChatEvents(agent, message, { traceId, timeoutMs }) {
  const events = [];
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`AgentCli.chat timed out after ${timeoutMs}ms. Events: ${JSON.stringify(events)}`));
    }, timeoutMs);
    timeoutId.unref?.();
  });

  try {
    return await Promise.race([
      (async () => {
        for await (const event of agent.chat(message, { traceId, includeInternalEvents: true })) {
          events.push(event);
        }
        return events;
      })(),
      timeout
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function assertLocalResult({ workspace, events, observedDefinitions }) {
  assert.ok(observedDefinitions.length > 0, "AgentCli must request at least one tool schema set from AgentTool.");
  const firstDefinitions = observedDefinitions[0];
  assert.equal(firstDefinitions.includes("run_shell"), true, "First model request must expose run_shell.");
  assert.equal(firstDefinitions.includes("exec_command"), true, "First model request must expose exec_command.");
  assert.equal(firstDefinitions.includes("write_stdin"), false, "First model request must not expose write_stdin without a terminal session.");

  const terminalToolStarts = events.filter((event) => {
    return event.type === "tool_start" && ["run_shell", "exec_command", "write_stdin"].includes(event.toolName);
  });
  assert.ok(terminalToolStarts.length > 0, `Kimi did not call a terminal tool. Events: ${JSON.stringify(events)}`);
  assert.equal(terminalToolStarts[0].toolName, "run_shell", "Kimi must use run_shell for this one-off file write.");
  assert.equal(terminalToolStarts.some((event) => event.toolName === "write_stdin"), false, "Kimi must not use write_stdin without a terminal session.");
  assert.equal(events.some((event) => event.type === "tool_end" && event.toolName === "run_shell" && event.status === "completed"), true, "run_shell must complete successfully.");
  const terminalCommands = terminalToolStarts.map((event) => JSON.stringify(event.detail ?? ""));
  assert.equal(terminalCommands.some((command) => /\$env:WORKSPACE|%WORKSPACE%|\$WORKSPACE/i.test(command)), false, "Kimi must not treat workspace as an environment variable.");
  assert.equal(terminalCommands.some((command) => /(?:C:)?\\outputs(?:\\|\")/i.test(command)), false, "Kimi must not write to a drive-root outputs directory.");

  const filePath = path.join(workspace, "outputs", "你好.txt");
  const content = await fs.readFile(filePath, "utf8");
  assert.equal(content.trim(), "你好", "Generated file must contain UTF-8 Chinese text.");

  const finalText = events
    .filter((event) => event.type === "assistant_delta")
    .map((event) => event.content ?? "")
    .join("");
  assert.match(finalText, /文件已生成/, "Assistant must only report completion after the verified tool result.");
}

async function assertGatewayTrace({ gatewayBaseUrl, traceId }) {
  const response = await fetch(`${gatewayBaseUrl}/api/llm/traces/${encodeURIComponent(traceId)}`);
  const body = await response.text();
  // trace 查询接口默认仅允许服务器本机或内网访问。公网 403 是预期安全边界，
  // 不能把它误判为 AgentCli、模型调用或工具循环失败。
  if (response.status === 403) {
    console.log(`[smoke-agent-cli-gateway-kimi] trace query is private; verify ${traceId} from the gateway host.`);
    return;
  }
  assert.equal(response.ok, true, `Gateway trace query failed: HTTP ${response.status} ${body}`);
  const payload = JSON.parse(body);
  const requests = Array.isArray(payload)
    ? payload
    : payload.trace?.requests ?? payload.requests ?? payload.items ?? [];
  assert.ok(requests.length > 0, `Gateway did not persist any request for traceId ${traceId}. Payload: ${body}`);
}

async function resolveAgentCliRepo() {
  const candidate = process.env.AGENT_CLI_REPO || "C:/Users/ddger/Documents/agent-cli-brick";
  try {
    const stat = await fs.stat(candidate);
    if (stat.isDirectory()) return candidate;
  } catch {
    // 下面给出可操作的错误信息。
  }
  throw new Error(`Cannot find agent-cli-brick at ${candidate}. Set AGENT_CLI_REPO to its local repository path.`);
}

function normalizeGatewayBaseUrl(value) {
  const normalized = String(value ?? "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(normalized)) {
    throw new Error("AGENT_TOOL_LLM_GATEWAY_URL must be an http(s) URL.");
  }
  return normalized;
}

function readPositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function createInMemoryThreadStore() {
  const records = new Map();
  const threads = new Map();
  return {
    filePath: "memory://agent-cli-gateway-kimi-smoke",
    markStaleRunningThreadsInterrupted() {},
    markUserInput(threadId, userInputAt) {
      const existing = threads.get(threadId) ?? { threadId };
      threads.set(threadId, { ...existing, userInputAt });
    },
    upsertThread(thread) {
      const next = { ...(threads.get(thread.threadId) ?? {}), ...thread };
      threads.set(thread.threadId, next);
      return next;
    },
    getThread(threadId) {
      return threads.get(threadId) ?? null;
    },
    listThreads() {
      return [...threads.values()];
    },
    appendEvent(threadId, runId, event) {
      const items = records.get(threadId) ?? [];
      const seq = items.length + 1;
      const eventWithMeta = { ...event, threadId, runId, seq };
      items.push({ threadId, runId, seq, type: event.type, event: eventWithMeta });
      records.set(threadId, items);
      return { event: eventWithMeta };
    },
    loadEvents(threadId, afterSeq = 0) {
      return (records.get(threadId) ?? []).filter((record) => record.seq > afterSeq);
    }
  };
}
