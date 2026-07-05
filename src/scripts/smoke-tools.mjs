import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveServiceConfig } from "../main/launch-config.mjs";
import { isRgAvailable } from "../main/search-runtime.mjs";
import { createToolRegistry } from "../main/tool-registry.mjs";

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "agent-tool-smoke-"));
await fs.writeFile(path.join(workspace, "note.txt"), "alpha\nneedle\nomega\n", "utf8");
const config = {
  ...resolveServiceConfig(process.env, {
    workspaceRoot: workspace,
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

console.log("[smoke-tools] ok");
