/**
 * agent-tool 的公开积木定义。
 *
 * 这个定义是面向 baseLine、产品仓库和发布工具的合同。它声明
 * 当前积木提供哪些能力、依赖哪些运行时，以及对象化 SDK 的最小配置面。
 * HTTP 服务模式仍有独立 runtime contract，但不再污染产品主构造函数。
 */

import {
  createBrickCapability,
  createBrickDefinition,
  validateBrickDefinition
} from "@xuanzhen-tech/agent-release-foundation";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BRICK_ID = "agent-tool";
const BRICK_NAME = "Agent Tool";
const BRICK_VERSION = "0.2.0";
const BRICK_KIND = "tool";

const toolServiceCapability = createBrickCapability({
  id: "agent-tool.service",
  name: "Agent Tool Service",
  type: "api",
  description: "Exposes a local HTTP tool manifest, diagnostics endpoint, tool call endpoint, and cancel endpoint.",
  requires: ["node-runtime"]
});

const shellCapability = createBrickCapability({
  id: "agent-tool.run-shell",
  name: "Run Shell Tool",
  type: "tool",
  description: "Executes focused shell or argv-style process commands with cwd, timeout, cancel, and output limits.",
  requires: ["node-runtime"]
});

const terminalCapability = createBrickCapability({
  id: "agent-tool.terminal-session",
  name: "Terminal Session Tools",
  type: "tool",
  description: "Starts persistent terminal sessions and writes stdin or polls output without blocking the agent turn.",
  requires: ["node-runtime"]
});

const workspaceSearchCapability = createBrickCapability({
  id: "agent-tool.workspace-search",
  name: "Workspace Search Tool",
  type: "tool",
  description: "Searches workspace text through an injected rg tool runtime when available.",
  requires: ["node-runtime", "tool:rg"],
  optional: true
});

const skillToolsCapability = createBrickCapability({
  id: "agent-tool.skill-tools",
  name: "Skill Discovery And Activation Tools",
  type: "tool",
  description: "Finds skills and returns loadedSkill activation payloads through an injected AgentSkill object.",
  requires: ["node-runtime", "agent-skill"],
  optional: true
});

const webToolsCapability = createBrickCapability({
  id: "agent-tool.web",
  name: "Web Search And Fetch Tools",
  type: "tool",
  description: "Searches and fetches public web content through configured Tavily or generic web gateway providers.",
  requires: ["node-runtime", "web-provider"],
  optional: true
});

const pythonRuntimeCapability = createBrickCapability({
  id: "agent-tool.python-runtime",
  name: "Python Runtime Binding",
  type: "runtime",
  description: "Consumes an injected python-runtime executable for Python-backed local tools and smoke checks.",
  requires: ["node-runtime", "python-runtime"],
  optional: true
});

export const brickDefinition = createBrickDefinition({
  id: BRICK_ID,
  name: BRICK_NAME,
  version: BRICK_VERSION,
  kind: BRICK_KIND,
  description: "Independent agent tool execution brick with a stable local service and packaging boundary.",
  entrypoints: [
    {
      name: "agent-tool",
      type: "cli",
      description: "Host-facing command entrypoint. Supports serve, health, diagnostics, manifest, call, and version commands."
    },
    {
      name: "AgentTool",
      type: "api",
      description: "SDK class for composing agent-tool directly into AgentCli."
    },
    {
      name: "createAgentToolLaunchConfig",
      type: "api",
      description: "SDK helper for host launchers to build a launch config for agent-tool."
    },
    {
      name: "validateAgentToolLaunchConfig",
      type: "api",
      description: "SDK helper for validating launch config before spawning agent-tool."
    },
    {
      name: "createAgentToolManifest",
      type: "api",
      description: "SDK helper for building the agent-cli-compatible tool manifest."
    },
    {
      name: "validateAgentToolManifest",
      type: "api",
      description: "SDK helper for validating tool manifest shape."
    }
  ],
  capabilities: [
    toolServiceCapability,
    shellCapability,
    terminalCapability,
    workspaceSearchCapability,
    skillToolsCapability,
    webToolsCapability,
    pythonRuntimeCapability
  ],
  configSchema: {
    type: "object",
    properties: {
      workspace: { type: "string" }
    }
  },
  runtimeDependencies: [
    {
      type: "node-runtime",
      required: true,
      injectedEnv: "AGENT_TOOL_NODE_BIN"
    },
    {
      type: "tool",
      slot: "tool:rg",
      id: "rg",
      version: "15.1.0",
      required: false,
      injectedEnv: "AGENT_TOOL_RG_BIN"
    },
    {
      type: "python-runtime",
      required: false,
      injectedEnv: "AGENT_TOOL_PYTHON_BIN"
    }
  ]
});

const validation = validateBrickDefinition(brickDefinition);
if (!validation.ok) {
  throw new Error(`Invalid brick definition: ${validation.errors.join("; ")}`);
}

const isDirectRun = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isDirectRun) {
  console.log("brick.id", brickDefinition.id);
  console.log("brick.version", brickDefinition.version);
  console.log("brick.capabilities", brickDefinition.capabilities.map((capability) => capability.id).join(", "));
}
