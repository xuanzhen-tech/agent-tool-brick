/**
 * Diagnostics for agent-tool runtime dependencies and optional providers.
 *
 * The service must be able to start with optional integrations missing. This
 * file turns missing rg, skill index, or web provider configuration into
 * actionable warn checks instead of startup failures.
 */

import fs from "node:fs/promises";

import { brickDefinition } from "../brick-definition.mjs";
import { isRgAvailable } from "./search-runtime.mjs";
import { isSkillIndexAvailable } from "./skill-runtime.mjs";
import { isWebProviderAvailable } from "./web-runtime.mjs";

export async function createDiagnosticsReport(config, options = {}) {
  const checks = [];
  checks.push(createNodeRuntimeCheck(config));
  checks.push(createProcessExecCheck(config));
  checks.push(createTerminalSessionCheck(config, options.terminalManager));
  checks.push(await createRgRuntimeCheck(config));
  checks.push(await createSkillIndexCheck(config));
  checks.push(createWebProviderCheck(config));

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

async function pathAccess(filePath) {
  try {
    await fs.access(filePath);
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}
