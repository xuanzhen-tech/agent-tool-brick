/**
 * 五件套产品组合 smoke。
 *
 * 本文件验证 agent-cli、agent-tool、agent-skill、node-runtime、python-runtime
 * 能否按产品仓库的真实组合方式一起工作。默认模式 mock LLM provider，保证本地
 * 和 CI 稳定复现；传入 --real-kimi 时只替换为真实 Kimi provider，runtime artifact、
 * skill 扫描/激活、tool 执行始终走真实对象。
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const encoder = new TextEncoder();
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const realKimi = process.argv.includes("--real-kimi");

const repos = await resolveRepoPaths();
const { AgentCli } = await import(pathToFileURL(path.join(repos.agentCli, "src", "index.mjs")));
const { AgentSkill } = await import(pathToFileURL(path.join(repos.agentSkill, "src", "index.mjs")));
const { AgentTool } = await import(pathToFileURL(path.join(repoRoot, "src", "index.mjs")));

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "five-brick-product-smoke-"));
try {
  console.log(`[smoke-five-brick-integration] mode ${realKimi ? "real-kimi" : "mock"}`);
  const workspace = path.join(tempRoot, "workspace");
  const managedRoot = path.join(tempRoot, "managed-skills");
  await createFixtureSkill(managedRoot);

  console.log("[smoke-five-brick-integration] expand runtime artifacts");
  const { nodeBin, pythonBin } = await installRuntimeArtifacts(tempRoot);

  const agentSkill = new AgentSkill(managedRoot);
  await agentSkill.refresh();
  assert.equal(agentSkill.definitions.some((skill) => skill.name === "python-reporter"), true);

  const agentTool = new AgentTool({
    workspace,
    skillRuntime: agentSkill,
    runtimeDependencies: [
      { type: "node-runtime", bin: nodeBin },
      { type: "python-runtime", bin: pythonBin }
    ]
  });
  assert.equal(agentTool.definitions.some((tool) => tool.function?.name === "skill_find"), true);
  assert.equal(agentTool.definitions.some((tool) => tool.function?.name === "skill_activate"), true);
  assert.equal(agentTool.definitions.some((tool) => tool.function?.name === "run_shell"), true);

  const toolDiagnostics = await agentTool.diagnostics({ workspace });
  assert.equal(toolDiagnostics.checks.find((check) => check.id === "python.runtime")?.status, "pass");

  const threadStore = createInMemoryThreadStore();
  const payloads = [];
  const agent = new AgentCli({
    env: createAgentEnv(),
    workspace,
    threadId: `five-brick-product-smoke-${realKimi ? "kimi" : "mock"}`,
    runtimeDependencies: [{ type: "node-runtime", bin: nodeBin }],
    toolRuntime: agentTool,
    skillRuntime: agentSkill,
    threadStore,
    ...(realKimi ? {} : { fetchImpl: createMockFetch(payloads) })
  });

  const cliDiagnostics = await agent.diagnostics();
  assert.equal(cliDiagnostics.checks.find((check) => check.id === "node.runtime")?.status, "pass");

  const events = await collectChatEvents(agent, createPrompt(), realKimi ? 240_000 : 120_000);
  assertFiveBrickEvents(events, payloads);

  agent.dispose();
  await agentTool.dispose();
  console.log("[smoke-five-brick-integration] ok");
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}

async function resolveRepoPaths() {
  return {
    agentCli: process.env.AGENT_CLI_REPO || await firstExistingPath([
      "C:/Users/ddger/Documents/agent-cli-brick",
      "C:/Users/ddger/AppData/Local/Temp/agent-cli-brick-plan-inspect"
    ], "agent-cli-brick"),
    agentSkill: process.env.AGENT_SKILL_REPO || await firstExistingPath([
      "C:/Users/ddger/Documents/agent-skill-brick"
    ], "agent-skill-brick"),
    nodeRuntime: process.env.NODE_RUNTIME_REPO || await firstExistingPath([
      "C:/Users/ddger/Documents/node-runtime-brick"
    ], "node-runtime-brick"),
    pythonRuntime: process.env.PYTHON_RUNTIME_REPO || await firstExistingPath([
      "C:/Users/ddger/Documents/python-runtime-brick"
    ], "python-runtime-brick")
  };
}

// 支持默认 clone 路径和环境变量覆盖，方便产品仓库或 CI 复用同一套 smoke。
async function firstExistingPath(candidates, label) {
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) return candidate;
    } catch {
      // 继续尝试下一个候选路径。
    }
  }
  throw new Error(`Cannot find ${label}. Set the matching *_REPO environment variable.`);
}

async function createFixtureSkill(managedRoot) {
  const skillDir = path.join(managedRoot, "python-reporter");
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), [
    "---",
    "name: python-reporter",
    "description: Use Python runtime to inspect data and report concise results.",
    "capabilities: python,reporting",
    "requiredTools: run_shell",
    "---",
    "",
    "When this skill is active, verify Python dependencies before reporting results.",
    "Use concise evidence from command output."
  ].join("\n"), "utf8");
}

async function installRuntimeArtifacts(tempRoot) {
  const nodeDescriptor = await readDescriptor(repos.nodeRuntime);
  const pythonDescriptor = await readDescriptor(repos.pythonRuntime);
  const nodeInstallRoot = path.join(tempRoot, "node-runtime");
  const pythonInstallRoot = path.join(tempRoot, "python-runtime");
  await expandArchive(fileURLToPath(nodeDescriptor.url), nodeInstallRoot);
  await expandArchive(fileURLToPath(pythonDescriptor.url), pythonInstallRoot);
  return {
    nodeBin: path.join(nodeInstallRoot, ...nodeDescriptor.metadata.binRelativePath.split("/")),
    pythonBin: path.join(pythonInstallRoot, ...pythonDescriptor.metadata.binRelativePath.split("/"))
  };
}

async function readDescriptor(repoPath) {
  return JSON.parse(await fs.readFile(path.join(repoPath, "dist", "descriptor.local.json"), "utf8"));
}

// Windows zip artifact 的解包方式模拟 host/client-shell 安装后的真实目录结构。
async function expandArchive(zipPath, destination) {
  await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    `Expand-Archive -LiteralPath ${quotePowerShell(zipPath)} -DestinationPath ${quotePowerShell(destination)} -Force`
  ], { timeout: 300_000, windowsHide: true });
}

function createAgentEnv() {
  if (!realKimi) {
    return {
      AGENT_CLI_AI_PROVIDER: "deepseek",
      AGENT_CLI_DEEPSEEK_API_KEY: "sk-test",
      AGENT_CLI_AUTO_COMPACT_ENABLED: "false"
    };
  }

  const kimiKey = process.env.AGENT_CLI_KIMI_API_KEY || process.env.KIMI_API_KEY || process.env.MOONSHOT_API_KEY;
  if (!kimiKey) {
    throw new Error("Real Kimi smoke requires AGENT_CLI_KIMI_API_KEY, KIMI_API_KEY, or MOONSHOT_API_KEY.");
  }
  return {
    AGENT_CLI_AI_PROVIDER: "kimi",
    AGENT_CLI_AI_MODEL: process.env.AGENT_CLI_KIMI_MODEL || "kimi-k2.6",
    AGENT_CLI_KIMI_API_KEY: kimiKey,
    AGENT_CLI_AUTO_COMPACT_ENABLED: "false",
    AGENT_CLI_REQUEST_TIMEOUT_MS: "180000"
  };
}

function createPrompt() {
  return [
    "This is an acceptance smoke test for a modular agent product.",
    "You must use tools in this order:",
    "1. Call skill_find with query \"python reporter\".",
    "2. Call skill_activate for skill \"python-reporter\".",
    "3. Call run_shell in process mode with executable \"python\" and args:",
    "   [\"-s\", \"-c\", \"import importlib; [importlib.import_module(name) for name in ['openpyxl','pandas','docx','fitz']]; print('FIVE_BRICK_PYTHON_OK')\"]",
    "After the Python command succeeds, answer exactly: FIVE_BRICK_DONE"
  ].join("\n");
}

// mock 只替代模型 provider；五个 brick 的对象组合和 runtime artifact 消费仍然是真实路径。
function createMockFetch(payloads) {
  let requestIndex = 0;
  const responses = [
    [
      `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-find","function":{"name":"skill_find","arguments":"{\\"query\\":\\"python reporter\\"}"}}]}}]}\n\n`,
      "data: [DONE]\n\n"
    ],
    [
      `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-activate","function":{"name":"skill_activate","arguments":"{\\"skill\\":\\"python-reporter\\"}"}}]}}]}\n\n`,
      "data: [DONE]\n\n"
    ],
    [
      `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-python","function":{"name":"run_shell","arguments":"{\\"mode\\":\\"process\\",\\"executable\\":\\"python\\",\\"args\\":[\\"-s\\",\\"-c\\",\\"import importlib; [importlib.import_module(name) for name in ['openpyxl','pandas','docx','fitz']]; print('FIVE_BRICK_PYTHON_OK')\\"]}"}}]}}]}\n\n`,
      "data: [DONE]\n\n"
    ],
    [
      `data: {"choices":[{"delta":{"content":"FIVE_BRICK_DONE"}}]}\n\n`,
      "data: [DONE]\n\n"
    ]
  ];

  return async (_url, init) => {
    payloads.push(JSON.parse(init.body));
    const chunks = responses[requestIndex++];
    return new Response(new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      }
    }), { status: 200 });
  };
}

async function collectChatEvents(agent, message, timeoutMs) {
  const events = [];
  const timeout = new Promise((_, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`AgentCli.chat timed out after ${timeoutMs}ms. Events so far: ${JSON.stringify(events)}`));
    }, timeoutMs);
    timer.unref?.();
  });
  const collect = (async () => {
    for await (const event of agent.chat(message, { includeInternalEvents: true })) {
      events.push(event);
    }
    return events;
  })();
  return await Promise.race([collect, timeout]);
}

function assertFiveBrickEvents(events, payloads) {
  if (!realKimi) {
    assert.equal(payloads[0].messages.some((message) => {
      return message.role === "system" && message.content.includes("python-reporter");
    }), true);
    assert.equal(payloads[0].tools.some((tool) => tool.function?.name === "skill_find"), true);
  }

  assert.equal(events.some((event) => event.type === "tool_end" && event.toolName === "skill_find"), true);
  assert.equal(events.some((event) => event.type === "loaded_skill" && event.skillName === "python-reporter"), true);
  assert.equal(events.some((event) => {
    return event.type === "tool_end" && event.toolName === "run_shell" && /FIVE_BRICK_PYTHON_OK/.test(event.result ?? "");
  }), true);

  const finalText = events
    .filter((event) => event.type === "assistant_delta")
    .map((event) => event.content ?? "")
    .join("");
  assert.match(finalText, /FIVE_BRICK_DONE/);
}

// AgentCli 需要 threadStore 合同；内存实现避免 smoke 污染用户真实 thread 历史。
function createInMemoryThreadStore() {
  const records = new Map();
  const threads = new Map();
  return {
    filePath: "memory://five-brick-product-smoke",
    markStaleRunningThreadsInterrupted() {},
    markUserInput(threadId, userInputAt) {
      const existing = threads.get(threadId) ?? { threadId };
      threads.set(threadId, { ...existing, userInputAt });
    },
    upsertThread(thread) {
      const existing = threads.get(thread.threadId) ?? {};
      const next = { ...existing, ...thread };
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

function quotePowerShell(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}
