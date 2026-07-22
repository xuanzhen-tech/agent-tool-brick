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
import {
  EMAIL_SEND_TOOL,
  EXEC_COMMAND_TOOL,
  IMAGE_PRESENT_TOOL,
  RUN_SHELL_TOOL,
  SKILL_FIND_TOOL,
  SKILL_RESOURCE_TOOL,
  WRITE_STDIN_TOOL
} from "../main/tool-definitions.mjs";
import { createToolResult } from "../main/tool-contract.mjs";

assert.equal(brickDefinition.id, "agent-tool");
assert.equal(brickDefinition.kind, "tool");
assert.equal(brickDefinition.version, "0.4.2");
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
assert.equal(brickDefinition.capabilities.some((item) => item.id === "agent-tool.image-present"), true);
assert.equal(brickDefinition.capabilities.some((item) => item.id === "agent-tool.python-runtime"), true);
assert.equal(brickDefinition.capabilities.some((item) => item.id === "agent-tool.node-package-runtime"), true);
assert.equal(brickDefinition.capabilities.some((item) => item.id === "agent-tool.playwright-browsers-env"), true);
assert.equal(brickDefinition.capabilities.some((item) => item.id === "agent-tool.data-visualization"), true);
assert.equal(brickDefinition.capabilities.some((item) => item.id === "agent-tool.structured-dashboard"), true);
assert.equal(brickDefinition.capabilities.some((item) => item.id === "agent-tool.provider-composition"), true);

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
assert.equal(agentTool.definitions.some((tool) => tool.function?.name === "exec_command"), true);
assert.equal(agentTool.definitions.some((tool) => tool.function?.name === "write_stdin"), false);
assert.equal(agentTool.definitions.some((tool) => tool.function?.name === "workspace_search"), true);
assert.equal(agentTool.definitions.some((tool) => tool.function?.name === "skill_find"), true);
assert.equal(agentTool.definitions.some((tool) => tool.function?.name === "skill_activate"), true);
assert.equal(agentTool.definitions.some((tool) => tool.function?.name === "skill_resource"), false);
assert.equal(agentTool.definitions.some((tool) => tool.function?.name === "visualization_create_chart"), false);
assert.equal(agentTool.definitions.some((tool) => tool.function?.name === "visualization_create_dashboard"), false);
assert.equal((await agentTool.execute("skill_find", JSON.stringify({ query: "demo" }))).details.skills[0].name, "demo");
await agentTool.dispose();

// 新增预制工具必须由产品显式选择，不能改变既有 new AgentTool() 的模型工具面。
const selectedTool = new AgentTool({
  workspace: process.cwd(),
  tools: ["run_shell", "visualization_create_chart", "visualization_create_dashboard"]
});
assert.deepEqual(
  selectedTool.definitions.map((tool) => tool.function?.name).sort(),
  ["run_shell", "visualization_create_chart", "visualization_create_dashboard"].sort()
);
await selectedTool.dispose();

const provider = {
  id: "contract-provider",
  toolDescriptors: [{
    name: "provider_echo",
    description: "Provider contract echo.",
    schema: {
      type: "function",
      function: {
        name: "provider_echo",
        description: "Provider contract echo.",
        parameters: { type: "object", additionalProperties: false }
      }
    },
    permissions: [],
    timeoutMs: 5_000,
    cancelable: true
  }],
  async execute(name, args) {
    return { status: "completed", content: JSON.stringify({ name, args }), details: { name, args } };
  }
};
const providerTool = new AgentTool({
  workspace: process.cwd(),
  tools: ["provider_echo"],
  toolProviders: [provider]
});
assert.equal(providerTool.definitions.some((tool) => tool.function?.name === "provider_echo"), true);
assert.equal((await providerTool.execute("provider_echo", { value: "ok" })).details.name, "provider_echo");
await providerTool.dispose();

const playwrightAwareTool = new AgentTool({
  workspace: process.cwd(),
  runtimeDependencies: [
    { type: "node-package", packageName: "playwright", nodeModulesPath: "C:/product/node_modules" },
    { type: "playwright-browsers", browsersPath: "C:/runtime/ms-playwright" }
  ]
});
const playwrightShellSchema = playwrightAwareTool.definitions.find((tool) => tool.function?.name === "run_shell");
assert.match(playwrightShellSchema.function.description, /产品注入的 Node 包.*playwright/);
assert.match(playwrightShellSchema.function.description, /PLAYWRIGHT_BROWSERS_PATH/);
await playwrightAwareTool.dispose();

