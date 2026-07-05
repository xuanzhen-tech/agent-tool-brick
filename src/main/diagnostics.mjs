import fs from "node:fs/promises";

import { brickDefinition } from "../brick-definition.mjs";
import { isRgAvailable } from "./search-runtime.mjs";

export async function createDiagnosticsReport(config) {
  const checks = [];
  checks.push(createNodeRuntimeCheck(config));
  checks.push(createProcessExecCheck(config));
  checks.push(await createRgRuntimeCheck(config));

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

async function pathAccess(filePath) {
  try {
    await fs.access(filePath);
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}
