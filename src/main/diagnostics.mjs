/**
 * agent-tool 运行时依赖和可选 provider 的诊断逻辑。
 *
 * 服务必须能在缺少可选集成时启动。本文件把缺失 rg、skill index 或
 * web provider 配置转成可行动的 warn 检查，而不是启动失败。
 */

import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { brickDefinition } from "../brick-definition.mjs";
import { isRgAvailable } from "./search-runtime.mjs";
import { isSkillIndexAvailable } from "./skill-runtime.mjs";
import { isEmailProviderAvailable } from "./email-runtime.mjs";
import { isWebProviderAvailable } from "./web-runtime.mjs";

const execFileAsync = promisify(execFile);
// 与 python-runtime 的通用 requirements 保持一致，用于确认注入的解释器不仅存在，而且具备工具层需要的基础包。
const PYTHON_REQUIREMENT_MODULES = Object.freeze([
  "fitz",
  "numpy",
  "PIL",
  "pandas",
  "pydantic",
  "pypdf",
  "yaml",
  "dotenv",
  "requests",
  "openpyxl",
  "docx",
  "pptx"
]);

export async function createDiagnosticsReport(config, options = {}) {
  const checks = [];
  checks.push(createNodeRuntimeCheck(config));
  checks.push(await createPythonRuntimeCheck(config));
  checks.push(createProcessExecCheck(config));
  checks.push(createTerminalSessionCheck(config, options.terminalManager));
  checks.push(await createRgRuntimeCheck(config));
  checks.push(await createSkillIndexCheck(config));
  checks.push(createWebProviderCheck(config));
  checks.push(createEmailProviderCheck(config));

  const status = checks.some((check) => check.status === "fail")
    ? "fail"
    : checks.some((check) => check.status === "warn")
      ? "warn"
      : "pass";

  return {
    schemaVersion: "agent-tool.diagnostics.v1",
    brick: {
      id: brickDefinition.id,
      version: brickDefinition.version,
      kind: brickDefinition.kind
    },
    status,
    checks
  };
}

async function createPythonRuntimeCheck(config) {
  if (!config.pythonBin) {
    return {
      id: "python.runtime",
      status: "skip",
      summary: "python-runtime is optional and not injected.",
      detail: "Set AGENT_TOOL_PYTHON_BIN or pass runtimeDependencies[{ type: 'python-runtime', bin }]."
    };
  }

  const access = await pathAccess(config.pythonBin);
  if (!access.ok) {
    return {
      id: "python.runtime",
      status: "fail",
      summary: "Configured Python executable is not accessible.",
      detail: config.pythonBin
    };
  }

  // 用独立 Python 进程探测依赖，避免误用当前 Node 进程或开发机全局环境。
  const code = [
    "import importlib, json, sys",
    `modules = ${JSON.stringify(PYTHON_REQUIREMENT_MODULES)}`,
    "if sys.platform.startswith('win'): modules.append('winocr')",
    "missing = []",
    "for name in modules:",
    "    try:",
    "        importlib.import_module(name)",
    "    except Exception as exc:",
    "        missing.append({'module': name, 'error': str(exc)})",
    "print(json.dumps({'executable': sys.executable, 'version': sys.version.split()[0], 'missing': missing}, ensure_ascii=False))"
  ].join("\n");
  const command = await runCommand(config.pythonBin, ["-s", "-c", code]);
  const parsed = parseJsonObject(command.stdout);
  const missing = Array.isArray(parsed.missing) ? parsed.missing : [];
  return {
    id: "python.runtime",
    status: command.exitCode === 0 && missing.length === 0 ? "pass" : "fail",
    summary: command.exitCode === 0 && missing.length === 0
      ? "Injected Python runtime can import declared requirements."
      : "Injected Python runtime is missing one or more declared requirements.",
    detail: command.stdout || command.stderr || config.pythonBin
  };
}

async function createSkillIndexCheck(config) {
  const availability = await isSkillIndexAvailable(config.skillIndexPath);
  if (availability.available) {
    return {
      id: "tool.skill_index",
      status: "pass",
      summary: "Skill index is available; skill_find and skill_activate are exposed.",
      detail: availability.detail
    };
  }
  return {
    id: "tool.skill_index",
    status: "warn",
    summary: "Skill index is not available; skill_find and skill_activate will not be exposed.",
    detail: availability.detail
  };
}