assert.deepEqual(SKILL_FIND_TOOL.schema.function.parameters.properties.action.enum, ["search", "install"]);
assert.equal(SKILL_FIND_TOOL.schema.function.parameters.properties.package.type, "string");
assert.equal(SKILL_FIND_TOOL.timeoutMs, 300_000);
assert.deepEqual(SKILL_RESOURCE_TOOL.schema.function.parameters.required, ["action", "skill", "path"]);
assert.equal(SKILL_RESOURCE_TOOL.schema.function.parameters.additionalProperties, false);
assert.deepEqual(SKILL_RESOURCE_TOOL.schema.function.parameters.properties.action.enum, ["read_reference", "copy_asset"]);
assert.equal("destination" in SKILL_RESOURCE_TOOL.schema.function.parameters.properties, false);
assert.equal(EMAIL_SEND_TOOL.schema.function.parameters.required.includes("to"), true);
assert.equal(EMAIL_SEND_TOOL.schema.function.parameters.required.includes("subject"), true);
assert.deepEqual(IMAGE_PRESENT_TOOL.schema.function.parameters.required, ["path"]);
assert.equal(IMAGE_PRESENT_TOOL.schema.function.parameters.additionalProperties, false);
assert.match(IMAGE_PRESENT_TOOL.description, /视觉模型/);
assert.match(IMAGE_PRESENT_TOOL.description, /workspace 相对路径/);

const manifest = createAgentToolManifest({
  baseUrl: "http://127.0.0.1:8791",
  tools: [RUN_SHELL_TOOL, EXEC_COMMAND_TOOL, WRITE_STDIN_TOOL]
});
assert.equal(validateAgentToolManifest(manifest).ok, true);
assert.equal(manifest.tools[0].name, "run_shell");
assert.equal(manifest.tools.some((tool) => tool.name === "exec_command"), true);
assert.equal(manifest.tools.some((tool) => tool.name === "write_stdin"), true);

const expectedShellExecutable = process.platform === "win32" ? "powershell.exe" : "/bin/bash";
assert.equal(RUN_SHELL_TOOL.schema.function.description.includes("当前操作系统："), true);
assert.equal(RUN_SHELL_TOOL.schema.function.description.includes(expectedShellExecutable), true);
assert.equal(RUN_SHELL_TOOL.schema.function.description.includes("workspace 已作为子进程 cwd 设置，但不是环境变量"), true);
assert.equal(RUN_SHELL_TOOL.schema.function.description.includes("$env:WORKSPACE、%WORKSPACE% 或 $WORKSPACE"), true);
assert.equal(EXEC_COMMAND_TOOL.schema.function.description.includes("outputs/about.txt"), true);
assert.equal(RUN_SHELL_TOOL.schema.function.parameters.properties.mode.description.includes(expectedShellExecutable), true);
assert.match(RUN_SHELL_TOOL.schema.function.description, /默认/);
assert.match(RUN_SHELL_TOOL.description, /outputs\//);
assert.match(RUN_SHELL_TOOL.description, /UTF-8/);
assert.match(RUN_SHELL_TOOL.description, /验证目标文件存在/);
assert.match(RUN_SHELL_TOOL.description, /不得擅自添加标点/);
assert.equal(EXEC_COMMAND_TOOL.schema.function.description.includes("当前操作系统："), true);
assert.equal(EXEC_COMMAND_TOOL.schema.function.description.includes(expectedShellExecutable), true);
assert.equal(EXEC_COMMAND_TOOL.schema.function.parameters.properties.cmd.description.includes(expectedShellExecutable), true);
assert.match(EXEC_COMMAND_TOOL.description, /不要用它执行普通短命令/);
assert.match(WRITE_STDIN_TOOL.description, /不是文件写入工具/);
assert.match(WRITE_STDIN_TOOL.description, /仍在运行的 session_id/);

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

// skill 正文由 AgentCli 提升为跨轮专门上下文。即便正文已经超过普通工具结果
// 的压缩阈值，HTTP 工具层也必须完整保留，不能让 CLI 只拿到 head/tail 摘要。
const referenceContent = "reference-line\n".repeat(10_000);
const promotedReference = compressToolExecutionResult({
  toolName: "skill_resource",
  toolCallId: "call-skill-reference",
  result: {
    status: "completed",
    content: JSON.stringify({ status: "completed" }),
    details: {
      loadedSkillReference: {
        skillName: "demo-skill",
        path: "references/large.md",
        content: referenceContent,
        contentHash: "test-reference-hash",
        bytes: Buffer.byteLength(referenceContent, "utf8")
      }
    }
  }
});
assert.equal(promotedReference.changed, false);
assert.equal(promotedReference.metadata.reason, "promoted_skill_context");
assert.equal(promotedReference.result.details.loadedSkillReference.content, referenceContent);

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
