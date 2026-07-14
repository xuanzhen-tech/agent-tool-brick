/**
 * 直接工具执行的端到端 smoke 测试。
 *
 * fixture workspace 会在不启动 HTTP 服务的情况下，覆盖 run_shell、可选的
 * rg 搜索、通过注入 index 进行 skill 激活，以及面向模型的工具结果压缩。
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { AgentTool } from "../index.mjs";
import { resolveServiceConfig } from "../main/launch-config.mjs";
import { appendOutput, createOutputCollector, finalizeOutput } from "../main/process-runtime.mjs";
import { isRgAvailable } from "../main/search-runtime.mjs";
import { createToolRegistry } from "../main/tool-registry.mjs";

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "agent-tool-smoke-"));
await fs.writeFile(path.join(workspace, "note.txt"), "alpha\nneedle\nomega\n", "utf8");

// UTF-8 多字节字符可能被子进程拆分到多个 data chunk；解码器必须保持字符完整。
const splitUtf8Collector = createOutputCollector(64);
const helloBytes = Buffer.from("你好", "utf8");
appendOutput(splitUtf8Collector, helloBytes.subarray(0, 2));
appendOutput(splitUtf8Collector, helloBytes.subarray(2));
finalizeOutput(splitUtf8Collector);
assert.equal(splitUtf8Collector.value, "你好");
assert.equal(splitUtf8Collector.value.includes("\uFFFD"), false);

// 临时 skill index 模拟 agent-skill 产出的合同。
const skillRoot = path.join(workspace, "skills", "brief-writer");
await fs.mkdir(skillRoot, { recursive: true });
const skillFile = path.join(skillRoot, "SKILL.md");
await fs.writeFile(skillFile, "---\nname: brief-writer\ndescription: Write brief replies.\n---\n\n# Brief Writer\n\nKeep replies short.\n", "utf8");
const skillIndexPath = path.join(workspace, "agent-skill.index.json");
await fs.writeFile(skillIndexPath, JSON.stringify({
  schemaVersion: "agent-skill.index.v1",
  generatedAt: new Date().toISOString(),
  roots: [],
  skills: [
    {
      id: "brief-writer",
      name: "brief-writer",
      version: "0.1.0",
      description: "Write brief replies.",
      path: skillFile,
      source: "workspace",
      capabilities: ["writing.brief"],
      requiredTools: ["run_shell"],
      optionalTools: ["workspace_search"],
      requiredEnv: [],
      enabled: true,
      contentHash: "smoke",
      bytes: 100
    }
  ],
  diagnostics: []
}, null, 2), "utf8");
const config = {
  ...resolveServiceConfig(process.env, {
    workspaceRoot: workspace,
    skillIndexPath,
    webGatewayBaseUrl: "http://127.0.0.1:0",
    webGatewayToken: "smoke-token",
    maxTimeoutMs: 5_000,
    maxOutputBytes: 8_000,
    terminalSessionTtlMs: 3_000,
    terminalMaxSessions: 4,
    terminalMaxOutputBytes: 8_000
  })
};
const registry = await createToolRegistry(config);

const missingSession = await registry.execute({
  schemaVersion: "agent-cli-tool.call.v1",
  toolCallId: "call-missing-session",
  toolName: "write_stdin",
  arguments: { session_id: "terminal-missing", chars: "不应写入" },
  workspace: { root: workspace }
});
assert.equal(missingSession.status, "failed");
assert.equal(missingSession.error.code, "terminal_session_not_found");
assert.match(missingSession.error.message, /未验证执行成功/);

const okResult = await registry.execute({
  schemaVersion: "agent-cli-tool.call.v1",
  toolCallId: "call-node-version",
  toolName: "run_shell",
  arguments: {
    mode: "process",
    executable: process.execPath,
    args: ["-e", "console.log('agent-tool-ok')"]
  },
  workspace: { root: workspace },
  limits: { timeoutMs: 5_000, maxOutputChars: 8_000 }
});
assert.equal(okResult.status, "completed");
assert.match(okResult.content, /\[agent-tool-result-compressed\]/);
assert.equal(okResult.details.__agentToolCompression.policy, "run_shell");
assert.match(okResult.details.stdout, /agent-tool-ok/);

const nonzero = await registry.execute({
  schemaVersion: "agent-cli-tool.call.v1",
  toolCallId: "call-nonzero",
  toolName: "run_shell",
  arguments: {
    mode: "process",
    executable: process.execPath,
    args: ["-e", "process.exit(7)"]
  },
  workspace: { root: workspace },
  limits: { timeoutMs: 5_000, maxOutputChars: 8_000 }
});
assert.equal(nonzero.status, "failed");
assert.equal(nonzero.details.exitCode, 7);
assert.match(nonzero.error.message, /未验证执行成功/);

const timeout = await registry.execute({
  schemaVersion: "agent-cli-tool.call.v1",
  toolCallId: "call-timeout",
  toolName: "run_shell",
  arguments: {
    mode: "process",
    executable: process.execPath,
    args: ["-e", "setTimeout(() => {}, 3000)"],
    timeoutMs: 200
  },
  workspace: { root: workspace },
  limits: { timeoutMs: 200, maxOutputChars: 8_000 }
});
assert.equal(timeout.status, "failed");
assert.equal(timeout.details.timedOut, true);

const largeOutput = await registry.execute({
  schemaVersion: "agent-cli-tool.call.v1",
  toolCallId: "call-large-output",
  toolName: "run_shell",
  arguments: {
    mode: "process",
    executable: process.execPath,
    args: ["-e", "process.stdout.write('x'.repeat(20000))"]
  },
  workspace: { root: workspace },
  limits: { timeoutMs: 5_000, maxOutputChars: 8_000 }
});
assert.equal(largeOutput.status, "completed");
assert.match(largeOutput.details.stdout, /\[agent-tool-result-compressed\]/);
assert.match(largeOutput.content, /omittedChars/);

const empty = await registry.execute({
  schemaVersion: "agent-cli-tool.call.v1",
  toolCallId: "call-empty",
  toolName: "run_shell",
  arguments: { mode: "shell", command: "" },
  workspace: { root: workspace }
});
assert.equal(empty.status, "blocked");

// 模拟模型按照 run_shell 合同创建 outputs、以 UTF-8 写入，并在同一命令中验证产物。
assert.equal(await pathExists(path.join(workspace, "outputs")), false);
const outputWriteCommand = process.platform === "win32"
  ? "New-Item -ItemType Directory -Force -Path outputs | Out-Null; Set-Content -LiteralPath outputs/你好.txt -Value '你好' -Encoding utf8; if (-not (Test-Path -LiteralPath outputs/你好.txt)) { exit 1 }"
  : "mkdir -p outputs && printf '你好' > outputs/你好.txt && test -f outputs/你好.txt";
const outputWrite = await registry.execute({
  schemaVersion: "agent-cli-tool.call.v1",
  toolCallId: "call-output-write",
  toolName: "run_shell",
  arguments: { mode: "shell", command: outputWriteCommand },
  workspace: { root: workspace },
  limits: { timeoutMs: 5_000, maxOutputChars: 8_000 }
});
assert.equal(outputWrite.status, "completed");
assert.equal(await fs.readFile(path.join(workspace, "outputs", "你好.txt"), "utf8").then((value) => value.trim()), "你好");

const outputWriteFailure = await registry.execute({
  schemaVersion: "agent-cli-tool.call.v1",
  toolCallId: "call-output-write-failure",
  toolName: "run_shell",
  arguments: {
    mode: "process",
    executable: process.execPath,
    args: ["-e", "require('node:fs').writeFileSync('outputs', 'should-fail')"]
  },
  workspace: { root: workspace },
  limits: { timeoutMs: 5_000, maxOutputChars: 8_000 }
});
assert.equal(outputWriteFailure.status, "failed");
assert.match(outputWriteFailure.error.message, /未验证执行成功/);

const splitProcessOutput = await registry.execute({
  schemaVersion: "agent-cli-tool.call.v1",
  toolCallId: "call-split-process-output",
  toolName: "run_shell",
  arguments: {
    mode: "process",
    executable: process.execPath,
    args: ["-e", "const b=Buffer.from('你好','utf8'); process.stdout.write(b.subarray(0,2)); setTimeout(() => process.stdout.write(b.subarray(2)), 30)"]
  },
  workspace: { root: workspace },
  limits: { timeoutMs: 5_000, maxOutputChars: 8_000 }
});
assert.equal(splitProcessOutput.status, "completed");
assert.match(splitProcessOutput.details.stdout, /你好/);
assert.equal(splitProcessOutput.details.stdout.includes("\uFFFD"), false);

const terminalStart = await registry.execute({
  schemaVersion: "agent-cli-tool.call.v1",
  toolCallId: "call-terminal-start",
  toolName: "exec_command",
  arguments: {
    mode: "process",
    executable: process.execPath,
    args: ["-e", "console.log('terminal-ready'); setTimeout(() => console.log('terminal-later'), 500);"],
    yield_time_ms: 100,
    timeoutMs: 2_000
  },
  workspace: { root: workspace },
  limits: { timeoutMs: 5_000, maxOutputChars: 8_000 }
});
assert.equal(terminalStart.status, "completed");
assert.equal(terminalStart.details.running, true);
assert.ok(terminalStart.details.session_id);
await wait(700);

const terminalPoll = await registry.execute({
  schemaVersion: "agent-cli-tool.call.v1",
  toolCallId: "call-terminal-poll",
  toolName: "write_stdin",
  arguments: {
    session_id: terminalStart.details.session_id,
    chars: "",
    yield_time_ms: 100
  },
  workspace: { root: workspace },
  limits: { timeoutMs: 5_000, maxOutputChars: 8_000 }
});
assert.equal(terminalPoll.status, "completed");
assert.equal(terminalPoll.details.running, false);
assert.equal(terminalPoll.details.exitCode, 0);
assert.match(terminalPoll.details.stdout, /terminal-later/);

const splitTerminalStart = await registry.execute({
  schemaVersion: "agent-cli-tool.call.v1",
  toolCallId: "call-split-terminal-start",
  toolName: "exec_command",
  arguments: {
    mode: "process",
    executable: process.execPath,
    args: ["-e", "const out=Buffer.from('你好','utf8'); const err=Buffer.from('世界','utf8'); process.stdout.write(out.subarray(0,2)); process.stderr.write(err.subarray(0,2)); setTimeout(() => { process.stdout.write(out.subarray(2)); process.stderr.write(err.subarray(2)); process.exit(0); }, 100)"],
    yield_time_ms: 10,
    timeoutMs: 2_000
  },
  workspace: { root: workspace }
});
assert.equal(splitTerminalStart.status, "completed");
assert.equal(splitTerminalStart.details.running, true);
const splitTerminalOutput = await pollTerminalUntilClosed(registry, splitTerminalStart.details.session_id, workspace);
const splitTerminalStdout = `${splitTerminalStart.details.stdout}${splitTerminalOutput.stdout}`;
const splitTerminalStderr = `${splitTerminalStart.details.stderr}${splitTerminalOutput.stderr}`;
assert.match(splitTerminalStdout, /你好/);
assert.match(splitTerminalStderr, /世界/);
assert.equal(`${splitTerminalStdout}${splitTerminalStderr}`.includes("\uFFFD"), false);

const interactiveStart = await registry.execute({
  schemaVersion: "agent-cli-tool.call.v1",
  toolCallId: "call-interactive-start",
  toolName: "exec_command",
  arguments: {
    mode: "process",
    executable: process.execPath,
    args: ["-e", "process.stdin.setEncoding('utf8'); console.log('stdin-ready'); process.stdin.on('data', (chunk) => { console.log('echo:' + chunk.trim()); if (chunk.includes('quit')) process.exit(0); });"],
    yield_time_ms: 500,
    timeoutMs: 3_000
  },
  workspace: { root: workspace },
  limits: { timeoutMs: 5_000, maxOutputChars: 8_000 }
});
assert.equal(interactiveStart.status, "completed");
assert.equal(interactiveStart.details.running, true);

const interactiveWrite = await registry.execute({
  schemaVersion: "agent-cli-tool.call.v1",
  toolCallId: "call-interactive-write",
  toolName: "write_stdin",
  arguments: {
    session_id: interactiveStart.details.session_id,
    chars: "你好\n",
    yield_time_ms: 100
  },
  workspace: { root: workspace },
  limits: { timeoutMs: 5_000, maxOutputChars: 8_000 }
});
assert.equal(interactiveWrite.status, "completed");
assert.equal(interactiveWrite.details.running, true);
assert.match(interactiveWrite.details.stdout, /echo:你好/);

const interactiveEnd = await registry.execute({
  schemaVersion: "agent-cli-tool.call.v1",
  toolCallId: "call-interactive-end",
  toolName: "write_stdin",
  arguments: {
    session_id: interactiveStart.details.session_id,
    chars: "quit\n",
    yield_time_ms: 300
  },
  workspace: { root: workspace },
  limits: { timeoutMs: 5_000, maxOutputChars: 8_000 }
});
assert.equal(interactiveEnd.status, "completed");
assert.equal(interactiveEnd.details.running, false);
assert.match(interactiveEnd.details.stdout, /echo:quit/);

const rgAvailability = await isRgAvailable(config.rgBin);
if (rgAvailability.available && registry.has("workspace_search")) {
  const search = await registry.execute({
    schemaVersion: "agent-cli-tool.call.v1",
    toolCallId: "call-search",
    toolName: "workspace_search",
    arguments: { query: "needle", path: "." },
    workspace: { root: workspace },
    limits: { timeoutMs: 5_000, maxOutputChars: 8_000 }
  });
  assert.equal(search.status, "completed");
  assert.match(search.content, /needle/);
} else {
  console.log("[smoke-tools] rg unavailable; workspace_search skipped");
}

const skillFind = await registry.execute({
  schemaVersion: "agent-cli-tool.call.v1",
  toolCallId: "call-skill-find",
  toolName: "skill_find",
  arguments: { query: "brief", capability: "writing.brief" },
  workspace: { root: workspace }
});
assert.equal(skillFind.status, "completed");
assert.match(skillFind.content, /brief-writer/);

const remoteSkillFind = await registry.execute({
  schemaVersion: "agent-cli-tool.call.v1",
  toolCallId: "call-skill-find-remote",
  toolName: "skill_find",
  arguments: { action: "install", package: "owner/repo@skill" },
  workspace: { root: workspace }
});
assert.equal(remoteSkillFind.status, "blocked");
assert.equal(remoteSkillFind.error.code, "skill_remote_operation_unsupported");

const skillActivate = await registry.execute({
  schemaVersion: "agent-cli-tool.call.v1",
  toolCallId: "call-skill-activate",
  toolName: "skill_activate",
  arguments: { skill: "brief-writer" },
  workspace: { root: workspace }
});
assert.equal(skillActivate.status, "completed");
assert.equal(skillActivate.details.loadedSkill.name, "brief-writer");
assert.match(skillActivate.details.loadedSkill.content, /Keep replies short/);

// 注册后 index 可能被外部进程删除；这种可恢复失败必须是结构化 tool result。
await fs.rm(skillIndexPath);
const staleSkillIndex = await registry.execute({
  schemaVersion: "agent-cli-tool.call.v1",
  toolCallId: "call-stale-skill-index",
  toolName: "skill_find",
  arguments: { query: "brief" },
  workspace: { root: workspace }
});
assert.equal(staleSkillIndex.status, "failed");
assert.equal(staleSkillIndex.error.code, "tool_execution_failed");

const objectTool = new AgentTool({
  workspace,
  skillRuntime: {
    definitions: [{ name: "brief-writer", description: "Write brief replies." }],
    find: async (filter) => ({ skills: [{ name: "brief-writer", query: filter.query }] }),
    activate: async (skill) => ({ loadedSkill: { name: skill, content: "Keep replies short.", contentHash: "hash", bytes: 19 } })
  }
});
assert.equal(objectTool.definitions.some((tool) => tool.function?.name === "run_shell"), true);
assert.equal(objectTool.definitions.some((tool) => tool.function?.name === "skill_find"), true);
assert.equal(objectTool.definitions.some((tool) => tool.function?.name === "write_stdin"), false);
const objectShell = await objectTool.execute("run_shell", {
  mode: "process",
  executable: process.execPath,
  args: ["-e", "console.log(process.cwd())"]
}, { workspace });
assert.equal(objectShell.status, "completed");
assert.match(objectShell.details.cwd, new RegExp(escapeRegExp(workspace)));
const objectTerminal = await objectTool.execute("exec_command", {
  mode: "process",
  executable: process.execPath,
  args: ["-e", "setTimeout(() => process.exit(0), 120)"],
  yield_time_ms: 10,
  timeoutMs: 1_000
}, { workspace });
assert.equal(objectTerminal.details.running, true);
assert.equal(objectTool.definitions.some((tool) => tool.function?.name === "write_stdin"), true);
await waitFor(() => !objectTool.definitions.some((tool) => tool.function?.name === "write_stdin"));
assert.equal(objectTool.definitions.some((tool) => tool.function?.name === "write_stdin"), false);
const objectSkill = await objectTool.execute("skill_activate", { skill: "brief-writer" }, { workspace });
assert.equal(objectSkill.status, "completed");
assert.equal(objectSkill.details.loadedSkill.name, "brief-writer");
await objectTool.dispose();

const pythonAliasTool = new AgentTool({
  workspace,
  runtimeDependencies: [{ type: "python-runtime", bin: process.execPath }]
});
const pythonAlias = await pythonAliasTool.execute("run_shell", {
  mode: "process",
  executable: "python",
  args: ["-e", "console.log('python-alias-ok')"]
}, { workspace });
assert.equal(pythonAlias.status, "completed");
assert.match(pythonAlias.details.stdout, /python-alias-ok/);
await pythonAliasTool.dispose();

const playwrightBrowsersPath = path.join(workspace, "ms-playwright");
await fs.mkdir(path.join(playwrightBrowsersPath, "chromium-smoke"), { recursive: true });
const productNodeModulesPath = path.join(workspace, "product-node-modules");
const productPlaywrightPackageRoot = path.join(productNodeModulesPath, "playwright");
await fs.mkdir(productPlaywrightPackageRoot, { recursive: true });
await fs.writeFile(path.join(productPlaywrightPackageRoot, "package.json"), JSON.stringify({
  name: "playwright",
  version: "0.0.0-smoke",
  type: "module",
  main: "./index.cjs",
  exports: {
    ".": {
      import: "./index.mjs",
      require: "./index.cjs"
    }
  }
}, null, 2), "utf8");
await fs.writeFile(path.join(productPlaywrightPackageRoot, "index.cjs"), "exports.chromium = { source: 'product-cjs' };\n", "utf8");
await fs.writeFile(path.join(productPlaywrightPackageRoot, "index.mjs"), "export const chromium = { source: 'product-esm' };\nexport default { chromium };\n", "utf8");
const productRuntimeDir = path.join(workspace, "product-runtime");
await fs.mkdir(productRuntimeDir, { recursive: true });
await fs.writeFile(path.join(productRuntimeDir, "playwright-esm-loader.mjs"), [
  "import { pathToFileURL } from 'node:url';",
  "",
  "export async function resolve(specifier, context, nextResolve) {",
  "  if (specifier === 'playwright') {",
  "    return {",
  "      url: pathToFileURL(process.env.SMOKE_PLAYWRIGHT_ESM_ENTRY).href,",
  "      shortCircuit: true",
  "    };",
  "  }",
  "  return nextResolve(specifier, context);",
  "}"
].join("\n"), "utf8");
const productRegisterPath = path.join(productRuntimeDir, "playwright-esm-register.mjs");
await fs.writeFile(productRegisterPath, "import { register } from 'node:module';\nregister('./playwright-esm-loader.mjs', import.meta.url);\n", "utf8");
const playwrightTool = new AgentTool({
  workspace,
  runtimeDependencies: [
    {
      type: "node-package",
      id: "playwright",
      packageName: "playwright",
      nodeModulesPath: productNodeModulesPath,
      nodeImportRegisterPath: productRegisterPath,
      env: {
        SMOKE_PLAYWRIGHT_ESM_ENTRY: path.join(productPlaywrightPackageRoot, "index.mjs")
      }
    },
    { type: "playwright-browsers", browsersPath: playwrightBrowsersPath }
  ]
});
const playwrightRequire = await playwrightTool.execute("run_shell", {
  mode: "process",
  executable: process.execPath,
  args: [
    "-e",
    "const { chromium } = require('playwright'); console.log('require:' + chromium.source); console.log('browsers:' + process.env.PLAYWRIGHT_BROWSERS_PATH);"
  ]
}, { workspace });
assert.equal(playwrightRequire.status, "completed");
assert.match(playwrightRequire.details.stdout, /require:product-cjs/);
assert.match(playwrightRequire.details.stdout, new RegExp(escapeRegExp(playwrightBrowsersPath)));

const playwrightImport = await playwrightTool.execute("run_shell", {
  mode: "process",
  executable: process.execPath,
  args: [
    "--input-type=module",
    "-e",
    "import { chromium } from 'playwright'; console.log('import:' + chromium.source); console.log('browsers:' + process.env.PLAYWRIGHT_BROWSERS_PATH);"
  ]
}, { workspace });
assert.equal(playwrightImport.status, "completed");
assert.match(playwrightImport.details.stdout, /import:product-esm/);
assert.match(playwrightImport.details.stdout, new RegExp(escapeRegExp(playwrightBrowsersPath)));

const playwrightTerminal = await playwrightTool.execute("exec_command", {
  mode: "process",
  executable: process.execPath,
  args: [
    "--input-type=module",
    "-e",
    "import { chromium } from 'playwright'; console.log('terminal-import:' + chromium.source);"
  ],
  yield_time_ms: 1_000,
  timeoutMs: 3_000
}, { workspace });
assert.equal(playwrightTerminal.status, "completed");
assert.equal(playwrightTerminal.details.running, false);
assert.match(playwrightTerminal.details.stdout, /terminal-import:product-esm/);
await playwrightTool.dispose();

console.log("[smoke-tools] ok");

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 2_000, intervalMs = 25) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await wait(intervalMs);
  }
  assert.fail(`Condition was not met within ${timeoutMs}ms.`);
}

async function pollTerminalUntilClosed(registry, sessionId, workspace, maxPolls = 20) {
  let stdout = "";
  let stderr = "";
  for (let index = 0; index < maxPolls; index += 1) {
    const result = await registry.execute({
      schemaVersion: "agent-cli-tool.call.v1",
      toolCallId: `call-terminal-poll-${index}`,
      toolName: "write_stdin",
      arguments: { session_id: sessionId, chars: "", yield_time_ms: 50 },
      workspace: { root: workspace }
    });
    assert.equal(result.status, "completed");
    stdout += result.details.stdout;
    stderr += result.details.stderr;
    if (!result.details.running) return { stdout, stderr };
  }
  assert.fail("Persistent terminal did not finish within the polling budget.");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}
