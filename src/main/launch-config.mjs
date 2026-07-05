import { brickDefinition } from "../brick-definition.mjs";
import { firstNonEmpty, parseBoolean, parsePositiveInteger } from "./env.mjs";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8791;
const DEFAULT_MAX_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

export function createAgentToolLaunchConfig(input = {}) {
  const host = input.host ?? DEFAULT_HOST;
  const port = normalizePort(input.port ?? DEFAULT_PORT);
  const env = {};

  setEnv(env, "AGENT_TOOL_HOST", host);
  setEnv(env, "AGENT_TOOL_PORT", String(port));
  setEnv(env, "AGENT_TOOL_WORKSPACE_ROOT", input.workspace);
  setEnv(env, "AGENT_TOOL_NODE_BIN", input.nodeBin);
  setEnv(env, "AGENT_TOOL_RG_BIN", input.rgBin);
  setEnv(env, "AGENT_TOOL_TOKEN", input.token);

  if (input.processExecEnabled !== undefined) {
    setEnv(env, "AGENT_TOOL_PROCESS_EXEC_ENABLED", input.processExecEnabled ? "true" : "false");
  }
  if (input.maxTimeoutMs !== undefined) {
    setEnv(env, "AGENT_TOOL_MAX_TIMEOUT_MS", String(input.maxTimeoutMs));
  }
  if (input.maxOutputBytes !== undefined) {
    setEnv(env, "AGENT_TOOL_MAX_OUTPUT_BYTES", String(input.maxOutputBytes));
  }
  if (input.resultCompressionEnabled !== undefined) {
    setEnv(env, "AGENT_TOOL_RESULT_COMPRESSION", input.resultCompressionEnabled ? "true" : "false");
  }

  return {
    command: "agent-tool",
    args: ["serve", "--host", host, "--port", String(port)],
    env,
    endpoint: `http://${host}:${port}`,
    manifestUrl: `http://${host}:${port}/api/tools/manifest`
  };
}

export function validateAgentToolLaunchConfig(config) {
  const errors = [];
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return { ok: false, errors: ["launch config must be an object"] };
  }
  if (config.command !== "agent-tool") errors.push("command must be agent-tool");
  if (!Array.isArray(config.args)) errors.push("args must be an array");
  if (!config.endpoint || typeof config.endpoint !== "string") errors.push("endpoint must be a string");
  if (config.env !== undefined && (!config.env || typeof config.env !== "object" || Array.isArray(config.env))) {
    errors.push("env must be an object when provided");
  }
  return { ok: errors.length === 0, errors, value: errors.length === 0 ? config : undefined };
}

export function createAgentToolRuntimeContract(input = {}) {
  const platform = input.platform ?? "win32-x64";
  return {
    schemaVersion: "agent-tool.runtime.v1",
    brickId: brickDefinition.id,
    version: brickDefinition.version,
    platform,
    command: "agent-tool",
    args: ["serve"],
    endpoints: {
      health: "/api/health",
      manifest: "/api/tools/manifest",
      diagnostics: "/api/tools/diagnostics",
      call: "/api/tools/call",
      cancel: "/api/tools/cancel"
    },
    env: {
      host: "AGENT_TOOL_HOST",
      port: "AGENT_TOOL_PORT",
      token: "AGENT_TOOL_TOKEN",
      workspaceRoot: "AGENT_TOOL_WORKSPACE_ROOT",
      nodeBin: "AGENT_TOOL_NODE_BIN",
      rgBin: "AGENT_TOOL_RG_BIN",
      processExecEnabled: "AGENT_TOOL_PROCESS_EXEC_ENABLED",
      maxTimeoutMs: "AGENT_TOOL_MAX_TIMEOUT_MS",
      maxOutputBytes: "AGENT_TOOL_MAX_OUTPUT_BYTES",
      resultCompression: "AGENT_TOOL_RESULT_COMPRESSION"
    },
    runtimeDependencies: {
      required: [
        {
          type: "node-runtime",
          injectedEnv: "AGENT_TOOL_NODE_BIN"
        }
      ],
      optional: [
        {
          type: "tool",
          slot: "tool:rg",
          id: "rg",
          version: "15.1.0",
          injectedEnv: "AGENT_TOOL_RG_BIN"
        }
      ]
    }
  };
}

export function resolveServiceConfig(env = process.env, overrides = {}) {
  const host = overrides.host ?? firstNonEmpty(env.AGENT_TOOL_HOST) ?? DEFAULT_HOST;
  const port = normalizePort(overrides.port ?? firstNonEmpty(env.AGENT_TOOL_PORT) ?? DEFAULT_PORT);
  return {
    host,
    port,
    baseUrl: `http://${host}:${port}`,
    token: firstNonEmpty(overrides.token, env.AGENT_TOOL_TOKEN),
    workspaceRoot: firstNonEmpty(overrides.workspaceRoot, env.AGENT_TOOL_WORKSPACE_ROOT),
    nodeBin: firstNonEmpty(overrides.nodeBin, env.AGENT_TOOL_NODE_BIN),
    rgBin: firstNonEmpty(overrides.rgBin, env.AGENT_TOOL_RG_BIN),
    processExecEnabled: overrides.processExecEnabled ?? parseBoolean(env.AGENT_TOOL_PROCESS_EXEC_ENABLED, true),
    maxTimeoutMs: parsePositiveInteger(overrides.maxTimeoutMs ?? env.AGENT_TOOL_MAX_TIMEOUT_MS, DEFAULT_MAX_TIMEOUT_MS),
    maxOutputBytes: parsePositiveInteger(overrides.maxOutputBytes ?? env.AGENT_TOOL_MAX_OUTPUT_BYTES, DEFAULT_MAX_OUTPUT_BYTES),
    resultCompressionEnabled: overrides.resultCompressionEnabled ?? parseBoolean(env.AGENT_TOOL_RESULT_COMPRESSION, true)
  };
}

function normalizePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
}

function setEnv(env, key, value) {
  if (value !== undefined && value !== null && String(value).trim()) {
    env[key] = String(value);
  }
}
