import { brickDefinition } from "../brick-definition.mjs";
import { createAgentToolManifest } from "./tool-contract.mjs";
import { RUN_SHELL_TOOL, WORKSPACE_SEARCH_TOOL } from "./tool-definitions.mjs";
import { executeRunShell } from "./shell-runtime.mjs";
import { executeWorkspaceSearch, isRgAvailable } from "./search-runtime.mjs";
import { compressToolExecutionResult } from "./tool-result-compression.mjs";

export async function createToolRegistry(config) {
  const rgAvailability = await isRgAvailable(config.rgBin);
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
