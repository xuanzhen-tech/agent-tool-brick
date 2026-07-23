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
  IMAGE_PRESENT_TOOL,
  RUN_SHELL_TOOL,
  SKILL_ACTIVATE_TOOL,
  SKILL_FIND_TOOL,
  SKILL_RESOURCE_TOOL,
  VISUALIZATION_CREATE_CHART_TOOL,
  VISUALIZATION_CREATE_DASHBOARD_TOOL,
  WEB_FETCH_TOOL,
  WEB_SEARCH_TOOL,
  WRITE_STDIN_TOOL,
  WORKSPACE_SEARCH_TOOL
} from "./tool-definitions.mjs";
import { executeEmailSend, isEmailProviderAvailable } from "./email-runtime.mjs";
import { executeImagePresent, isImagePresentAvailable } from "./image-runtime.mjs";
import { executeRunShell } from "./shell-runtime.mjs";
import { executeWorkspaceSearch, isRgAvailable } from "./search-runtime.mjs";
import { executeSkillResource } from "./skill-resource-runtime.mjs";
import { createTerminalSessionManager } from "./terminal-runtime.mjs";
import { compressToolExecutionResult } from "./tool-result-compression.mjs";
import { executeWebFetch, executeWebSearch, isWebProviderAvailable } from "./web-runtime.mjs";
import { executeVisualizationCreateChart, executeVisualizationCreateDashboard } from "./visualization-runtime.mjs";
import { getProviderToolAvailability, isToolRequested, normalizeSelectedTools, normalizeToolProviders } from "./tool-provider.mjs";

export async function createToolRegistry(config, options = {}) {
  const rgAvailability = await isRgAvailable(config.rgBin);
  const skillRuntime = normalizeSkillRuntime(options.skillRuntime);
  const webAvailability = isWebProviderAvailable(config);
  const emailAvailability = isEmailProviderAvailable(config);
  const imagePresentAvailability = isImagePresentAvailable();
  const terminalManager = options.terminalManager ?? createTerminalSessionManager(config);
  const selectedTools = normalizeSelectedTools(options.selectedTools);
  const providerEntries = options.providerEntries ?? normalizeToolProviders(options.toolProviders);
  const tools = [];
  const executors = new Map();

  const addTool = (tool, executor, available = true) => {
    if (!available || !isToolRequested(tool.name, selectedTools, tool.defaultVisible !== false)) return;
    if (executors.has(tool.name)) throw new Error(`重复的工具名称: ${tool.name}`);
    tools.push(tool);
    executors.set(tool.name, executor);
  };

  if (config.processExecEnabled !== false) {
    addTool(RUN_SHELL_TOOL, executeRunShell);
    addTool(EXEC_COMMAND_TOOL, (call, currentConfig, signal) => terminalManager.execCommand(call, currentConfig, signal));
    addTool(WRITE_STDIN_TOOL, (call, currentConfig, signal) => terminalManager.writeStdin(call, currentConfig, signal));
  }

  if (rgAvailability.available) {
    addTool(WORKSPACE_SEARCH_TOOL, executeWorkspaceSearch);
  }

  // skill 的远端搜索、安装、索引刷新都属于 AgentSkill。HTTP 服务只有在
  // 显式注入该对象时才暴露 skill 工具，避免 index-only 兼容路径承诺不存在的能力。
  if (skillRuntime) {
    addTool(SKILL_FIND_TOOL, (call, _currentConfig, signal) => executeInjectedSkillFind(call, skillRuntime, signal));
    addTool(SKILL_ACTIVATE_TOOL, (call, _currentConfig, signal) => executeInjectedSkillActivate(call, skillRuntime, signal));
    if (hasSkillResourceApi(skillRuntime)) {
      addTool(SKILL_RESOURCE_TOOL, (call, _currentConfig, signal) => executeInjectedSkillResource(call, skillRuntime, signal));
    }
  }

  if (webAvailability.available) {
    addTool(WEB_SEARCH_TOOL, executeWebSearch);
    addTool(WEB_FETCH_TOOL, executeWebFetch);
  }

  if (emailAvailability.available) {
    addTool(EMAIL_SEND_TOOL, executeEmailSend);
  }

  if (imagePresentAvailability.available) {
    addTool(IMAGE_PRESENT_TOOL, executeImagePresent);
  }

  addTool(VISUALIZATION_CREATE_CHART_TOOL, executeVisualizationCreateChart);
  addTool(VISUALIZATION_CREATE_DASHBOARD_TOOL, executeVisualizationCreateDashboard);

  for (const providerEntry of providerEntries) {
    for (const descriptor of providerEntry.descriptors) {
      const availability = getProviderToolAvailability(providerEntry, descriptor);
      addTool(descriptor, (call, currentConfig, signal) => providerEntry.provider.execute(call.toolName, call.arguments ?? {}, {
        workspace: call.workspace?.root,
        toolCallId: call.toolCallId,
        signal,
        config: currentConfig
      }), availability.available);
    }
  }

  return {
    tools,
    get manifest() {
      // write_stdin 只有存在运行中会话时才向 HTTP 客户端暴露，和对象模式一致。
      const manifestTools = terminalManager.stats().running > 0
        ? tools
        : tools.filter((tool) => tool.name !== WRITE_STDIN_TOOL.name);
      return createAgentToolManifest({ version: brickDefinition.version, config, tools: manifestTools });
    },
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
