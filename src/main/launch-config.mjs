/**
 * agent-tool 的启动配置和运行时合同工具。
 *
 * host launcher 通过本文件把已安装运行时路径和 provider 配置转换为环境变量。
 * 把映射集中在这里，可以避免产品或 client-shell 代码硬编码私有实现细节。
 */

import { brickDefinition } from "../brick-definition.mjs";
import { firstNonEmpty, parseBoolean, parsePositiveInteger } from "./env.mjs";
import { createRuntimeDependencyConfig } from "./runtime-dependency-config.mjs";
import path from "node:path";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8791;
const DEFAULT_MAX_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_TERMINAL_SESSION_TTL_MS = 5 * 60_000;
const DEFAULT_TERMINAL_MAX_SESSIONS = 16;
const DEFAULT_TERMINAL_MAX_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_TOOL_GATEWAY_BASE_URL = "http://47.109.82.99/agent-llm-gateway";

export function createAgentToolLaunchConfig(input = {}) {
  const host = input.host ?? DEFAULT_HOST;
  const port = normalizePort(input.port ?? DEFAULT_PORT);
  const runtimeDependencies = normalizeRuntimeDependencies(input.runtimeDependencies);
  const runtimeConfig = createRuntimeDependencyConfig(runtimeDependencies);
  const env = {};

  setEnv(env, "AGENT_TOOL_HOST", host);
  setEnv(env, "AGENT_TOOL_PORT", String(port));
  setEnv(env, "AGENT_TOOL_WORKSPACE_ROOT", input.workspace);
  setEnv(env, "AGENT_TOOL_NODE_BIN", input.nodeBin ?? resolveInjectedBin(runtimeDependencies, ["node-runtime", "node"]));
  setEnv(env, "AGENT_TOOL_PYTHON_BIN", input.pythonBin ?? resolveInjectedBin(runtimeDependencies, ["python-runtime", "python"]));
  setEnv(env, "AGENT_TOOL_RG_BIN", input.rgBin ?? resolveInjectedBin(runtimeDependencies, ["tool:rg", "rg"]));
  setEnvEntries(env, runtimeConfig.runtimeEnv);
  setEnv(env, "PLAYWRIGHT_BROWSERS_PATH", input.playwrightBrowsersPath ?? runtimeConfig.playwrightBrowsersPath);
  setEnv(env, "AGENT_TOOL_PLAYWRIGHT_BROWSERS_PATH", input.playwrightBrowsersPath ?? runtimeConfig.playwrightBrowsersPath);
  setEnv(env, "AGENT_TOOL_NODE_PACKAGE_PATHS", joinList(input.nodePackagePaths ?? runtimeConfig.nodePackagePaths, path.delimiter));
  setEnv(env, "AGENT_TOOL_NODE_IMPORT_REGISTERS", joinList(input.nodeImportRegisterPaths ?? runtimeConfig.nodeImportRegisterPaths, path.delimiter));
  setEnv(env, "AGENT_TOOL_NODE_OPTIONS", joinList(input.nodeOptions ?? runtimeConfig.nodeOptions, " "));
  setEnv(env, "AGENT_TOOL_TOKEN", input.token);
  setEnv(env, "AGENT_TOOL_GATEWAY_BASE_URL", input.toolGatewayBaseUrl);

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
  if (input.terminalSessionTtlMs !== undefined) {
    setEnv(env, "AGENT_TOOL_TERMINAL_SESSION_TTL_MS", String(input.terminalSessionTtlMs));
  }
  if (input.terminalMaxSessions !== undefined) {
    setEnv(env, "AGENT_TOOL_TERMINAL_MAX_SESSIONS", String(input.terminalMaxSessions));
  }
  if (input.terminalMaxOutputBytes !== undefined) {
    setEnv(env, "AGENT_TOOL_TERMINAL_MAX_OUTPUT_BYTES", String(input.terminalMaxOutputBytes));
  }
  if (input.webMaxResults !== undefined) {
    setEnv(env, "AGENT_TOOL_WEB_MAX_RESULTS", String(input.webMaxResults));
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
      pythonBin: "AGENT_TOOL_PYTHON_BIN",
      rgBin: "AGENT_TOOL_RG_BIN",
      playwrightBrowsersPath: "PLAYWRIGHT_BROWSERS_PATH",
      nodePackagePaths: "AGENT_TOOL_NODE_PACKAGE_PATHS",
      nodeImportRegisterPaths: "AGENT_TOOL_NODE_IMPORT_REGISTERS",
      nodeOptions: "AGENT_TOOL_NODE_OPTIONS",
      toolGatewayBaseUrl: "AGENT_TOOL_GATEWAY_BASE_URL",
      webMaxResults: "AGENT_TOOL_WEB_MAX_RESULTS",
      processExecEnabled: "AGENT_TOOL_PROCESS_EXEC_ENABLED",
      maxTimeoutMs: "AGENT_TOOL_MAX_TIMEOUT_MS",
      maxOutputBytes: "AGENT_TOOL_MAX_OUTPUT_BYTES",
      terminalSessionTtlMs: "AGENT_TOOL_TERMINAL_SESSION_TTL_MS",
      terminalMaxSessions: "AGENT_TOOL_TERMINAL_MAX_SESSIONS",
      terminalMaxOutputBytes: "AGENT_TOOL_TERMINAL_MAX_OUTPUT_BYTES",
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
        },
        {
          type: "python-runtime",
          injectedEnv: "AGENT_TOOL_PYTHON_BIN"
        },
        {
          type: "node-package",
          injectedEnv: "NODE_PATH"
        },
        {
          type: "playwright-browsers",
          slot: "playwright-browsers",
          injectedEnv: "PLAYWRIGHT_BROWSERS_PATH"
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
    pythonBin: firstNonEmpty(overrides.pythonBin, env.AGENT_TOOL_PYTHON_BIN, env.AGENT_CLI_PYTHON_BIN),
    rgBin: firstNonEmpty(overrides.rgBin, env.AGENT_TOOL_RG_BIN),
    playwrightBrowsersPath: firstNonEmpty(overrides.playwrightBrowsersPath, env.PLAYWRIGHT_BROWSERS_PATH, env.AGENT_TOOL_PLAYWRIGHT_BROWSERS_PATH),
    runtimeEnv: normalizeRuntimeEnv(overrides.runtimeEnv),
    nodePackagePaths: normalizeDelimitedList(overrides.nodePackagePaths ?? env.AGENT_TOOL_NODE_PACKAGE_PATHS, path.delimiter),
    nodeImportRegisterPaths: normalizeDelimitedList(overrides.nodeImportRegisterPaths ?? env.AGENT_TOOL_NODE_IMPORT_REGISTERS, path.delimiter),
    nodeOptions: normalizeDelimitedList(overrides.nodeOptions ?? env.AGENT_TOOL_NODE_OPTIONS, " "),
    nodePackageNames: normalizeDelimitedList(overrides.nodePackageNames, ","),
    toolGatewayBaseUrl: firstNonEmpty(
      overrides.toolGatewayBaseUrl,
      overrides.webGatewayBaseUrl,
      env.AGENT_TOOL_GATEWAY_BASE_URL,
      env.AGENT_CLI_LLM_GATEWAY_URL,
      env.AGENT_TOOL_WEB_GATEWAY_BASE_URL
    ) ?? DEFAULT_TOOL_GATEWAY_BASE_URL,
    webMaxResults: parsePositiveInteger(overrides.webMaxResults ?? env.AGENT_TOOL_WEB_MAX_RESULTS ?? env.TAVILY_MAX_RESULTS, 5),
    processExecEnabled: overrides.processExecEnabled ?? parseBoolean(env.AGENT_TOOL_PROCESS_EXEC_ENABLED, true),
    maxTimeoutMs: parsePositiveInteger(overrides.maxTimeoutMs ?? env.AGENT_TOOL_MAX_TIMEOUT_MS, DEFAULT_MAX_TIMEOUT_MS),
    maxOutputBytes: parsePositiveInteger(overrides.maxOutputBytes ?? env.AGENT_TOOL_MAX_OUTPUT_BYTES, DEFAULT_MAX_OUTPUT_BYTES),
    terminalSessionTtlMs: parsePositiveInteger(overrides.terminalSessionTtlMs ?? env.AGENT_TOOL_TERMINAL_SESSION_TTL_MS, DEFAULT_TERMINAL_SESSION_TTL_MS),
    terminalMaxSessions: parsePositiveInteger(overrides.terminalMaxSessions ?? env.AGENT_TOOL_TERMINAL_MAX_SESSIONS, DEFAULT_TERMINAL_MAX_SESSIONS),
    terminalMaxOutputBytes: parsePositiveInteger(overrides.terminalMaxOutputBytes ?? env.AGENT_TOOL_TERMINAL_MAX_OUTPUT_BYTES, DEFAULT_TERMINAL_MAX_OUTPUT_BYTES),
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

function setEnvEntries(env, entries) {
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) return;
  for (const [key, value] of Object.entries(entries)) {
    setEnv(env, key, value);
  }
}

function joinList(value, delimiter) {
  const values = normalizeDelimitedList(value, delimiter);
  return values.length > 0 ? values.join(delimiter) : undefined;
}

function normalizeRuntimeEnv(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, envValue]) => String(key).trim() && envValue !== undefined && envValue !== null)
      .map(([key, envValue]) => [key, String(envValue)])
  );
}

function normalizeDelimitedList(value, delimiter) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string" && item.trim().length > 0);
  if (typeof value === "string" && value.trim().length > 0) {
    return value.split(delimiter).map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function normalizeRuntimeDependencies(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).map(([key, dependency]) => ({
    key,
    ...(dependency && typeof dependency === "object" ? dependency : { value: dependency })
  }));
}

function resolveInjectedBin(dependencies, candidates) {
  const dependency = dependencies.find((item) => {
    const values = [item.key, item.slot, item.id, item.type, item.name]
      .filter(Boolean)
      .map((value) => String(value).toLowerCase());
    return candidates.some((candidate) => values.includes(candidate.toLowerCase()));
  });
  return dependency?.bin ?? dependency?.path ?? dependency?.executable ?? dependency?.value;
}
