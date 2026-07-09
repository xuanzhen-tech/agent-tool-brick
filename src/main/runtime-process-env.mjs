/**
 * agent-tool 的外部 runtime 进程环境。
 *
 * 产品仓库会把 node、python、rg、产品 Node 包等运行期依赖以 runtimeDependencies
 * 注入给 AgentTool。这里负责把这些私有 runtime 转成进程执行时真正可见的
 * PATH、环境变量和命令名解析，避免 run_shell/terminal 意外使用宿主机全局依赖。
 */

import path from "node:path";
import { pathToFileURL } from "node:url";

// 【命令映射】模型常用的是 node/python/rg 这些通用命令名，实际应指向产品注入的私有 bin。
const RUNTIME_COMMAND_ALIASES = [
  { names: ["node", "node.exe"], configKey: "nodeBin" },
  { names: ["python", "python.exe", "python3", "python3.exe", "py", "py.exe"], configKey: "pythonBin" },
  { names: ["rg", "rg.exe", "ripgrep", "ripgrep.exe"], configKey: "rgBin" }
];

// 【环境变量映射】给子进程留下显式路径，便于脚本或诊断命令确认当前使用的 runtime。
const RUNTIME_ENV_KEYS = {
  nodeBin: "AGENT_TOOL_NODE_BIN",
  pythonBin: "AGENT_TOOL_PYTHON_BIN",
  rgBin: "AGENT_TOOL_RG_BIN"
};

// 【公开入口】构造所有工具进程共享的 env。
export function buildRuntimeProcessEnv(config = {}, baseEnv = process.env) {
  const env = {
    ...baseEnv,
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1"
  };

  for (const [configKey, envKey] of Object.entries(RUNTIME_ENV_KEYS)) {
    if (config[configKey]) env[envKey] = config[configKey];
  }

  for (const [key, value] of Object.entries(config.runtimeEnv ?? {})) {
    if (value !== undefined && value !== null) env[key] = String(value);
  }

  if (config.playwrightBrowsersPath) {
    env.PLAYWRIGHT_BROWSERS_PATH = config.playwrightBrowsersPath;
    env.AGENT_TOOL_PLAYWRIGHT_BROWSERS_PATH = config.playwrightBrowsersPath;
  }

  setJoinedEnv(env, "AGENT_TOOL_NODE_PACKAGE_PATHS", config.nodePackagePaths, path.delimiter);
  setJoinedEnv(env, "AGENT_TOOL_NODE_IMPORT_REGISTERS", config.nodeImportRegisterPaths, path.delimiter);
  setJoinedEnv(env, "AGENT_TOOL_NODE_OPTIONS", config.nodeOptions, " ");

  const runtimeDirs = collectRuntimeBinDirs(config);
  if (runtimeDirs.length > 0) {
    const pathKey = findPathEnvKey(env);
    env[pathKey] = joinPathEntries(runtimeDirs, env[pathKey]);
  }

  const nodeModuleDirs = collectRuntimeNodeModuleDirs(config);
  if (nodeModuleDirs.length > 0) {
    env.NODE_PATH = joinPathEntries(nodeModuleDirs, env.NODE_PATH);
  }

  for (const option of normalizeStringList(config.nodeOptions)) {
    env.NODE_OPTIONS = appendNodeOption(env.NODE_OPTIONS, option);
  }

  for (const registerPath of normalizeStringList(config.nodeImportRegisterPaths)) {
    env.NODE_OPTIONS = appendNodeOption(env.NODE_OPTIONS, `--import=${pathToFileURL(registerPath).href}`);
  }

  return env;
}

// 【公开入口】process 模式下直接把通用命令名解析成注入 runtime 的绝对路径。
export function resolveRuntimeProcessExecutable(executable, config = {}) {
  const command = executable ?? "";
  const normalized = String(command).trim().toLowerCase();

  for (const alias of RUNTIME_COMMAND_ALIASES) {
    if (alias.names.includes(normalized) && config[alias.configKey]) {
      return config[alias.configKey];
    }
  }

  return command;
}

function collectRuntimeBinDirs(config = {}) {
  const dirs = [];
  for (const configKey of ["nodeBin", "pythonBin", "rgBin"]) {
    const bin = config[configKey];
    if (!bin) continue;
    const dir = path.dirname(bin);
    if (!dirs.includes(dir)) dirs.push(dir);
  }
  return dirs;
}

function collectRuntimeNodeModuleDirs(config = {}) {
  return normalizeStringList(config.nodePackagePaths)
    .filter((value) => typeof value === "string" && value.trim().length > 0);
}

function setJoinedEnv(env, key, values, delimiter) {
  const normalized = normalizeStringList(values);
  if (normalized.length > 0) env[key] = normalized.join(delimiter);
}

function findPathEnvKey(env) {
  return Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
}

function joinPathEntries(prependEntries, currentValue) {
  return [...prependEntries, currentValue].filter(Boolean).join(path.delimiter);
}

function appendNodeOption(currentValue, option) {
  const current = typeof currentValue === "string" ? currentValue.trim() : "";
  if (!current) return option;
  if (current.split(/\s+/).includes(option)) return current;
  return `${option} ${current}`;
}

function normalizeStringList(value) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string" && item.trim().length > 0);
  if (typeof value === "string" && value.trim().length > 0) return [value];
  return [];
}
