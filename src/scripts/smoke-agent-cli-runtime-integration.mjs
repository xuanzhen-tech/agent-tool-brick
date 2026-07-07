/**
 * AgentCli + AgentTool + node-runtime + python-runtime 本地集成 smoke。
 *
 * 这个脚本验证真实 runtime artifact 的消费路径：
 * 1. 解压 node-runtime，作为 AgentCli 的 required runtimeDependency 注入。
 * 2. 解压 python-runtime，作为 AgentTool 的 optional runtimeDependency 注入。
 * 3. AgentCli 只通过 toolRuntime 调用 AgentTool。
 * 4. 模型请求 run_shell executable=python 时，AgentTool 会解析到注入的私有 python.exe。
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

const repos = await resolveRepoPaths();
const { AgentCli } = await import(pathToFileURL(path.join(repos.agentCli, "src", "index.mjs")));
const { AgentTool } = await import(pathToFileURL(path.join(repoRoot, "src", "index.mjs")));

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-cli-runtime-smoke-"));
try {
  console.log("[smoke-agent-cli-runtime-integration] prepare runtime artifacts");
  const nodeInstallRoot = path.join(tempRoot, "node-runtime");
  const pythonInstallRoot = path.join(tempRoot, "python-runtime");
  const nodeDescriptor = await readDescriptor(repos.nodeRuntime);
  const pythonDescriptor = await readDescriptor(repos.pythonRuntime);

  console.log("[smoke-agent-cli-runtime-integration] expand node-runtime");
  await expandArchive(fileURLToPath(nodeDescriptor.url), nodeInstallRoot);
  console.log("[smoke-agent-cli-runtime-integration] expand python-runtime");
  await expandArchive(fileURLToPath(pythonDescriptor.url), pythonInstallRoot);

  const nodeBin = path.join(nodeInstallRoot, ...nodeDescriptor.metadata.binRelativePath.split("/"));
  const pythonBin = path.join(pythonInstallRoot, ...pythonDescriptor.metadata.binRelativePath.split("/"));

  const pythonVersion = await execFileAsync(pythonBin, ["--version"], { windowsHide: true });
  assert.match(pythonVersion.stdout.trim(), /^Python 3\.12\./);
  console.log("[smoke-agent-cli-runtime-integration] python version", pythonVersion.stdout.trim());

  const workspace = path.join(tempRoot, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  const payloads = [];
  const threadStore = createInMemoryThreadStore();
  const agentTool = new AgentTool({
    workspace,
    runtimeDependencies: [
      { type: "node-runtime", bin: nodeBin },
      { type: "python-runtime", bin: pythonBin }
    ]
  });
  const toolDiagnostics = await agentTool.diagnostics({ workspace });
  assert.equal(toolDiagnostics.checks.find((check) => check.id === "python.runtime")?.status, "pass");
  console.log("[smoke-agent-cli-runtime-integration] agent-tool python diagnostics pass");

  const agent = new AgentCli({
    env: {
      AGENT_CLI_AI_PROVIDER: "deepseek",
      AGENT_CLI_DEEPSEEK_API_KEY: "sk-test",
      AGENT_CLI_AUTO_COMPACT_ENABLED: "false"
    },
    workspace,
    threadId: "thread-node-python-runtime-smoke",
    runtimeDependencies: [{ type: "node-runtime", bin: nodeBin }],
    toolRuntime: agentTool,
    threadStore,
    fetchImpl: createMockFetch(payloads)
  });
  const cliDiagnostics = await agent.diagnostics();
  assert.equal(cliDiagnostics.checks.find((check) => check.id === "node.runtime")?.status, "pass");
  console.log("[smoke-agent-cli-runtime-integration] agent-cli node diagnostics pass");

  const events = await collectChatEvents(agent, "Use Python runtime to verify requirements.", 120_000);

  const finalText = events
    .filter((event) => event.type === "assistant_delta")
    .map((event) => event.content ?? "")
    .join("");
  const toolEnd = events.find((event) => event.type === "tool_end" && event.toolName === "run_shell");
  assert.equal(payloads[0].tools.some((tool) => tool.function?.name === "run_shell"), true);
  assert.match(toolEnd?.result ?? "", /PYTHON_RUNTIME_TOOL_OK/);
  assert.equal(finalText, "NODE_PYTHON_RUNTIME_DONE");

  await agentTool.dispose();
  agent.dispose();
  console.log("[smoke-agent-cli-runtime-integration] ok");
} finally {
  await fs.rm(tempRoot, { force: true, recursive: true });
}

async function resolveRepoPaths() {
  return {
    agentCli: process.env.AGENT_CLI_REPO || await firstExistingPath([
      "C:/Users/ddger/Documents/agent-cli-brick",
      "C:/Users/ddger/AppData/Local/Temp/agent-cli-brick-plan-inspect"
    ], "agent-cli-brick"),
    nodeRuntime: process.env.NODE_RUNTIME_REPO || await firstExistingPath([
      "C:/Users/ddger/Documents/node-runtime-brick"
    ], "node-runtime-brick"),
    pythonRuntime: process.env.PYTHON_RUNTIME_REPO || await firstExistingPath([
      "C:/Users/ddger/Documents/python-runtime-brick"
    ], "python-runtime-brick")
  };
}

// 允许测试在默认本地 clone 和显式环境变量之间切换，便于 CI 或协作者机器复用。
async function firstExistingPath(candidates, label) {
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) return candidate;
    } catch {
      // 继续尝试下一个默认路径。
    }
  }
  throw new Error(`Cannot find ${label}. Set the matching *_REPO environment variable.`);
}

async function readDescriptor(repoPath) {
  return JSON.parse(await fs.readFile(path.join(repoPath, "dist", "descriptor.local.json"), "utf8"));
}

// Windows artifact 使用 zip 交付，这里模拟 host/client-shell 的真实安装解包动作。
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

// mock 只替代 LLM provider；runtime、tool 执行、Python requirements 都走真实本地 artifact。
function createMockFetch(payloads) {
  let requestIndex = 0;
  const responses = [
    [
      `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-python-runtime","function":{"name":"run_shell","arguments":"{\\"mode\\":\\"process\\",\\"executable\\":\\"python\\",\\"args\\":[\\"-s\\",\\"-c\\",\\"import importlib, json; modules=['openpyxl','pandas','docx','fitz']; [importlib.import_module(name) for name in modules]; print('PYTHON_RUNTIME_TOOL_OK')\\"]}"}}]}}]}\n\n`,
      "data: [DONE]\n\n"
    ],
    [
      'data: {"choices":[{"delta":{"content":"NODE_PYTHON_RUNTIME_DONE"}}]}\n\n',
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

// 收集 AgentCli 的 SSE 风格事件，并用超时保护避免测试在异常流式响应里无限等待。
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

// AgentCli 需要 threadStore 合同；这里用内存实现隔离文件系统副作用。
function createInMemoryThreadStore() {
  const records = new Map();
  const threads = new Map();
  return {
    filePath: "memory://agent-cli-runtime-smoke",
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
