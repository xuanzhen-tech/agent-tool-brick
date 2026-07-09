/**
 * agent-tool 的工具注册表和可用性闸门。
 *
 * 本模块根据当前启动配置决定哪些模型可见工具应该被暴露。rg、skill index
 * 和 web provider 等可选依赖缺失时，会隐藏相关工具，而不是让服务失败。
 */

import { brickDefinition } from "../brick-definition.mjs";
import { createAgentToolManifest } from "./tool-contract.mjs";
import {
  EMAIL_SEND_TOOL,
  EXEC_COMMAND_TOOL,
  RUN_SHELL_TOOL,
  SKILL_ACTIVATE_TOOL,
  SKILL_FIND_TOOL,
  WEB_FETCH_TOOL,
  WEB_SEARCH_TOOL,
  WRITE_STDIN_TOOL,
  WORKSPACE_SEARCH_TOOL
} from "./tool-definitions.mjs";
import { executeEmailSend, isEmailProviderAvailable } from "./email-runtime.mjs";
import { executeRunShell } from "./shell-runtime.mjs";
import { executeWorkspaceSearch, isRgAvailable } from "./search-runtime.mjs";
import { executeSkillActivate, executeSkillFind, isSkillIndexAvailable } from "./skill-runtime.mjs";
import { createTerminalSessionManager } from "./terminal-runtime.mjs";
import { compressToolExecutionResult } from "./tool-result-compression.mjs";
import { executeWebFetch, executeWebSearch, isWebProviderAvailable } from "./web-runtime.mjs";

export async function createToolRegistry(config, options = {}) {
  const rgAvailability = await isRgAvailable(config.rgBin);
  const skillAvailability = await isSkillIndexAvailable(config.skillIndexPath);
  const webAvailability = isWebProviderAvailable(config);
  const emailAvailability = isEmailProviderAvailable(config);
  const terminalManager = options.terminalManager ?? createTerminalSessionManager(config);
  const tools = [];
  const executors = new Map();

  if (config.processExecEnabled !== false) {
    tools.push(RUN_SHELL_TOOL, EXEC_COMMAND_TOOL, WRITE_STDIN_TOOL);
    executors.set(RUN_SHELL_TOOL.name, executeRunShell);
    executors.set(EXEC_COMMAND_TOOL.name, (call, currentConfig, signal) => terminalManager.execCommand(call, currentConfig, signal));
    executors.set(WRITE_STDIN_TOOL.name, (call, currentConfig, signal) => terminalManager.writeStdin(call, currentConfig, signal));
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

  if (emailAvailability.available) {
    tools.push(EMAIL_SEND_TOOL);
    executors.set(EMAIL_SEND_TOOL.name, executeEmailSend);
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
