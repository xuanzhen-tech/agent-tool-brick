/**
 * agent-tool 的持久终端会话运行时。
 *
 * `exec_command` 启动命令，并在进程继续运行时快速返回 session id。
 * `write_stdin` 随后负责写入输入或轮询增量输出。这样可以避免 dev server、
 * watcher 和 REPL 类命令阻塞整个 agent 轮次。
 */

import { spawn } from "node:child_process";
import path from "node:path";

import { numberField, stringField } from "./env.mjs";
import { appendOutput, formatCommandPartForAudit, killProcessTree } from "./process-runtime.mjs";
import { buildRuntimeProcessEnv, resolveRuntimeProcessExecutable } from "./runtime-process-env.mjs";
import { buildShellCommandSpec } from "./shell-runtime.mjs";
import { getWorkspaceRootFromCall, resolveInsideWorkspace } from "./workspace.mjs";

const DEFAULT_EXEC_YIELD_TIME_MS = 1_000;
const DEFAULT_WRITE_YIELD_TIME_MS = 250;
const MIN_YIELD_TIME_MS = 0;
const MAX_YIELD_TIME_MS = 30_000;
const DEFAULT_SESSION_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_SESSIONS = 16;
const DEFAULT_TERMINAL_OUTPUT_BYTES = 256 * 1024;

export function createTerminalSessionManager(config = {}) {
  return new TerminalSessionManager(config);
}

class TerminalSessionManager {
  constructor(config = {}) {
    this.sessions = new Map();
    this.nextSessionNumber = 1;
    this.maxSessions = positiveInteger(config.terminalMaxSessions, DEFAULT_MAX_SESSIONS);
    this.defaultSessionTtlMs = positiveInteger(config.terminalSessionTtlMs, DEFAULT_SESSION_TTL_MS);
    this.defaultOutputBytes = positiveInteger(config.terminalMaxOutputBytes, DEFAULT_TERMINAL_OUTPUT_BYTES);
  }

  stats() {
    let running = 0;
    for (const session of this.sessions.values()) {
      if (session.running) running += 1;
    }
    return {
      sessions: this.sessions.size,
      running,
      maxSessions: this.maxSessions,
      sessionTtlMs: this.defaultSessionTtlMs,
      maxOutputBytes: this.defaultOutputBytes
    };
  }

  async execCommand(call, config, signal) {
    if (config.processExecEnabled === false) {
      return blockedResult("process_exec_disabled", "process execution is disabled by host policy");
    }

    const args = normalizeExecCommandArguments(call.arguments ?? {});
    if (args.blocked) return blockedResult(args.reasonCode, args.reason);

    this.evictCompletedSessions();
    if (this.sessions.size >= this.maxSessions) {
      return blockedResult("terminal_session_limit", `maximum terminal sessions reached: ${this.maxSessions}`);
    }

    let cwd;
    try {
      cwd = resolveCommandCwd(call, config, args.workdir);
    } catch (error) {
      return blockedResult(error.code || "workspace_path_denied", error.message);
    }

    const commandSpec = args.argv ? buildProcessCommandSpec(args.argv, config) : buildShellCommandSpec(args.cmd);
    let session;
    try {
      session = this.spawnSession({
        commandSpec,
        command: args.commandForAudit,
        mode: args.argv ? "process" : "shell",
        cwd,
        timeoutMs: clamp(args.timeoutMs ?? config.terminalSessionTtlMs, 1, this.defaultSessionTtlMs),
        maxOutputBytes: clamp(args.maxOutputBytes ?? config.terminalMaxOutputBytes, 1, this.defaultOutputBytes)
      });
    } catch (error) {
      return failedResult("terminal_spawn_failed", error instanceof Error ? error.message : String(error), {
        command: args.commandForAudit,
        cwd
      });
    }

    const abortListener = () => {
      session.interrupted = true;
      killProcessTree(session.child);
    };
    attachAbort(signal, abortListener);
    try {
      const yieldTimeMs = clamp(args.yieldTimeMs, MIN_YIELD_TIME_MS, MAX_YIELD_TIME_MS);
      await waitForSessionOrDelay(session, yieldTimeMs);
      return this.readSessionResult(session, {
        source: "exec_command",
        yieldedAfterMs: yieldTimeMs,
        removeIfDone: true
      });
    } finally {
      detachAbort(signal, abortListener);
    }
  }

