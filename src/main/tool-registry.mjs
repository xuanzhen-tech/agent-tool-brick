/**
 * Tool registry and availability gate for agent-tool.
 *
 * This module decides which model-facing tools are exposed for the current
 * launch configuration. Optional dependencies such as rg, skill index, and web
 * providers degrade by hiding their tools instead of failing the service.
 */

import { brickDefinition } from "../brick-definition.mjs";
import { createAgentToolManifest } from "./tool-contract.mjs";
import {
  RUN_SHELL_TOOL,
  SKILL_ACTIVATE_TOOL,
  SKILL_FIND_TOOL,
  WEB_FETCH_TOOL,
  WEB_SEARCH_TOOL,
  WORKSPACE_SEARCH_TOOL
} from "./tool-definitions.mjs";
import { executeRunShell } from "./shell-runtime.mjs";
import { executeWorkspaceSearch, isRgAvailable } from "./search-runtime.mjs";
import { executeSkillActivate, executeSkillFind, isSkillIndexAvailable } from "./skill-runtime.mjs";
import { compressToolExecutionResult } from "./tool-result-compression.mjs";
import { executeWebFetch, executeWebSearch, isWebProviderAvailable } from "./web-runtime.mjs";

export async function createToolRegistry(config) {
  const rgAvailability = await isRgAvailable(config.rgBin);
  const skillAvailability = await isSkillIndexAvailable(config.skillIndexPath);
  const webAvailability = isWebProviderAvailable(config);
  const tools = [];
  const executors = new Map();

  if (config.processExecEnabled !== false) {
    tools.push(RUN_SHELL_TOOL);
    executors.set(RUN_SHELL_TOOL.name, executeRunShell);
  }

  if (rgAvailability.available) {
    tools.push(WORKSPACE_SEARCH_TOOL);
    executors.set(WORKSPACE_SEARCH_TOOL.name, executeWorkspaceSearch);
  }

  if (skillAvailability.available) {
    tools.push(SKILL_FIND_TOOL, SKILL_ACTIVATE_TOOL);
    executors.set(SKILL_FIND_TOOL.name, executeSkillFind);
    executors.set(SKILL_ACTIVATE_TOOL.name, executeSkillActivate);
  }

  if (webAvailability.available) {
    tools.push(WEB_SEARCH_TOOL, WEB_FETCH_TOOL);
    executors.set(WEB_SEARCH_TOOL.name, executeWebSearch);
    executors.set(WEB_FETCH_TOOL.name, executeWebFetch);
  }

  return {
    tools,
    manifest: createAgentToolManifest({
      version: brickDefinition.version,
      config,
      tools
    }),
    has(name) {
      return executors.has(name);
    },
    async execute(call, signal) {
      const executor = executors.get(call.toolName);
      if (!executor) {
        return {
          status: "blocked",
          content: `Unknown or unavailable tool: ${call.toolName}`,
          details: {
            blocked: true,
            reasonCode: "tool_unavailable",
            reason: `Unknown or unavailable tool: ${call.toolName}`
          },
          error: {
            code: "tool_unavailable",
            message: `Unknown or unavailable tool: ${call.toolName}`
          }
        };
      }
      const execution = await executor(call, config, signal);
      return compressToolExecutionResult({
        toolName: call.toolName,
        toolCallId: call.toolCallId,
        result: execution,
        compressionEnabled: config.resultCompressionEnabled
      }).result;
    }
  };
}
