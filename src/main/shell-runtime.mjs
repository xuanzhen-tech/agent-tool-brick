/**
 * 一次性 shell 工具运行时。
 *
 * `run_shell` 面向应该在一次工具调用内结束的有界命令。持久终端会话放在
 * `terminal-runtime.mjs` 中，避免长时间或交互式进程阻塞整个模型轮次。
 */

import path from "node:path";

import { numberField, stringField } from "./env.mjs";
import { formatCommandPartForAudit, runProcess } from "./process-runtime.mjs";
import { buildRuntimeProcessEnv, resolveRuntimeProcessExecutable } from "./runtime-process-env.mjs";
import { getWorkspaceRootFromCall } from "./workspace.mjs";

const DEFAULT_TIMEOUT_MS = 20_000;

export async function executeRunShell(call, config, signal) {
  if (config.processExecEnabled === false) {
    return {
      status: "blocked",
      content: "process execution is disabled by host policy",
      details: {
        blocked: true,
        reasonCode: "process_exec_disabled",
        reason: "process execution is disabled by host policy"
      }
    };
  }

  const args = normalizeRunShellArguments(call.arguments ?? {});
  if (args.blocked) {
    return {
      status: "blocked",
      content: args.reason,
      details: {
        blocked: true,
        reasonCode: args.reasonCode,
        reason: args.reason
      }
    };
  }

  const cwd = path.resolve(getWorkspaceRootFromCall(call, config));
  const timeoutMs = clampTimeout(args.timeoutMs ?? call.limits?.timeoutMs ?? DEFAULT_TIMEOUT_MS, config.maxTimeoutMs);
  const maxOutputBytes = clampOutputBytes(call.limits?.maxOutputChars ?? config.maxOutputBytes, config.maxOutputBytes);
  const commandSpec = args.argv ? buildProcessCommandSpec(args.argv, config) : buildShellCommandSpec(args.command);
  const result = await runProcess({
    executable: commandSpec.executable,
    args: commandSpec.args,
    cwd,
    stdin: args.stdin,
    timeoutMs,
    maxOutputBytes,
    signal,
    env: buildRuntimeProcessEnv(config)
  });

  const details = {
    command: args.command,
    mode: args.argv ? "process" : "shell",
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut,
    interrupted: result.interrupted,
    truncated: result.truncated,
    cwd,
    blocked: false
  };

  if (result.interrupted) {
    return {
      status: "interrupted",
      content: formatShellContent(details),
      details,
      error: {
        code: "interrupted",
        message: "命令已被中断，未验证执行成功，不能据此宣称任务完成。"
      }
    };
  }

  const status = result.timedOut || result.exitCode !== 0 ? "failed" : "completed";
  return {
    status,
    content: formatShellContent(details),
    details,
    ...(status === "failed" ? {
      error: {
        code: result.timedOut ? "timeout" : "nonzero_exit",
        message: result.timedOut
          ? `命令在 ${timeoutMs}ms 后超时，未验证执行成功，不能据此宣称任务完成。`
          : `命令以退出码 ${result.exitCode} 结束，未验证执行成功，不能据此宣称任务完成。`
      }
    } : {})
  };
}

function normalizeRunShellArguments(params) {
  const mode = stringField(params.mode);
  if (mode === "process" || (!mode && stringField(params.executable))) {
    const executable = stringField(params.executable);
    if (!executable) {
      return { blocked: true, reasonCode: "empty_executable", reason: "Process executable must not be empty." };
    }
    const args = Array.isArray(params.args) ? params.args.map((item) => String(item)) : [];
    return {
      blocked: false,
      command: [executable, ...args].map(formatCommandPartForAudit).join(" "),
      argv: [executable, ...args],
      stdin: params.stdin === undefined ? undefined : String(params.stdin),
      timeoutMs: numberField(params.timeoutMs)
    };
  }

  const command = stringField(params.command);
  if (!command) {
    return { blocked: true, reasonCode: "empty_command", reason: "Shell command must not be empty." };
  }
  return {
    blocked: false,
    command,
    timeoutMs: numberField(params.timeoutMs)
  };
}

function buildProcessCommandSpec(argv, config = {}) {
  return { executable: resolveProcessExecutable(argv[0], config), args: argv.slice(1) };
}

function resolveProcessExecutable(executable, config = {}) {
  return resolveRuntimeProcessExecutable(executable, config);
}

export function buildShellCommandSpec(command) {
  if (process.platform === "win32") {
    return {
      executable: "powershell.exe",
      args: [
        "-NoLogo",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `$utf8 = [System.Text.UTF8Encoding]::new($false); [Console]::OutputEncoding = $utf8; $OutputEncoding = $utf8; ${command}`
      ]
    };
  }
  return { executable: "/bin/bash", args: ["-lc", command] };
}

function clampTimeout(value, maxTimeoutMs) {
  const timeout = Number.isFinite(Number(value)) && Number(value) > 0 ? Math.floor(Number(value)) : DEFAULT_TIMEOUT_MS;
  return Math.max(1, Math.min(timeout, maxTimeoutMs));
}

function clampOutputBytes(value, maxOutputBytes) {
  const output = Number.isFinite(Number(value)) && Number(value) > 0 ? Math.floor(Number(value)) : maxOutputBytes;
  return Math.max(1, Math.min(output, maxOutputBytes));
}

function formatShellContent(details) {
  return JSON.stringify({
    exitCode: details.exitCode,
    stdout: details.stdout,
    stderr: details.stderr,
    timedOut: details.timedOut,
    interrupted: details.interrupted,
    truncated: details.truncated,
    cwd: details.cwd
  }, null, 2);
}
