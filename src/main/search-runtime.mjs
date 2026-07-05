import fs from "node:fs/promises";
import path from "node:path";

import { numberField, stringField } from "./env.mjs";
import { runProcess } from "./process-runtime.mjs";
import { getWorkspaceRootFromCall, resolveInsideWorkspace } from "./workspace.mjs";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_MATCHES = 80;

export async function isRgAvailable(rgBin) {
  const command = rgBin || "rg";
  try {
    const result = await runProcess({
      executable: command,
      args: ["--version"],
      cwd: process.cwd(),
      timeoutMs: 5_000,
      maxOutputBytes: 8_000
    });
    return {
      available: result.exitCode === 0,
      command,
      detail: firstLine(result.stdout || result.stderr)
    };
  } catch (error) {
    return {
      available: false,
      command,
      detail: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function executeWorkspaceSearch(call, config, signal) {
  const rgBin = config.rgBin || "rg";
  const availability = await isRgAvailable(config.rgBin);
  if (!availability.available) {
    return {
      status: "blocked",
      content: "rg tool runtime is not available",
      details: {
        blocked: true,
        reasonCode: "rg_unavailable",
        reason: availability.detail || "rg tool runtime is not available"
      }
    };
  }

  const query = stringField(call.arguments?.query);
  if (!query) {
    return {
      status: "blocked",
      content: "query is required",
      details: {
        blocked: true,
        reasonCode: "query_required",
        reason: "query is required"
      }
    };
  }

  const workspaceRoot = path.resolve(getWorkspaceRootFromCall(call, config));
  const target = resolveInsideWorkspace(workspaceRoot, call.arguments?.path || ".");
  await fs.access(target.absolutePath);

  const maxMatches = normalizeMaxMatches(numberField(call.arguments?.maxMatches));
  const timeoutMs = Math.min(Number(call.limits?.timeoutMs) || DEFAULT_TIMEOUT_MS, config.maxTimeoutMs);
  const maxOutputBytes = Math.min(Number(call.limits?.maxOutputChars) || config.maxOutputBytes, config.maxOutputBytes);
  const args = [
    "--line-number",
    "--column",
    "--no-heading",
    "--color",
    "never",
    "--max-count",
    String(maxMatches)
  ];

  const glob = stringField(call.arguments?.glob);
  if (glob) args.push("--glob", glob);
  args.push("--", query, target.relativePath === "." ? "." : target.relativePath);

  const result = await runProcess({
    executable: rgBin,
    args,
    cwd: workspaceRoot,
    timeoutMs,
    maxOutputBytes,
    signal
  });

  const details = {
    query,
    path: target.relativePath,
    glob,
    exitCode: result.exitCode,
    matches: parseRgOutput(result.stdout),
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut,
    interrupted: result.interrupted,
    truncated: result.truncated,
    cwd: workspaceRoot
  };

  if (result.interrupted) {
    return {
      status: "interrupted",
      content: formatSearchContent(details),
      details,
      error: {
        code: "interrupted",
        message: "Tool call was interrupted."
      }
    };
  }

  if (result.exitCode === 0 || result.exitCode === 1) {
    return {
      status: "completed",
      content: formatSearchContent(details),
      details
    };
  }

  return {
    status: "failed",
    content: formatSearchContent(details),
    details,
    error: {
      code: result.timedOut ? "timeout" : "rg_failed",
      message: result.timedOut ? `workspace_search timed out after ${timeoutMs}ms.` : `rg exited with code ${result.exitCode}.`
    }
  };
}

function parseRgOutput(stdout) {
  if (!stdout.trim()) return [];
  return stdout.split(/\r?\n/).filter(Boolean).map((line) => {
    const match = line.match(/^(.+?):(\d+):(\d+):(.*)$/);
    if (!match) return { raw: line };
    return {
      path: match[1],
      line: Number(match[2]),
      column: Number(match[3]),
      text: match[4]
    };
  });
}

function normalizeMaxMatches(value) {
  if (!Number.isFinite(Number(value)) || Number(value) <= 0) return DEFAULT_MAX_MATCHES;
  return Math.min(Math.floor(Number(value)), 500);
}

function formatSearchContent(details) {
  return JSON.stringify({
    query: details.query,
    path: details.path,
    matches: details.matches,
    timedOut: details.timedOut,
    interrupted: details.interrupted,
    truncated: details.truncated
  }, null, 2);
}

function firstLine(value) {
  return String(value || "").split(/\r?\n/).find((line) => line.trim())?.trim();
}
