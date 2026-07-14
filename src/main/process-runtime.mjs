/**
 * agent-tool 的底层进程工具。
 *
 * `runProcess` 支撑一次性工具调用，导出的输出和 kill 工具会被持久终端
 * 会话复用。把进程树清理集中在这里，可以避免 Windows 和 POSIX 行为
 * 悄悄分叉。
 */

import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

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

    const stdoutCollector = createOutputCollector(maxOutputBytes);
    const stderrCollector = createOutputCollector(maxOutputBytes);
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
      appendOutput(stdoutCollector, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      appendOutput(stderrCollector, chunk);
    });
    child.on("error", (error) => {
      finalizeOutput(stdoutCollector);
      finalizeOutput(stderrCollector);
      settle({
        exitCode: null,
        stdout: stdoutCollector.value,
        stderr: stderrCollector.value || formatError(error),
        timedOut,
        interrupted,
        truncated: stdoutCollector.truncated || stderrCollector.truncated
      });
    });
    child.on("close", (code) => {
      finalizeOutput(stdoutCollector);
      finalizeOutput(stderrCollector);
      settle({
        exitCode: code,
        stdout: stdoutCollector.value,
        stderr: stderrCollector.value,
        timedOut,
        interrupted,
        truncated: stdoutCollector.truncated || stderrCollector.truncated
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

/**
 * 收集子进程输出并以连续 UTF-8 字节流解码。
 *
 * Node 的 data 事件不保证以字符边界切分；不能对每个 chunk 单独 toString，
 * 否则中文等多字节字符跨 chunk 时会变成替换字符。
 */
export function createOutputCollector(maxOutputBytes) {
  return {
    decoder: new StringDecoder("utf8"),
    maxOutputBytes,
    capturedBytes: 0,
    value: "",
    truncated: false,
    finalized: false
  };
}

export function appendOutput(collector, chunk) {
  if (collector.finalized || collector.truncated) return collector;
  const buffer = Buffer.from(chunk);
  const remaining = collector.maxOutputBytes - collector.capturedBytes;
  if (remaining <= 0) {
    markOutputTruncated(collector);
    return collector;
  }
  const captured = buffer.subarray(0, remaining);
  collector.capturedBytes += captured.byteLength;
  collector.value += collector.decoder.write(captured);
  if (captured.byteLength < buffer.byteLength) markOutputTruncated(collector);
  return collector;
}

export function finalizeOutput(collector) {
  if (collector.finalized) return collector;
  collector.finalized = true;
  // 截断时不 flush 可能不完整的 UTF-8 尾部，避免额外产生替换字符。
  if (!collector.truncated) collector.value += collector.decoder.end();
  return collector;
}

function markOutputTruncated(collector) {
  if (collector.truncated) return;
  collector.truncated = true;
  collector.value += "\n[truncated]";
}

export function formatCommandPartForAudit(value) {
  if (/^[A-Za-z0-9_./:=,@+-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}
