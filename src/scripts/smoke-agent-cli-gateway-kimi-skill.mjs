/**
 * AgentCli、AgentTool、AgentSkill 与 Server Gateway 的真实远端 skill 验收。
 *
 * 本脚本不使用 provider key，也不 mock 模型、Gateway、skills.sh 或安装结果。
 * 它让 Kimi 经由 Gateway 驱动完整工具循环：在 skills.sh 搜索候选、按候选的
 * package 安装到隔离的 managed skills 根目录、激活已安装 skill，并确认 CLI
 * 收到 loaded_skill 上下文事件。脚本不进入 release:local，避免网络和模型额度
 * 影响常规发布检查。
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const agentCliRepo = await resolveRepository("AGENT_CLI_REPO", "C:/Users/ddger/Documents/agent-cli-brick", "agent-cli-brick");
const agentSkillRepo = await resolveRepository("AGENT_SKILL_REPO", "C:/Users/ddger/Documents/agent-skill-brick", "agent-skill-brick");
const { AgentCli } = await import(pathToFileURL(path.join(agentCliRepo, "src", "index.mjs")));
const { AgentTool } = await import(pathToFileURL(path.join(repoRoot, "src", "index.mjs")));
const { AgentSkill } = await import(pathToFileURL(path.join(agentSkillRepo, "src", "index.mjs")));

const gatewayBaseUrl = normalizeGatewayBaseUrl(
  process.env.AGENT_TOOL_LLM_GATEWAY_URL
  || process.env.AGENT_CLI_LLM_GATEWAY_URL
  || "http://47.109.82.99/agent-llm-gateway"
);
const modelId = process.env.AGENT_TOOL_REAL_KIMI_MODEL || "kimi-k3";
const timeoutMs = readPositiveInteger(process.env.AGENT_TOOL_REAL_KIMI_TIMEOUT_MS, 300_000);
// skills.sh 的搜索目录与上游仓库可用 skill 名偶尔不同。该候选经真实安装验证，
// 用作稳定的远端安装验收目标；模型仍需先搜索并确认它确实出现在候选列表中。
const verifiedSkillsShPackage = "samhvw8/dot-claude@git-workflow";
const traceId = `tool-gateway-kimi-skill-${crypto.randomUUID()}`;
const threadId = `tool-gateway-kimi-skill-thread-${crypto.randomUUID()}`;
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-tool-gateway-kimi-skill-"));

let agent;
let agentTool;
try {
  const workspace = path.join(tempRoot, "workspace");
  const skillsPath = path.join(tempRoot, ".agent-cli", "skills");
  await fs.mkdir(workspace, { recursive: true });

  const agentSkill = new AgentSkill({ skillsPath });
  agentTool = new AgentTool({ workspace, skillRuntime: agentSkill });
  agent = new AgentCli({
    env: {
      AGENT_CLI_AI_MODEL: modelId,
      AGENT_CLI_LLM_GATEWAY_URL: gatewayBaseUrl,
      AGENT_CLI_AUTO_COMPACT_ENABLED: "false",
      AGENT_CLI_REQUEST_TIMEOUT_MS: String(timeoutMs)
    },
    workspace,
    threadId,
    toolRuntime: agentTool,
    skillRuntime: agentSkill,
    threadStore: createInMemoryThreadStore()
  });

  console.log(`[smoke-agent-cli-gateway-kimi-skill] gateway=${gatewayBaseUrl} model=${modelId} traceId=${traceId} threadId=${threadId}`);
  const events = await collectChatEvents(agent, createPrompt(), { traceId, timeoutMs });
  const index = await agentSkill.refresh();

  await assertSkillFlow({ events, index, skillsPath });
  await assertGatewayTrace({ gatewayBaseUrl, traceId, minimumRequests: 3 });
  console.log("[smoke-agent-cli-gateway-kimi-skill] ok");
} finally {
  agent?.dispose();
  await agentTool?.dispose();
  await fs.rm(tempRoot, { recursive: true, force: true });
}

function createPrompt() {
  return [
    "这是远端 skill 安装验收，必须且只能通过 skill 工具完成。",
    "第一步：调用 skill_find，action=search、source=skills-sh、query=git commit，查看远端候选。",
    `第二步：确认第一步 candidates 中包含 package=${verifiedSkillsShPackage} 后，只安装这个 package：调用 skill_find，action=install、source=skills-sh，并传入该 package。不得编造或改写 package。`,
    "第三步：根据安装结果调用 skill_activate，激活刚安装的 skill。",
    "不得使用 run_shell、exec_command 或 write_stdin 代替上述流程。只有三个步骤均在工具结果中成功后，才回答：REMOTE_SKILL_READY。"
  ].join("\n");
}

async function collectChatEvents(agent, message, { traceId, timeoutMs }) {
  const events = [];
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`AgentCli skill smoke timed out after ${timeoutMs}ms. Events: ${JSON.stringify(events)}`));
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

async function assertSkillFlow({ events, index, skillsPath }) {
  const forbiddenTools = events.filter((event) => {
    return event.type === "tool_start" && ["run_shell", "exec_command", "write_stdin"].includes(event.toolName);
  });
  assert.equal(forbiddenTools.length, 0, `Kimi must not substitute shell tools. Events: ${JSON.stringify(forbiddenTools)}`);

  const skillFindStarts = events.filter((event) => event.type === "tool_start" && event.toolName === "skill_find");
  assert.ok(skillFindStarts.length >= 2, "Kimi must search and then install through skill_find.");
  const skillFindArguments = skillFindStarts.map((event) => normalizeToolArguments(event.detail));
  assert.equal(skillFindArguments.some((argumentsValue) => {
    return (argumentsValue.action === "search" || (!argumentsValue.action && argumentsValue.query)) && argumentsValue.source === "skills-sh";
  }), true, `Kimi must search skills.sh. Calls: ${JSON.stringify(skillFindArguments)}`);
  assert.equal(skillFindArguments.some((argumentsValue) => {
    return argumentsValue.action === "install" && argumentsValue.source === "skills-sh" && argumentsValue.package === verifiedSkillsShPackage;
  }), true, `Kimi must install the verified skills.sh candidate. Calls: ${JSON.stringify(skillFindArguments)}`);
  assert.equal(events.some((event) => event.type === "tool_end" && event.toolName === "skill_find" && event.status === "completed"), true);
  assert.equal(events.some((event) => event.type === "tool_end" && event.toolName === "skill_activate" && event.status === "completed"), true);

  const loadedSkill = events.find((event) => event.type === "loaded_skill")?.loadedSkill;
  assert.ok(loadedSkill?.name, "AgentCli must receive the loaded_skill event after activation.");
  assert.equal(index.skills.some((skill) => skill.name === loadedSkill.name), true, "Activated skill must be indexed after installation.");
  assert.equal(path.resolve(loadedSkill.path).startsWith(path.resolve(skillsPath)), true, "Activated skill must be installed under the isolated managed skills root.");
  const stat = await fs.stat(loadedSkill.path);
  assert.equal(stat.isFile(), true, "Installed SKILL.md must exist on disk.");

  const finalText = events
    .filter((event) => event.type === "assistant_delta")
    .map((event) => event.content ?? "")
    .join("");
  assert.match(finalText, /REMOTE_SKILL_READY/, "Assistant must report success only after the complete remote skill flow.");
}

function normalizeToolArguments(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function assertGatewayTrace({ gatewayBaseUrl, traceId, minimumRequests }) {
  const response = await fetch(`${gatewayBaseUrl}/api/llm/traces/${encodeURIComponent(traceId)}`);
  const body = await response.text();
  // Gateway 将 trace 阅读接口隔离在服务器本机或内网。公网 403 证明该边界仍然
  // 生效；实际持久化由服务器侧验收命令按同一 traceId 复核。
  if (response.status === 403) {
    console.log(`[smoke-agent-cli-gateway-kimi-skill] trace query is private; verify ${traceId} from the gateway host.`);
    return;
  }
  assert.equal(response.ok, true, `Gateway trace query failed: HTTP ${response.status} ${body}`);
  const payload = JSON.parse(body);
  const requests = Array.isArray(payload)
    ? payload
    : payload.trace?.requests ?? payload.requests ?? payload.items ?? [];
  assert.ok(requests.length >= minimumRequests, `Gateway must persist the multi-step tool loop. Payload: ${body}`);
}

async function resolveRepository(envName, fallback, label) {
  const candidate = process.env[envName] || fallback;
  try {
    const stat = await fs.stat(candidate);
    if (stat.isDirectory()) return candidate;
  } catch {
    // 下面给出可操作的错误信息。
  }
  throw new Error(`Cannot find ${label} at ${candidate}. Set ${envName} to its local repository path.`);
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
    filePath: "memory://agent-cli-gateway-kimi-skill-smoke",
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