  async writeStdin(call, config, signal) {
    if (config.processExecEnabled === false) {
      return blockedResult("process_exec_disabled", "process execution is disabled by host policy");
    }

    const args = normalizeWriteStdinArguments(call.arguments ?? {});
    if (args.blocked) return blockedResult(args.reasonCode, args.reason);

    const session = this.sessions.get(args.sessionId);
    if (!session) {
      return failedResult("terminal_session_not_found", `terminal session not found: ${args.sessionId}`, {
        sessionId: args.sessionId,
        session_id: args.sessionId
      });
    }

    if (args.chars && session.running && session.child.stdin?.writable) {
      session.child.stdin.write(args.chars);
      session.lastUsedAt = new Date().toISOString();
    } else if (args.chars && !session.running) {
      return failedResult("terminal_session_closed", `terminal session is already closed: ${args.sessionId}`, {
        sessionId: args.sessionId,
        session_id: args.sessionId,
        running: false
      });
    }

    const yieldTimeMs = clamp(args.yieldTimeMs, MIN_YIELD_TIME_MS, MAX_YIELD_TIME_MS);
    const abortListener = () => {
      session.pollInterrupted = true;
    };
    attachAbort(signal, abortListener);
    try {
      await waitForSessionOrDelay(session, yieldTimeMs);
      return this.readSessionResult(session, {
        source: "write_stdin",
        yieldedAfterMs: yieldTimeMs,
        stdinBytes: Buffer.byteLength(args.chars, "utf8"),
        removeIfDone: true
      });
    } finally {
      detachAbort(signal, abortListener);
    }
  }

  cancelSession(sessionId, reason = "Terminal session canceled.") {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.interrupted = true;
    session.cancelReason = reason;
    if (session.running) killProcessTree(session.child);
    return true;
  }

  closeAll(reason = "Terminal manager closing.") {
    for (const session of this.sessions.values()) {
      session.interrupted = true;
      session.cancelReason = reason;
      if (session.running) killProcessTree(session.child);
      clearTimeout(session.timeoutTimer);
    }
    this.sessions.clear();
  }

  spawnSession({ commandSpec, command, mode, cwd, timeoutMs, maxOutputBytes }) {
    const sessionId = `terminal-${Date.now().toString(36)}-${this.nextSessionNumber++}`;
    const session = {
      id: sessionId,
      child: undefined,
      command,
      mode,
      cwd,
      stdout: "",
      stderr: "",
      stdoutReadOffset: 0,
      stderrReadOffset: 0,
      maxOutputBytes,
      running: true,
      exitCode: undefined,
      errorMessage: undefined,
      timedOut: false,
      interrupted: false,
      truncated: false,
      startedAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
      waiters: []
    };

    const child = spawn(commandSpec.executable, commandSpec.args, {
      cwd,
      env: buildRuntimeProcessEnv(this.config),
      windowsHide: true,
      shell: false
    });
    session.child = child;
    this.sessions.set(sessionId, session);

    session.timeoutTimer = setTimeout(() => {
      session.timedOut = true;
      killProcessTree(child);
    }, timeoutMs);
    session.timeoutTimer.unref?.();

    child.stdout?.on("data", (chunk) => {
      const next = appendOutput(session.stdout, chunk, maxOutputBytes);
      session.stdout = next.value;
      session.truncated ||= next.truncated;
    });
    child.stderr?.on("data", (chunk) => {
      const next = appendOutput(session.stderr, chunk, maxOutputBytes);
      session.stderr = next.value;
      session.truncated ||= next.truncated;
    });
    child.on("error", (error) => {
      session.errorMessage = error instanceof Error ? error.message : String(error);
      finishSession(session, null);
    });
    child.on("close", (code) => {
      finishSession(session, code);
    });

    return session;
  }

  readSessionResult(session, context = {}) {
    const stdout = readIncrementalChannel(session, "stdout");
    const stderr = readIncrementalChannel(session, "stderr");
    const details = {
      source: context.source,
      sessionId: session.id,
      session_id: session.id,
      running: session.running,
      command: session.command,
      mode: session.mode,
      cwd: session.cwd,
      stdout,
      stderr,
      exitCode: session.exitCode,
      timedOut: session.timedOut,
      interrupted: session.interrupted,
      truncated: session.truncated,
      errorMessage: session.errorMessage,
      cancelReason: session.cancelReason,
      startedAt: session.startedAt,
      lastUsedAt: session.lastUsedAt,
      yieldedAfterMs: context.yieldedAfterMs,
      stdinBytes: context.stdinBytes
    };

    const status = session.interrupted
      ? "interrupted"
      : !session.running && (session.timedOut || session.errorMessage || (Number.isInteger(session.exitCode) && session.exitCode !== 0))
        ? "failed"
        : "completed";

    if (!session.running && context.removeIfDone) {
      clearTimeout(session.timeoutTimer);
      this.sessions.delete(session.id);
    }

    return {
      status,
      content: JSON.stringify({
        session_id: session.id,
        running: session.running,
        exitCode: session.exitCode,
        stdout,
        stderr,
        timedOut: session.timedOut,
        interrupted: session.interrupted,
        next: session.running ? "Use write_stdin with this session_id to send input or poll output." : undefined
      }, null, 2),
      details,
      ...(status === "failed" ? {
        error: {
          code: session.timedOut ? "timeout" : "terminal_command_failed",
          message: session.timedOut ? "Terminal command timed out." : (session.errorMessage || `Terminal command exited with code ${session.exitCode}.`)
        }
      } : {}),
      ...(status === "interrupted" ? {
        error: {
          code: "interrupted",
          message: session.cancelReason || "Terminal session interrupted."
        }
      } : {})
    };
  }

