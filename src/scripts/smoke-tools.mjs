/**
 * End-to-end smoke test for direct tool execution.
 *
 * The fixture workspace exercises run_shell, optional rg-backed search,
 * skill activation from an injected index, and compression of model-facing tool
 * results without starting the HTTP server.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveServiceConfig } from "../main/launch-config.mjs";
import { isRgAvailable } from "../main/search-runtime.mjs";
import { createToolRegistry } from "../main/tool-registry.mjs";

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "agent-tool-smoke-"));
await fs.writeFile(path.join(workspace, "note.txt"), "alpha\nneedle\nomega\n", "utf8");

// The temporary skill index mimics the contract produced by agent-skill.
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
    maxOutputBytes: 8_000
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

console.log("[smoke-tools] ok");
