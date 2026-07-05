/**
 * One-shot shell tool runtime.
 *
 * `run_shell` is for bounded commands that should finish within one tool call.
 * Persistent terminal sessions live in `terminal-runtime.mjs` so long-running or
 * interactive processes do not hold the model turn hostage.
 */

import path from "node:path";

import { numberField, stringField } from "./env.mjs";
import { formatCommandPartForAudit, runProcess } from "./process-runtime.mjs";
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
  const commandSpec = args.argv ? buildProcessCommandSpec(args.argv) : buildShellCommandSpec(args.command);
  const result = await runProcess({
    executable: commandSpec.executable,
    args: commandSpec.args,
    cwd,
    stdin: args.stdin,
    timeoutMs,
    maxOutputBytes,
    signal,
    env: {
      ...process.env,
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1"
    }
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
        message: "Tool call was interrupted."
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
        message: result.timedOut ? `Command timed out after ${timeoutMs}ms.` : `Command exited with code ${result.exitCode}.`
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

function buildProcessCommandSpec(argv) {
  return { executable: argv[0] ?? "", args: argv.slice(1) };
}

export function buildShellCommandSpec(command) {
  if (process.platform === "win32") {
    return {
      executable: "powershell.exe",
      args: ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command]
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
