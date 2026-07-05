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
import { isRgAvailable } from "../main/search-runtime.mjs";
import { createToolRegistry } from "../main/tool-registry.mjs";

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "agent-tool-smoke-"));
await fs.writeFile(path.join(workspace, "note.txt"), "alpha\nneedle\nomega\n", "utf8");

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
    chars: "hello\n",
    yield_time_ms: 100
  },
  workspace: { root: workspace },
  limits: { timeoutMs: 5_000, maxOutputChars: 8_000 }
});
assert.equal(interactiveWrite.status, "completed");
assert.equal(interactiveWrite.details.running, true);
assert.match(interactiveWrite.details.stdout, /echo:hello/);

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

const objectTool = new AgentTool({
  workspace,
  processExecEnabled: true,
  maxTimeoutMs: 5_000,
  maxOutputBytes: 8_000,
  skillRuntime: {
    definitions: [{ name: "brief-writer", description: "Write brief replies." }],
    find: async (filter) => ({ skills: [{ name: "brief-writer", query: filter.query }] }),
    activate: async (skill) => ({ loadedSkill: { name: skill, content: "Keep replies short.", contentHash: "hash", bytes: 19 } })
  }
});
assert.equal(objectTool.definitions.some((tool) => tool.function?.name === "run_shell"), true);
assert.equal(objectTool.definitions.some((tool) => tool.function?.name === "skill_find"), true);
const objectShell = await objectTool.execute("run_shell", {
  mode: "process",
  executable: process.execPath,
  args: ["-e", "console.log(process.cwd())"]
}, { workspace });
assert.equal(objectShell.status, "completed");
assert.match(objectShell.details.cwd, new RegExp(escapeRegExp(workspace)));
const objectSkill = await objectTool.execute("skill_activate", { skill: "brief-writer" }, { workspace });
assert.equal(objectSkill.status, "completed");
assert.equal(objectSkill.details.loadedSkill.name, "brief-writer");
await objectTool.dispose();

console.log("[smoke-tools] ok");

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
