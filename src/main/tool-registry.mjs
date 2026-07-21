/**
 * agent-tool 的工具注册表和可用性闸门。
 *
 * 本模块根据当前启动配置决定哪些模型可见工具应该被暴露。rg、注入的
 * AgentSkill 和 web provider 等可选依赖缺失时，会隐藏相关工具，而不是让服务失败。
 */

import { brickDefinition } from "../brick-definition.mjs";
import { createAgentToolManifest } from "./tool-contract.mjs";
import {
  EMAIL_SEND_TOOL,
  EXEC_COMMAND_TOOL,
  RUN_SHELL_TOOL,
  SKILL_ACTIVATE_TOOL,
  SKILL_FIND_TOOL,
  SKILL_RESOURCE_TOOL,
  WEB_FETCH_TOOL,
  WEB_SEARCH_TOOL,
  WRITE_STDIN_TOOL,
  WORKSPACE_SEARCH_TOOL
} from "./tool-definitions.mjs";
import { executeEmailSend, isEmailProviderAvailable } from "./email-runtime.mjs";
import { executeRunShell } from "./shell-runtime.mjs";
import { executeWorkspaceSearch, isRgAvailable } from "./search-runtime.mjs";
import { executeSkillResource } from "./skill-resource-runtime.mjs";
import { createTerminalSessionManager } from "./terminal-runtime.mjs";
import { compressToolExecutionResult } from "./tool-result-compression.mjs";
import { executeWebFetch, executeWebSearch, isWebProviderAvailable } from "./web-runtime.mjs";

export async function createToolRegistry(config, options = {}) {
  const rgAvailability = await isRgAvailable(config.rgBin);
  const skillRuntime = normalizeSkillRuntime(options.skillRuntime);
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

  // skill 的远端搜索、安装、索引刷新都属于 AgentSkill。HTTP 服务只有在
  // 显式注入该对象时才暴露 skill 工具，避免 index-only 兼容路径承诺不存在的能力。
  if (skillRuntime) {
    tools.push(SKILL_FIND_TOOL, SKILL_ACTIVATE_TOOL);
    executors.set(SKILL_FIND_TOOL.name, (call, _currentConfig, signal) => executeInjectedSkillFind(call, skillRuntime, signal));
    executors.set(SKILL_ACTIVATE_TOOL.name, (call, _currentConfig, signal) => executeInjectedSkillActivate(call, skillRuntime, signal));
    if (hasSkillResourceApi(skillRuntime)) {
      tools.push(SKILL_RESOURCE_TOOL);
      executors.set(SKILL_RESOURCE_TOOL.name, (call, _currentConfig, signal) => executeInjectedSkillResource(call, skillRuntime, signal));
    }
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
      let execution;
      try {
        execution = await executor(call, config, signal);
      } catch (error) {
        execution = createExecutionFailureResult(call, signal, error);
      }
      return compressToolExecutionResult({
        toolName: call.toolName,
        toolCallId: call.toolCallId,
        result: execution,
        compressionEnabled: config.resultCompressionEnabled
      }).result;
    }
  };
}

function normalizeSkillRuntime(value) {
  if (!value || typeof value !== "object") return undefined;
  if (typeof value.find !== "function" || typeof value.activate !== "function") return undefined;
  return value;
}

async function executeInjectedSkillFind(call, skillRuntime, signal) {
  const result = await skillRuntime.find(call.arguments ?? {}, createSkillContext(call, signal));
  return completedSkillResult(result);
}

async function executeInjectedSkillActivate(call, skillRuntime, signal) {
  const argumentsValue = call.arguments ?? {};
  const skill = argumentsValue.skill ?? argumentsValue.name ?? argumentsValue.id;
  const result = await skillRuntime.activate(skill, createSkillContext(call, signal));
  return completedSkillResult(result);
}

async function executeInjectedSkillResource(call, skillRuntime, signal) {
  const result = await executeSkillResource(skillRuntime, call.arguments ?? {}, createSkillContext(call, signal));
  return completedSkillResult(result);
}

function createSkillContext(call, signal) {
  return {
    workspace: call.workspace?.root,
    toolCallId: call.toolCallId,
    signal
  };
}

function completedSkillResult(result) {
  return {
    status: "completed",
    content: JSON.stringify(result ?? {}, null, 2),
    details: result
  };
}

function hasSkillResourceApi(skillRuntime) {
  return typeof skillRuntime.readReference === "function" && typeof skillRuntime.resolveAsset === "function";
}

// 工具输入、索引或工作区可能在调用前后变化。这类可预期异常必须回到模型，
// 让它可以修正参数或选择其他工具，而不是由 HTTP 层把它伪装成服务故障。
function createExecutionFailureResult(call, signal, error) {
  const interrupted = signal?.aborted === true;
  const message = error instanceof Error ? error.message : String(error);
  const status = interrupted ? "interrupted" : "failed";
  const code = interrupted ? "interrupted" : "tool_execution_failed";
  return {
    status,
    content: interrupted
      ? `Tool call was interrupted: ${message}`
      : `Tool execution failed: ${message}`,
    details: {
      toolName: call.toolName,
      toolCallId: call.toolCallId,
      interrupted,
      failure: {
        code,
        message
      }
    },
    error: {
      code,
      message
    }
  };
}
