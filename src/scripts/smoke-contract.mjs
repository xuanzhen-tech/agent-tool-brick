import assert from "node:assert/strict";

import { validateBrickDefinition } from "@xuanzhen-tech/agent-release-foundation";

import {
  brickDefinition,
  createAgentToolLaunchConfig,
  createAgentToolManifest,
  createAgentToolRuntimeContract,
  validateAgentToolCall,
  validateAgentToolLaunchConfig,
  validateAgentToolManifest,
  validateAgentToolResult
} from "../index.mjs";
import { RUN_SHELL_TOOL } from "../main/tool-definitions.mjs";
import { createToolResult } from "../main/tool-contract.mjs";

assert.equal(brickDefinition.id, "agent-tool");
assert.equal(brickDefinition.kind, "tool");
assert.equal(brickDefinition.version, "0.1.0");
assert.equal(validateBrickDefinition(brickDefinition).ok, true);
assert.equal(brickDefinition.runtimeDependencies.some((item) => item.type === "node-runtime" && item.required === true), true);
assert.equal(brickDefinition.runtimeDependencies.some((item) => item.slot === "tool:rg" && item.required === false), true);

const launchConfig = createAgentToolLaunchConfig({ port: 8791, workspace: process.cwd(), rgBin: "rg" });
assert.equal(validateAgentToolLaunchConfig(launchConfig).ok, true);
assert.equal(launchConfig.env.AGENT_TOOL_WORKSPACE_ROOT, process.cwd());

const runtimeContract = createAgentToolRuntimeContract({ platform: "win32-x64" });
assert.equal(runtimeContract.schemaVersion, "agent-tool.runtime.v1");
assert.equal(runtimeContract.command, "agent-tool");
assert.equal(runtimeContract.runtimeDependencies.required[0].type, "node-runtime");
assert.equal(runtimeContract.runtimeDependencies.optional[0].slot, "tool:rg");

const manifest = createAgentToolManifest({
  baseUrl: "http://127.0.0.1:8791",
  tools: [RUN_SHELL_TOOL]
});
assert.equal(validateAgentToolManifest(manifest).ok, true);
assert.equal(manifest.tools[0].name, "run_shell");

assert.equal(validateAgentToolCall({
  schemaVersion: "agent-cli-tool.call.v1",
  toolCallId: "call-1",
  toolName: "run_shell",
  arguments: { mode: "process", executable: "node", args: ["--version"] }
}).ok, true);

assert.equal(validateAgentToolResult(createToolResult({
  toolCallId: "call-1",
  status: "completed",
  content: "ok"
})).ok, true);

console.log("[smoke-contract] ok");
