/**
 * Public brick definition for agent-tool.
 *
 * The definition is the baseLine-facing contract used by product repositories
 * and release tooling. It declares what this brick can do, which runtime
 * dependencies it needs, and which configuration knobs host launchers may set.
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
const BRICK_VERSION = "0.1.1";
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
  description: "Finds indexed skills and returns loadedSkill activation payloads from an injected agent-skill index.",
  requires: ["node-runtime", "agent-skill:index"],
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
      description: "CLI entry. Supports serve, health, diagnostics, manifest, call, and version commands."
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
    webToolsCapability
  ],
  configSchema: {
    type: "object",
    properties: {
      host: { type: "string" },
      port: { type: "integer", minimum: 1, maximum: 65535 },
      workspace: { type: "string" },
      nodeBin: { type: "string" },
      rgBin: { type: "string" },
      skillIndexPath: { type: "string" },
      tavilyApiKey: { type: "string" },
      webGatewayBaseUrl: { type: "string" },
      webGatewayToken: { type: "string" },
      webMaxResults: { type: "integer", minimum: 1 },
      processExecEnabled: { type: "boolean" },
      maxTimeoutMs: { type: "integer", minimum: 1 },
      maxOutputBytes: { type: "integer", minimum: 1 },
      terminalSessionTtlMs: { type: "integer", minimum: 1 },
      terminalMaxSessions: { type: "integer", minimum: 1 },
      terminalMaxOutputBytes: { type: "integer", minimum: 1 }
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
