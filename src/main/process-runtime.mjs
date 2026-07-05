/**
 * agent-tool 的底层进程工具。
 *
 * `runProcess` 支撑一次性工具调用，导出的输出和 kill 工具会被持久终端
 * 会话复用。把进程树清理集中在这里，可以避免 Windows 和 POSIX 行为
 * 悄悄分叉。
 */

import { spawn } from "node:child_process";

export function runProcess({
  executable,
  args = [],
  cwd,
  stdin,
  timeoutMs = 20_000,
  maxOutputBytes = 64 * 1024,
  signal,
  env = process.env
}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(executable, args, {
        cwd,
        env,
        windowsHide: true,
        shell: false
      });
    } catch (error) {
      resolve({
        exitCode: null,
        stdout: "",
        stderr: formatError(error),
        timedOut: false,
        interrupted: false,
        truncated: false
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let truncated = false;
    let settled = false;
    let timedOut = false;
    let interrupted = false;

    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", abortListener);
      resolve(result);
    };

    const abortListener = () => {
      interrupted = true;
      killProcessTree(child);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, timeoutMs);
    timer.unref?.();

    if (signal?.aborted) {
      abortListener();
    } else {
      signal?.addEventListener?.("abort", abortListener, { once: true });
    }

    child.stdout?.on("data", (chunk) => {
      const next = appendOutput(stdout, chunk, maxOutputBytes);
      stdout = next.value;
      truncated ||= next.truncated;
    });
    child.stderr?.on("data", (chunk) => {
      const next = appendOutput(stderr, chunk, maxOutputBytes);
      stderr = next.value;
      truncated ||= next.truncated;
    });
    child.on("error", (error) => {
      settle({
        exitCode: null,
        stdout,
        stderr: stderr || formatError(error),
        timedOut,
        interrupted,
        truncated
      });
    });
    child.on("close", (code) => {
      settle({
        exitCode: code,
        stdout,
        stderr,
        timedOut,
        interrupted,
        truncated
      });
    });

    if (stdin !== undefined) {
      child.stdin?.write(stdin);
      child.stdin?.end();
    }
  });
}

export function killProcessTree(child) {
  if (!child?.pid) return false;
  if (process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      shell: false,
      stdio: "ignore"
    });
    killer.on("error", () => child.kill());
    return true;
  }
  child.kill("SIGTERM");
  return true;
}

export function appendOutput(current, chunk, maxOutputBytes) {
  const next = current + Buffer.from(chunk).toString("utf-8");
  if (Buffer.byteLength(next, "utf-8") <= maxOutputBytes) {
    return { value: next, truncated: false };
  }
  return {
    value: truncateUtf8(next, maxOutputBytes) + "\n[truncated]",
    truncated: true
  };
}

export function formatCommandPartForAudit(value) {
  if (/^[A-Za-z0-9_./:=,@+-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function truncateUtf8(value, maxBytes) {
  let bytes = 0;
  let output = "";
  for (const char of value) {
    const size = Buffer.byteLength(char, "utf-8");
    if (bytes + size > maxBytes) break;
    output += char;
    bytes += size;
  }
  return output;
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}
