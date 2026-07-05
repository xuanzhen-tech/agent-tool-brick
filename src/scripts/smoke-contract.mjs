/**
 * Smoke-test the public SDK and brick metadata contract.
 *
 * This script verifies launch config, manifest validation, tool-call/result
 * schemas, and result compression without starting the HTTP server.
 */

import assert from "node:assert/strict";

import { validateBrickDefinition } from "@xuanzhen-tech/agent-release-foundation";

import {
  brickDefinition,
  createAgentToolLaunchConfig,
  createAgentToolManifest,
  createAgentToolRuntimeContract,
  compressToolExecutionResult,
  TOOL_RESULT_COMPRESSION_MARKER,
  validateAgentToolCall,
  validateAgentToolLaunchConfig,
  validateAgentToolManifest,
  validateAgentToolResult
} from "../index.mjs";
import { EXEC_COMMAND_TOOL, RUN_SHELL_TOOL, WRITE_STDIN_TOOL } from "../main/tool-definitions.mjs";
import { createToolResult } from "../main/tool-contract.mjs";

assert.equal(brickDefinition.id, "agent-tool");
assert.equal(brickDefinition.kind, "tool");
assert.equal(brickDefinition.version, "0.1.1");
assert.equal(validateBrickDefinition(brickDefinition).ok, true);
assert.equal(brickDefinition.runtimeDependencies.some((item) => item.type === "node-runtime" && item.required === true), true);
assert.equal(brickDefinition.runtimeDependencies.some((item) => item.slot === "tool:rg" && item.required === false), true);
assert.equal(brickDefinition.capabilities.some((item) => item.id === "agent-tool.terminal-session"), true);
assert.equal(brickDefinition.capabilities.some((item) => item.id === "agent-tool.skill-tools"), true);
assert.equal(brickDefinition.capabilities.some((item) => item.id === "agent-tool.web"), true);

const launchConfig = createAgentToolLaunchConfig({ port: 8791, workspace: process.cwd(), rgBin: "rg" });
assert.equal(validateAgentToolLaunchConfig(launchConfig).ok, true);
assert.equal(launchConfig.env.AGENT_TOOL_WORKSPACE_ROOT, process.cwd());

const runtimeContract = createAgentToolRuntimeContract({ platform: "win32-x64" });
assert.equal(runtimeContract.schemaVersion, "agent-tool.runtime.v1");
assert.equal(runtimeContract.command, "agent-tool");
assert.equal(runtimeContract.env.resultCompression, "AGENT_TOOL_RESULT_COMPRESSION");
assert.equal(runtimeContract.env.terminalSessionTtlMs, "AGENT_TOOL_TERMINAL_SESSION_TTL_MS");
assert.equal(runtimeContract.runtimeDependencies.required[0].type, "node-runtime");
assert.equal(runtimeContract.runtimeDependencies.optional[0].slot, "tool:rg");

const manifest = createAgentToolManifest({
  baseUrl: "http://127.0.0.1:8791",
  tools: [RUN_SHELL_TOOL, EXEC_COMMAND_TOOL, WRITE_STDIN_TOOL]
});
assert.equal(validateAgentToolManifest(manifest).ok, true);
assert.equal(manifest.tools[0].name, "run_shell");
assert.equal(manifest.tools.some((tool) => tool.name === "exec_command"), true);
assert.equal(manifest.tools.some((tool) => tool.name === "write_stdin"), true);

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

const compressed = compressToolExecutionResult({
  toolName: "run_shell",
  toolCallId: "call-1",
  result: {
    status: "completed",
    content: JSON.stringify({
      exitCode: 0,
      stdout: "hello",
      stderr: "",
      cwd: process.cwd()
    }),
    details: {
      exitCode: 0,
      stdout: "hello",
      stderr: "",
      cwd: process.cwd()
    }
  }
});
assert.equal(compressed.changed, true);
assert.match(compressed.result.content, new RegExp(TOOL_RESULT_COMPRESSION_MARKER.replaceAll("[", "\\[").replaceAll("]", "\\]")));
assert.equal(compressed.result.details.__agentToolCompression.policy, "run_shell");

const disabled = compressToolExecutionResult({
  toolName: "run_shell",
  toolCallId: "call-2",
  compressionEnabled: false,
  result: {
    status: "completed",
    content: "raw",
    details: { stdout: "raw", stderr: "" }
  }
});
assert.equal(disabled.changed, false);
assert.equal(disabled.result.content, "raw");

console.log("[smoke-contract] ok");