function createWebProviderCheck(config) {
  const availability = isWebProviderAvailable(config);
  if (availability.available) {
    return {
      id: "tool.web_provider",
      status: "pass",
      summary: "Web provider is configured; web_search and web_fetch are exposed.",
      detail: availability.detail
    };
  }
  return {
    id: "tool.web_provider",
    status: "warn",
    summary: "Web provider is not configured; web_search and web_fetch will not be exposed.",
    detail: availability.detail
  };
}

function createEmailProviderCheck(config) {
  const availability = isEmailProviderAvailable(config);
  if (availability.available) {
    return {
      id: "tool.email_provider",
      status: "pass",
      summary: "email_send is exposed through the server tool gateway.",
      detail: availability.detail
    };
  }
  return {
    id: "tool.email_provider",
    status: "warn",
    summary: "email_send is not exposed because the server tool gateway is not configured.",
    detail: availability.detail
  };
}

export function createHealthReport(config) {
  return {
    ok: true,
    service: "agent-tool",
    version: brickDefinition.version,
    host: config.host,
    port: config.port
  };
}

function createNodeRuntimeCheck(config) {
  if (!config.nodeBin) {
    return {
      id: "node.runtime",
      status: "warn",
      summary: "AGENT_TOOL_NODE_BIN is not configured; current process Node is used for development smoke.",
      detail: process.execPath
    };
  }
  return {
    id: "node.runtime",
    status: "pass",
    summary: "Node runtime path is configured.",
    detail: config.nodeBin
  };
}

function createProcessExecCheck(config) {
  if (config.processExecEnabled === false) {
    return {
      id: "tool.run_shell",
      status: "warn",
      summary: "run_shell is disabled by host policy.",
      detail: "AGENT_TOOL_PROCESS_EXEC_ENABLED=false"
    };
  }
  return {
    id: "tool.run_shell",
    status: "pass",
    summary: "run_shell is enabled.",
    detail: `maxTimeoutMs=${config.maxTimeoutMs}; maxOutputBytes=${config.maxOutputBytes}`
  };
}

function createTerminalSessionCheck(config, terminalManager) {
  if (config.processExecEnabled === false) {
    return {
      id: "tool.terminal_session",
      status: "warn",
      summary: "terminal session tools are disabled by host policy.",
      detail: "AGENT_TOOL_PROCESS_EXEC_ENABLED=false"
    };
  }
  const stats = terminalManager?.stats?.() ?? {
    sessions: 0,
    running: 0,
    maxSessions: config.terminalMaxSessions,
    sessionTtlMs: config.terminalSessionTtlMs,
    maxOutputBytes: config.terminalMaxOutputBytes
  };
  return {
    id: "tool.terminal_session",
    status: "pass",
    summary: "exec_command and write_stdin are enabled.",
    detail: `running=${stats.running}; sessions=${stats.sessions}/${stats.maxSessions}; sessionTtlMs=${stats.sessionTtlMs}; maxOutputBytes=${stats.maxOutputBytes}`
  };
}

async function createRgRuntimeCheck(config) {
  if (config.rgBin) {
    const access = await pathAccess(config.rgBin);
    if (!access.ok) {
      return {
        id: "tool.rg",
        status: "warn",
        summary: "Configured rg path is not accessible.",
        detail: config.rgBin
      };
    }
  }

  const availability = await isRgAvailable(config.rgBin);
  if (availability.available) {
    return {
      id: "tool.rg",
      status: "pass",
      summary: "rg tool runtime is available.",
      detail: availability.detail || availability.command
    };
  }
  return {
    id: "tool.rg",
    status: "warn",
    summary: "rg tool runtime is not available; workspace_search will not be exposed.",
    detail: availability.detail || availability.command
  };
}

async function runCommand(command, args) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      timeout: 60_000,
      windowsHide: true,
      maxBuffer: 20 * 1024 * 1024,
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
        PYTHONNOUSERSITE: "1"
      }
    });
    return { exitCode: 0, stdout: clip(stdout), stderr: clip(stderr) };
  } catch (error) {
    return {
      exitCode: error?.code ?? null,
      stdout: clip(error?.stdout ?? ""),
      stderr: clip(error?.stderr || formatError(error))
    };
  }
}

// diagnostics 不应因异常输出崩溃；解析失败时返回空对象，由上层给出 fail/warn。
function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(String(value ?? "").trim());
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function clip(value) {
  const text = String(value ?? "");
  return text.length > 20_000 ? `${text.slice(0, 20_000)}\n[truncated]` : text;
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

async function pathAccess(filePath) {
  try {
    await fs.access(filePath);
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}
