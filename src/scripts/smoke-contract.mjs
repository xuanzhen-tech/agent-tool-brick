/**
 * smoke 测试公开 SDK 和积木元数据合同。
 *
 * 本脚本在不启动 HTTP 服务的情况下，验证启动配置、manifest 校验、
 * 工具调用/结果 schema，以及结果压缩能力。
 */

import assert from "node:assert/strict";

import { validateBrickDefinition } from "@xuanzhen-tech/agent-release-foundation";

import {
  AgentTool,
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
import { EMAIL_SEND_TOOL, EXEC_COMMAND_TOOL, RUN_SHELL_TOOL, SKILL_FIND_TOOL, WRITE_STDIN_TOOL } from "../main/tool-definitions.mjs";
import { createToolResult } from "../main/tool-contract.mjs";

assert.equal(brickDefinition.id, "agent-tool");
assert.equal(brickDefinition.kind, "tool");
assert.equal(brickDefinition.version, "0.2.4");
assert.equal(validateBrickDefinition(brickDefinition).ok, true);
assert.equal(brickDefinition.runtimeDependencies.some((item) => item.type === "node-runtime" && item.required === true), true);
assert.equal(brickDefinition.runtimeDependencies.some((item) => item.slot === "tool:rg" && item.required === false), true);
assert.equal(brickDefinition.runtimeDependencies.some((item) => item.type === "python-runtime" && item.required === false), true);
assert.equal(brickDefinition.runtimeDependencies.some((item) => item.type === "node-package" && item.required === false), true);
assert.equal(brickDefinition.runtimeDependencies.some((item) => item.type === "playwright-browsers" && item.required === false), true);
assert.equal(brickDefinition.capabilities.some((item) => item.id === "agent-tool.terminal-session"), true);
assert.equal(brickDefinition.capabilities.some((item) => item.id === "agent-tool.skill-tools"), true);
assert.equal(brickDefinition.capabilities.some((item) => item.id === "agent-tool.web"), true);
assert.equal(brickDefinition.capabilities.some((item) => item.id === "agent-tool.email"), true);
assert.equal(brickDefinition.capabilities.some((item) => item.id === "agent-tool.python-runtime"), true);
assert.equal(brickDefinition.capabilities.some((item) => item.id === "agent-tool.node-package-runtime"), true);
assert.equal(brickDefinition.capabilities.some((item) => item.id === "agent-tool.playwright-browsers-env"), true);

const launchConfig = createAgentToolLaunchConfig({
  port: 8791,
  workspace: process.cwd(),
  runtimeDependencies: [
    { type: "tool", slot: "tool:rg", id: "rg", bin: "rg" },
    { type: "python-runtime", bin: "python" },
    {
      type: "node-package",
      id: "playwright",
      packageName: "playwright",
      nodeModulesPath: "C:/product/node_modules",
      nodeImportRegisterPath: "C:/product/src/main/runtime/playwright-esm-register.mjs"
    },
    { type: "playwright-browsers", slot: "playwright-browsers", browsersPath: "C:/runtime/ms-playwright" }
  ]
});
assert.equal(validateAgentToolLaunchConfig(launchConfig).ok, true);
assert.equal(launchConfig.env.AGENT_TOOL_WORKSPACE_ROOT, process.cwd());
assert.equal(launchConfig.env.AGENT_TOOL_PYTHON_BIN, "python");
assert.equal(launchConfig.env.PLAYWRIGHT_BROWSERS_PATH, "C:/runtime/ms-playwright");
assert.equal(launchConfig.env.AGENT_TOOL_PLAYWRIGHT_BROWSERS_PATH, "C:/runtime/ms-playwright");
assert.equal(launchConfig.env.AGENT_TOOL_NODE_PACKAGE_PATHS, "C:/product/node_modules");
assert.equal(launchConfig.env.AGENT_TOOL_NODE_IMPORT_REGISTERS, "C:/product/src/main/runtime/playwright-esm-register.mjs");

const runtimeContract = createAgentToolRuntimeContract({ platform: "win32-x64" });
assert.equal(runtimeContract.schemaVersion, "agent-tool.runtime.v1");
assert.equal(runtimeContract.command, "agent-tool");
assert.equal(runtimeContract.env.resultCompression, "AGENT_TOOL_RESULT_COMPRESSION");
assert.equal(runtimeContract.env.terminalSessionTtlMs, "AGENT_TOOL_TERMINAL_SESSION_TTL_MS");
assert.equal(runtimeContract.env.pythonBin, "AGENT_TOOL_PYTHON_BIN");
assert.equal(runtimeContract.env.playwrightBrowsersPath, "PLAYWRIGHT_BROWSERS_PATH");
assert.equal(runtimeContract.env.nodePackagePaths, "AGENT_TOOL_NODE_PACKAGE_PATHS");
assert.equal(runtimeContract.env.nodeImportRegisterPaths, "AGENT_TOOL_NODE_IMPORT_REGISTERS");
assert.equal(runtimeContract.env.toolGatewayBaseUrl, "AGENT_TOOL_GATEWAY_BASE_URL");
assert.equal(runtimeContract.runtimeDependencies.required[0].type, "node-runtime");
assert.equal(runtimeContract.runtimeDependencies.optional[0].slot, "tool:rg");
assert.equal(runtimeContract.runtimeDependencies.optional.some((item) => item.type === "python-runtime"), true);
assert.equal(runtimeContract.runtimeDependencies.optional.some((item) => item.type === "node-package"), true);
assert.equal(runtimeContract.runtimeDependencies.optional.some((item) => item.type === "playwright-browsers"), true);

const agentTool = new AgentTool({
  workspace: process.cwd(),
  runtimeDependencies: [{ type: "tool", slot: "tool:rg", id: "rg", bin: "rg" }],
  skillRuntime: {
    definitions: [{ name: "demo", description: "Demo skill" }],
    find: async () => ({ skills: [{ name: "demo" }] }),
    activate: async () => ({ loadedSkill: { name: "demo", content: "demo", contentHash: "hash", bytes: 4 } })
  }
});
assert.equal(agentTool.definition.id, "agent-tool");
assert.equal(agentTool.definitions.some((tool) => tool.function?.name === "run_shell"), true);
assert.equal(agentTool.definitions.some((tool) => tool.function?.name === "workspace_search"), true);
assert.equal(agentTool.definitions.some((tool) => tool.function?.name === "skill_find"), true);
assert.equal(agentTool.definitions.some((tool) => tool.function?.name === "skill_activate"), true);
assert.equal((await agentTool.execute("skill_find", JSON.stringify({ query: "demo" }))).details.skills[0].name, "demo");
await agentTool.dispose();

const playwrightAwareTool = new AgentTool({
  workspace: process.cwd(),
  runtimeDependencies: [
    { type: "node-package", packageName: "playwright", nodeModulesPath: "C:/product/node_modules" },
    { type: "playwright-browsers", browsersPath: "C:/runtime/ms-playwright" }
  ]
});
const playwrightShellSchema = playwrightAwareTool.definitions.find((tool) => tool.function?.name === "run_shell");
assert.match(playwrightShellSchema.function.description, /Product-injected Node packages.*playwright/);
assert.match(playwrightShellSchema.function.description, /PLAYWRIGHT_BROWSERS_PATH/);
await playwrightAwareTool.dispose();

assert.deepEqual(SKILL_FIND_TOOL.schema.function.parameters.properties.action.enum, ["search", "install"]);
assert.equal(SKILL_FIND_TOOL.schema.function.parameters.properties.package.type, "string");
assert.equal(SKILL_FIND_TOOL.timeoutMs, 300_000);
assert.equal(EMAIL_SEND_TOOL.schema.function.parameters.required.includes("to"), true);
assert.equal(EMAIL_SEND_TOOL.schema.function.parameters.required.includes("subject"), true);

const manifest = createAgentToolManifest({
  baseUrl: "http://127.0.0.1:8791",
  tools: [RUN_SHELL_TOOL, EXEC_COMMAND_TOOL, WRITE_STDIN_TOOL]
});
assert.equal(validateAgentToolManifest(manifest).ok, true);
assert.equal(manifest.tools[0].name, "run_shell");
assert.equal(manifest.tools.some((tool) => tool.name === "exec_command"), true);
assert.equal(manifest.tools.some((tool) => tool.name === "write_stdin"), true);

const expectedShellExecutable = process.platform === "win32" ? "powershell.exe" : "/bin/bash";
assert.equal(RUN_SHELL_TOOL.schema.function.description.includes("Current OS:"), true);
assert.equal(RUN_SHELL_TOOL.schema.function.description.includes(expectedShellExecutable), true);
assert.equal(RUN_SHELL_TOOL.schema.function.parameters.properties.mode.description.includes(expectedShellExecutable), true);
assert.equal(EXEC_COMMAND_TOOL.schema.function.description.includes("Current OS:"), true);
assert.equal(EXEC_COMMAND_TOOL.schema.function.description.includes(expectedShellExecutable), true);
assert.equal(EXEC_COMMAND_TOOL.schema.function.parameters.properties.cmd.description.includes(expectedShellExecutable), true);

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
