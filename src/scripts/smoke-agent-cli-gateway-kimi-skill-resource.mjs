/**
 * AgentCli、AgentTool、AgentSkill 与 Server Gateway 的真实 skill 资源验收。
 *
 * 本脚本不 mock 模型、Gateway 或工具执行。它在临时目录创建一个真实 skill 包，
 * 让 Kimi 依次激活 skill、读取 references、复制 assets，并核对 CLI 专门事件与
 * 固定 temp/skill-assets 路径上的实际文件。网络和模型额度会影响执行时间，因此
 * 不纳入 release:local。
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
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

const skillName = "resource-fixture";
const referencePath = "references/usage.md";
const assetPath = "assets/template.txt";
const referenceContent = "# Resource Fixture\n\nRead this reference through skill_resource only.\n";
const assetContent = "resource fixture asset\n";
const assetHash = crypto.createHash("sha256").update(assetContent).digest("hex");
const gatewayBaseUrl = normalizeGatewayBaseUrl(
  process.env.AGENT_TOOL_LLM_GATEWAY_URL
  || process.env.AGENT_CLI_LLM_GATEWAY_URL
  || "http://47.109.82.99/agent-llm-gateway"
);
const modelId = process.env.AGENT_TOOL_REAL_KIMI_MODEL || "kimi-k3";
const timeoutMs = readPositiveInteger(process.env.AGENT_TOOL_REAL_KIMI_TIMEOUT_MS, 300_000);
const traceId = `tool-gateway-kimi-skill-resource-${crypto.randomUUID()}`;
const threadId = `tool-gateway-kimi-skill-resource-thread-${crypto.randomUUID()}`;
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-tool-gateway-kimi-skill-resource-"));

let agent;
let agentTool;
try {
  const workspace = path.join(tempRoot, "workspace");
  const skillsPath = path.join(tempRoot, ".agent-cli", "skills");
  await createFixtureSkill(skillsPath);
  await fs.mkdir(workspace, { recursive: true });

  const agentSkill = new AgentSkill({ skillsPath });
  await agentSkill.refresh();
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

  console.log(`[smoke-agent-cli-gateway-kimi-skill-resource] gateway=${gatewayBaseUrl} model=${modelId} traceId=${traceId} threadId=${threadId}`);
  const events = await collectChatEvents(agent, createPrompt(), { traceId, timeoutMs });
  await assertResourceFlow({ events, workspace });
  await assertGatewayTrace({ gatewayBaseUrl, traceId });
  console.log("[smoke-agent-cli-gateway-kimi-skill-resource] ok");
} finally {
  agent?.dispose();
  await agentTool?.dispose();
  await fs.rm(tempRoot, { recursive: true, force: true });
}

async function createFixtureSkill(skillsPath) {
  const skillRoot = path.join(skillsPath, skillName);
  await fs.mkdir(path.join(skillRoot, "references"), { recursive: true });
  await fs.mkdir(path.join(skillRoot, "assets"), { recursive: true });
  await fs.writeFile(path.join(skillRoot, "SKILL.md"), [
    "---",
    `name: ${skillName}`,
    "description: Controlled fixture for skill resource verification.",
    "---",
    "",
    "Activate this skill before using its package resources."
  ].join("\n"), "utf8");
  await fs.writeFile(path.join(skillRoot, ...referencePath.split("/")), referenceContent, "utf8");
  await fs.writeFile(path.join(skillRoot, ...assetPath.split("/")), assetContent, "utf8");
}

function createPrompt() {
  return [
    "这是 skill 资源验收。必须按顺序且只能使用以下 skill 工具：",
    `1. 调用 skill_activate，skill=${skillName}。`,
    `2. 调用 skill_resource，action=read_reference、skill=${skillName}、path=${referencePath}。不得用 run_shell 读取 reference。`,
    `3. 调用 skill_resource，action=copy_asset、skill=${skillName}、path=${assetPath}。不要传任何目标路径参数。`,
    "不要调用 run_shell、exec_command 或 write_stdin。三个工具结果都成功后，回答：RESOURCE_SKILL_READY。"
  ].join("\n");
}

async function collectChatEvents(agentInstance, message, { traceId: currentTraceId, timeoutMs: currentTimeoutMs }) {
  const events = [];
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`AgentCli resource smoke timed out after ${currentTimeoutMs}ms. Events: ${JSON.stringify(events)}`));
    }, currentTimeoutMs);
    timeoutId.unref?.();
  });

  try {
    return await Promise.race([
      (async () => {
        for await (const event of agentInstance.chat(message, { traceId: currentTraceId, includeInternalEvents: true })) {
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

async function assertResourceFlow({ events, workspace }) {
  const forbiddenTools = events.filter((event) => {
    return event.type === "tool_start" && ["run_shell", "exec_command", "write_stdin"].includes(event.toolName);
  });
  assert.equal(forbiddenTools.length, 0, `Kimi must use controlled skill resources rather than shell. Events: ${JSON.stringify(forbiddenTools)}`);

  const toolStarts = events.filter((event) => event.type === "tool_start");
  assert.equal(toolStarts[0]?.toolName, "skill_activate");
  assert.equal(toolStarts[1]?.toolName, "skill_resource");
  assert.equal(toolStarts[2]?.toolName, "skill_resource");
  const resourceArguments = toolStarts
    .filter((event) => event.toolName === "skill_resource")
    .map((event) => parseToolArguments(event.detail));
  assert.deepEqual(resourceArguments, [
    { action: "read_reference", skill: skillName, path: referencePath },
    { action: "copy_asset", skill: skillName, path: assetPath }
  ]);

  assert.equal(events.some((event) => event.type === "loaded_skill" && event.skillName === skillName), true);
  const loadedReference = events.find((event) => event.type === "loaded_skill_reference");
  assert.equal(loadedReference?.resourcePath, referencePath);
  assert.equal(loadedReference?.loadedSkillReference?.content, referenceContent);

  const assetResultEvent = events.find((event) => {
    if (event.type !== "tool_end" || event.toolName !== "skill_resource") return false;
    const result = parseToolResult(event.result);
    return result?.details?.action === "copy_asset";
  });
  const assetResult = parseToolResult(assetResultEvent?.result);
  const workspacePath = assetResult?.details?.workspacePath;
  assert.equal(workspacePath, `temp/skill-assets/${skillName}/${assetHash}/template.txt`);
  assert.equal(await fs.readFile(path.join(workspace, ...workspacePath.split("/")), "utf8"), assetContent);

  const finalText = events
    .filter((event) => event.type === "assistant_delta")
    .map((event) => event.content ?? "")
    .join("");
  assert.match(finalText, /RESOURCE_SKILL_READY/);
}

function parseToolArguments(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return {};
  return JSON.parse(value);
}

function parseToolResult(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

async function assertGatewayTrace({ gatewayBaseUrl: currentGatewayBaseUrl, traceId: currentTraceId }) {
  const response = await fetch(`${currentGatewayBaseUrl}/api/llm/traces/${encodeURIComponent(currentTraceId)}`);
  const body = await response.text();
  // trace 查询接口默认仅开放给服务器本机或内网；公网 403 是正常安全边界。
  if (response.status === 403) {
    console.log(`[smoke-agent-cli-gateway-kimi-skill-resource] trace query is private; verify ${currentTraceId} from the gateway host.`);
    return;
  }
  assert.equal(response.ok, true, `Gateway trace query failed: HTTP ${response.status} ${body}`);
  const payload = JSON.parse(body);
  const requests = Array.isArray(payload)
    ? payload
    : payload.trace?.requests ?? payload.requests ?? payload.items ?? [];
  assert.ok(requests.length >= 4, `Gateway must persist the skill resource tool loop. Payload: ${body}`);
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
    filePath: "memory://agent-cli-gateway-kimi-skill-resource-smoke",
    markStaleRunningThreadsInterrupted() {},
    markUserInput(threadIdValue, userInputAt) {
      const existing = threads.get(threadIdValue) ?? { threadId: threadIdValue };
      threads.set(threadIdValue, { ...existing, userInputAt });
    },
    upsertThread(thread) {
      const next = { ...(threads.get(thread.threadId) ?? {}), ...thread };
      threads.set(thread.threadId, next);
      return next;
    },
    getThread(threadIdValue) {
      return threads.get(threadIdValue) ?? null;
    },
    listThreads() {
      return [...threads.values()];
    },
    appendEvent(threadIdValue, runId, event) {
      const items = records.get(threadIdValue) ?? [];
      const seq = items.length + 1;
      const eventWithMeta = { ...event, threadId: threadIdValue, runId, seq };
      items.push({ threadId: threadIdValue, runId, seq, type: event.type, event: eventWithMeta });
      records.set(threadIdValue, items);
      return { event: eventWithMeta };
    },
    loadEvents(threadIdValue, afterSeq = 0) {
      return (records.get(threadIdValue) ?? []).filter((record) => record.seq > afterSeq);
    }
  };
}