  evictCompletedSessions() {
    for (const [sessionId, session] of this.sessions.entries()) {
      if (!session.running) {
        clearTimeout(session.timeoutTimer);
        this.sessions.delete(sessionId);
      }
    }
  }
}

function finishSession(session, exitCode) {
  if (!session.running) return;
  session.running = false;
  session.exitCode = exitCode;
  session.lastUsedAt = new Date().toISOString();
  clearTimeout(session.timeoutTimer);
  const waiters = session.waiters.splice(0);
  for (const resolve of waiters) resolve();
}

function waitForSessionOrDelay(session, yieldTimeMs) {
  if (!session.running || yieldTimeMs <= 0) return Promise.resolve();
  return Promise.race([
    new Promise((resolve) => session.waiters.push(resolve)),
    delay(yieldTimeMs)
  ]);
}

function normalizeExecCommandArguments(params) {
  const mode = stringField(params.mode);
  const executable = stringField(params.executable);
  if (mode === "process" || executable) {
    if (!executable) return { blocked: true, reasonCode: "empty_executable", reason: "Process executable must not be empty." };
    const args = Array.isArray(params.args) ? params.args.map((item) => String(item)) : [];
    return {
      blocked: false,
      argv: [executable, ...args],
      commandForAudit: [executable, ...args].map(formatCommandPartForAudit).join(" "),
      workdir: stringField(params.workdir),
      yieldTimeMs: numberField(params.yieldTimeMs ?? params.yield_time_ms) ?? DEFAULT_EXEC_YIELD_TIME_MS,
      timeoutMs: numberField(params.timeoutMs ?? params.timeout_ms),
      maxOutputBytes: numberField(params.maxOutputBytes ?? params.max_output_bytes)
    };
  }

  const cmd = stringField(params.cmd ?? params.command);
  if (!cmd) return { blocked: true, reasonCode: "empty_command", reason: "exec_command requires cmd or executable." };
  return {
    blocked: false,
    cmd,
    commandForAudit: cmd,
    workdir: stringField(params.workdir),
    yieldTimeMs: numberField(params.yieldTimeMs ?? params.yield_time_ms) ?? DEFAULT_EXEC_YIELD_TIME_MS,
    timeoutMs: numberField(params.timeoutMs ?? params.timeout_ms),
    maxOutputBytes: numberField(params.maxOutputBytes ?? params.max_output_bytes)
  };
}

function normalizeWriteStdinArguments(params) {
  const sessionId = stringField(params.session_id ?? params.sessionId);
  if (!sessionId) return { blocked: true, reasonCode: "missing_session_id", reason: "write_stdin requires session_id." };
  return {
    blocked: false,
    sessionId,
    chars: params.chars === undefined ? "" : String(params.chars),
    yieldTimeMs: numberField(params.yieldTimeMs ?? params.yield_time_ms) ?? DEFAULT_WRITE_YIELD_TIME_MS
  };
}

function resolveCommandCwd(call, config, workdir) {
  const workspaceRoot = path.resolve(getWorkspaceRootFromCall(call, config));
  return resolveInsideWorkspace(workspaceRoot, workdir || ".").absolutePath;
}

function buildProcessCommandSpec(argv, config = {}) {
  return { executable: resolveProcessExecutable(argv[0], config), args: argv.slice(1) };
}

function resolveProcessExecutable(executable, config = {}) {
  return resolveRuntimeProcessExecutable(executable, config);
}

function readIncrementalChannel(session, key) {
  const offsetKey = key === "stdout" ? "stdoutReadOffset" : "stderrReadOffset";
  const value = session[key] ?? "";
  if (session[offsetKey] > value.length) session[offsetKey] = 0;
  const delta = value.slice(session[offsetKey]);
  session[offsetKey] = value.length;
  return delta;
}

function blockedResult(reasonCode, reason) {
  return {
    status: "blocked",
    content: reason,
    details: {
      blocked: true,
      reasonCode,
      reason
    },
    error: {
      code: reasonCode,
      message: reason
    }
  };
}

function failedResult(code, message, details = {}) {
  return {
    status: "failed",
    content: message,
    details,
    error: { code, message }
  };
}

function attachAbort(signal, listener) {
  if (!signal) return;
  if (signal.aborted) {
    listener();
  } else {
    signal.addEventListener?.("abort", listener, { once: true });
  }
}

function detachAbort(signal, listener) {
  signal?.removeEventListener?.("abort", listener);
}

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function clamp(value, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return max;
  return Math.max(min, Math.min(Math.floor(parsed), max));
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
