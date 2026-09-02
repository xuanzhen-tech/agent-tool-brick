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
  ECOMMERCE_IMAGE_BATCH_TOOL,
  ECOMMERCE_IMAGE_EDIT_TOOL,
  ECOMMERCE_IMAGE_GENERATE_TOOL,
  ECOMMERCE_IMAGE_JOB_CANCEL_TOOL,
  ECOMMERCE_IMAGE_JOB_RETRY_TOOL,
  ECOMMERCE_IMAGE_JOB_STATUS_TOOL,
  ECOMMERCE_IMAGE_LIST_TOOL,
  ECOMMERCE_VIDEO_GENERATE_TOOL,
  ECOMMERCE_VIDEO_STATUS_TOOL,
  ECOMMERCE_VIDEO_CANCEL_TOOL,
  ECOMMERCE_VIDEO_RETRY_TOOL,
  ECOMMERCE_VIDEO_LIST_TOOL,
  EXEC_COMMAND_TOOL,
  IMAGE_PRESENT_TOOL,
  RUN_SHELL_TOOL,
  SKILL_ACTIVATE_TOOL,
  SKILL_CREATE_TOOL,
  SKILL_FIND_TOOL,
  SKILL_REMOVE_TOOL,
  SKILL_RESOURCE_TOOL,
  SPREADSHEET_COMPUTE_TOOL,
  SPREADSHEET_INSPECT_TOOL,
  SPREADSHEET_VALIDATE_TOOL,
  TOOL_RESULT_READ_TOOL,
  TOOL_RESULT_SEARCH_TOOL,
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
import { executeSkillCreate } from "./skill-create-runtime.mjs";
import { executeSkillRemove } from "./skill-remove-runtime.mjs";
import {
  executeSpreadsheetCompute,
  executeSpreadsheetInspect,
  executeSpreadsheetValidate
} from "./spreadsheet-runtime.mjs";
import { createTerminalSessionManager } from "./terminal-runtime.mjs";
import { compressToolExecutionResult } from "./tool-result-compression.mjs";
import { createToolResultStore } from "./tool-result-store.mjs";
import { executeWebFetch, executeWebSearch, isWebProviderAvailable } from "./web-runtime.mjs";
import { executeVisualizationCreateChart, executeVisualizationCreateDashboard } from "./visualization-runtime.mjs";
import {
  getProviderToolAvailability,
  isToolRequested,
  normalizeSelectedTools,
  normalizeToolProviders,
  resolveProviderToolDescriptors
} from "./tool-provider.mjs";

const BUILTIN_TOOL_NAMES = new Set([
  RUN_SHELL_TOOL.name,
  EXEC_COMMAND_TOOL.name,
  WRITE_STDIN_TOOL.name,
  WORKSPACE_SEARCH_TOOL.name,
  SKILL_FIND_TOOL.name,
  SKILL_CREATE_TOOL.name,
  SKILL_REMOVE_TOOL.name,
  SKILL_ACTIVATE_TOOL.name,
  SKILL_RESOURCE_TOOL.name,
  SPREADSHEET_INSPECT_TOOL.name,
  SPREADSHEET_COMPUTE_TOOL.name,
  SPREADSHEET_VALIDATE_TOOL.name,
  TOOL_RESULT_READ_TOOL.name,
  TOOL_RESULT_SEARCH_TOOL.name,
  WEB_SEARCH_TOOL.name,
  WEB_FETCH_TOOL.name,
  EMAIL_SEND_TOOL.name,
  IMAGE_PRESENT_TOOL.name,
  ECOMMERCE_IMAGE_GENERATE_TOOL.name,
  ECOMMERCE_IMAGE_EDIT_TOOL.name,
  ECOMMERCE_IMAGE_BATCH_TOOL.name,
  ECOMMERCE_IMAGE_JOB_STATUS_TOOL.name,
  ECOMMERCE_IMAGE_JOB_CANCEL_TOOL.name,
  ECOMMERCE_IMAGE_JOB_RETRY_TOOL.name,
  ECOMMERCE_IMAGE_LIST_TOOL.name,
  ECOMMERCE_VIDEO_GENERATE_TOOL.name,
  ECOMMERCE_VIDEO_STATUS_TOOL.name,
  ECOMMERCE_VIDEO_CANCEL_TOOL.name,
  ECOMMERCE_VIDEO_RETRY_TOOL.name,
  ECOMMERCE_VIDEO_LIST_TOOL.name,
  VISUALIZATION_CREATE_CHART_TOOL.name,
  VISUALIZATION_CREATE_DASHBOARD_TOOL.name
]);

// AgentCli 当前默认在 24K 字符执行最终上下文保护。即使 AgentTool 自身的通用
// 压缩阈值更宽，超过该值的原文也要先建立恢复引用，避免在 CLI 层才不可逆截断。
const RECOVERABLE_RESULT_THRESHOLD_CHARS = 24_000;

export async function createToolRegistry(config, options = {}) {
  const rgAvailability = await isRgAvailable(config.rgBin);
  const skillRuntime = normalizeSkillRuntime(options.skillRuntime);
  const webAvailability = isWebProviderAvailable(config);
  const emailAvailability = isEmailProviderAvailable(config);
  const imagePresentAvailability = isImagePresentAvailable();
  const ecommerceImageRuntime = options.ecommerceImageRuntime;
  const ecommerceVideoRuntime = options.ecommerceVideoRuntime;
  const terminalManager = options.terminalManager ?? createTerminalSessionManager(config);
  const selectedTools = normalizeSelectedTools(options.selectedTools);
  const providerEntries = options.providerEntries ?? normalizeToolProviders(options.toolProviders);
  const resultStore = options.resultStore ?? createToolResultStore();
  const tools = [];
  const executors = new Map();

  const addTool = (tool, executor, available = true) => {
    if (!available || !isToolRequested(tool.name, selectedTools, tool.defaultVisible !== false)) return;
    if (executors.has(tool.name)) throw new Error(`重复的工具名称: ${tool.name}`);
    tools.push(tool);
    executors.set(tool.name, executor);
  };

  // 恢复工具属于 AgentTool 的上下文基础设施，不受产品业务工具白名单影响。
  // 否则产品只选择 MCP 工具时，模型拿到 resultId 后反而没有读取入口。
  const addInfrastructureTool = (tool, executor) => {
    if (executors.has(tool.name)) throw new Error(`重复的工具名称: ${tool.name}`);
    tools.push(tool);
    executors.set(tool.name, executor);
  };

  addInfrastructureTool(TOOL_RESULT_READ_TOOL, (call, _currentConfig, signal) => executeToolResultRead(call, resultStore, signal));
  addInfrastructureTool(TOOL_RESULT_SEARCH_TOOL, (call, _currentConfig, signal) => executeToolResultSearch(call, resultStore, signal));

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
    if (typeof skillRuntime.install === "function") {
      addTool(SKILL_CREATE_TOOL, (call, _currentConfig, signal) => executeInjectedSkillCreate(call, skillRuntime, signal));
    }
    if (typeof skillRuntime.remove === "function") {
      addTool(SKILL_REMOVE_TOOL, (call, _currentConfig, signal) => executeInjectedSkillRemove(call, skillRuntime, signal));
    }
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

  if (ecommerceImageRuntime) {
    addTool(ECOMMERCE_IMAGE_GENERATE_TOOL, (call, _currentConfig, signal) => ecommerceImageRuntime.generate({ ...call, signal }));
    addTool(ECOMMERCE_IMAGE_EDIT_TOOL, (call, _currentConfig, signal) => ecommerceImageRuntime.edit({ ...call, signal }));
    addTool(ECOMMERCE_IMAGE_BATCH_TOOL, (call, _currentConfig, signal) => ecommerceImageRuntime.batch({ ...call, signal }));
    addTool(ECOMMERCE_IMAGE_JOB_STATUS_TOOL, (call, _currentConfig, signal) => ecommerceImageRuntime.jobStatus({ ...call, signal }));
    addTool(ECOMMERCE_IMAGE_JOB_CANCEL_TOOL, (call, _currentConfig, signal) => ecommerceImageRuntime.jobCancel({ ...call, signal }));
    addTool(ECOMMERCE_IMAGE_JOB_RETRY_TOOL, (call, _currentConfig, signal) => ecommerceImageRuntime.jobRetry({ ...call, signal }));
    addTool(ECOMMERCE_IMAGE_LIST_TOOL, (call, _currentConfig, signal) => ecommerceImageRuntime.list({ ...call, signal }));
  }

  if (ecommerceVideoRuntime) {
    addTool(ECOMMERCE_VIDEO_GENERATE_TOOL, (call, _currentConfig, signal) => ecommerceVideoRuntime.generate({ ...call, signal }));
    addTool(ECOMMERCE_VIDEO_STATUS_TOOL, (call, _currentConfig, signal) => ecommerceVideoRuntime.status({ ...call, signal }));
    addTool(ECOMMERCE_VIDEO_CANCEL_TOOL, (call, _currentConfig, signal) => ecommerceVideoRuntime.cancel({ ...call, signal }));
    addTool(ECOMMERCE_VIDEO_RETRY_TOOL, (call, _currentConfig, signal) => ecommerceVideoRuntime.retry({ ...call, signal }));
    addTool(ECOMMERCE_VIDEO_LIST_TOOL, (call, _currentConfig, signal) => ecommerceVideoRuntime.list({ ...call, signal }));
  }

  if (config.pythonBin) {
    addTool(SPREADSHEET_INSPECT_TOOL, executeSpreadsheetInspect);
    addTool(SPREADSHEET_COMPUTE_TOOL, executeSpreadsheetCompute);
    addTool(SPREADSHEET_VALIDATE_TOOL, executeSpreadsheetValidate);
  }

  addTool(VISUALIZATION_CREATE_CHART_TOOL, executeVisualizationCreateChart);
  addTool(VISUALIZATION_CREATE_DASHBOARD_TOOL, executeVisualizationCreateDashboard);

  return {
    get tools() {
      return [...tools, ...readVisibleProviderTools()];
    },
    get manifest() {
      // write_stdin 只有存在运行中会话时才向 HTTP 客户端暴露，和对象模式一致。
      const builtinManifestTools = terminalManager.stats().running > 0
        ? tools
        : tools.filter((tool) => tool.name !== WRITE_STDIN_TOOL.name);
      return createAgentToolManifest({
        version: brickDefinition.version,
        config,
        tools: [...builtinManifestTools, ...readVisibleProviderTools()]
      });
    },
    has(name) {
      return executors.has(name) || Boolean(resolveVisibleProviderTool(name));
    },
    async execute(call, signal, context = {}) {
      const builtinExecutor = executors.get(call.toolName);
      const providerTool = builtinExecutor ? undefined : resolveVisibleProviderTool(call.toolName);
      if (!builtinExecutor && !providerTool) {
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
        execution = builtinExecutor
          ? await builtinExecutor(call, config, signal)
          : await providerTool.providerEntry.provider.execute(call.toolName, call.arguments ?? {}, {
            ...context,
            workspace: call.workspace?.root,
            toolCallId: call.toolCallId,
            signal,
            config
          });
      } catch (error) {
        execution = createExecutionFailureResult(call, signal, error);
      }
      const compressed = compressToolExecutionResult({
        toolName: call.toolName,
        toolCallId: call.toolCallId,
        result: execution,
        compressionEnabled: config.resultCompressionEnabled
      });
      const originalChars = safeJson(execution)?.length ?? String(execution ?? "").length;
      const compressionExceededBudget = compressed.changed && [
        compressed.metadata?.originalContentChars,
        compressed.metadata?.originalDetailsChars,
        compressed.metadata?.originalResultChars
      ].some((chars) => Number(chars) > Number(compressed.metadata?.budgetChars));
      const shouldPersist = compressionExceededBudget || (
        originalChars > RECOVERABLE_RESULT_THRESHOLD_CHARS &&
        compressed.metadata?.reason !== "promoted_skill_context"
      );
      if (!shouldPersist || isToolResultRecoveryTool(call.toolName)) return compressed.result;

      try {
        const persisted = await resultStore.persist({
          threadId: call.traceContext?.threadId ?? context.threadId,
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          result: execution
        });
        return attachRecoverableResult(compressed.result, persisted);
      } catch (error) {
        return attachPersistenceFailure(compressed.result, error);
      }
    }
  };

  function readVisibleProviderTools() {
    return resolveProviderToolDescriptors(providerEntries, { reservedNames: BUILTIN_TOOL_NAMES })
      .filter(({ providerEntry, descriptor }) => {
        const availability = getProviderToolAvailability(providerEntry, descriptor);
        return availability.available && isToolRequested(descriptor.name, selectedTools, descriptor.defaultVisible);
      })
      .map(({ descriptor }) => descriptor);
  }

  function resolveVisibleProviderTool(name) {
    return resolveProviderToolDescriptors(providerEntries, { reservedNames: BUILTIN_TOOL_NAMES })
      .find(({ providerEntry, descriptor }) => {
        if (descriptor.name !== name) return false;
        const availability = getProviderToolAvailability(providerEntry, descriptor);
        return availability.available && isToolRequested(descriptor.name, selectedTools, descriptor.defaultVisible);
      });
  }
}

async function executeToolResultRead(call, resultStore, signal) {
  const args = call.arguments ?? {};
  const value = await resultStore.read({
    resultId: args.resultId,
    threadId: call.traceContext?.threadId,
    path: args.path,
    offset: args.offset,
    limit: args.limit,
    maxChars: args.maxChars,
    signal
  });
  return completedRecoveryResult("read", value);
}

async function executeToolResultSearch(call, resultStore, signal) {
  const args = call.arguments ?? {};
  const value = await resultStore.search({
    resultId: args.resultId,
    threadId: call.traceContext?.threadId,
    query: args.query,
    maxMatches: args.maxMatches,
    signal
  });
  return completedRecoveryResult("search", value);
}

function completedRecoveryResult(action, value) {
  const content = {
    action,
    ...value
  };
  return {
    status: "completed",
    // 恢复页正文只出现一次，避免 content/details 重复后再次触发 CLI 限流。
    content: JSON.stringify(content),
    details: pruneRecoveryDetails(content)
  };
}

function pruneRecoveryDetails(value) {
  return Object.fromEntries([
    "action",
    "resultRef",
    "path",
    "valueType",
    "offset",
    "limit",
    "total",
    "nextOffset",
    "oversizedItemPath",
    "query",
    "matchCount",
    "truncated",
    "guidance"
  ].filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
}

function attachRecoverableResult(result, persisted) {
  const guidance = "完整工具结果已外置保存。不要猜测被省略的数据，也不要一次读取全部结果；先用 tool_result_read 查看结构，再按 path 分页读取，或用 tool_result_search 定位关键词。";
  const nextAction = {
    tool: TOOL_RESULT_READ_TOOL.name,
    arguments: { resultId: persisted.resultRef.resultId }
  };
  const recovery = {
    resultRef: persisted.resultRef,
    availablePaths: persisted.availablePaths,
    nextAction,
    guidance
  };
  return {
    ...result,
    deliveryStatus: "recoverable_summary",
    recoverable: true,
    ...recovery,
    content: appendRecoveryToContent(result?.content, recovery),
    details: isRecord(result?.details)
      ? { ...result.details, __toolResultRecovery: recovery }
      : { value: result?.details, __toolResultRecovery: recovery }
  };
}

function attachPersistenceFailure(result, error) {
  const message = `完整工具结果超过上下文预算，但持久化失败：${error instanceof Error ? error.message : String(error)}。当前只有摘要可用，不得假设被省略内容。`;
  return {
    ...result,
    deliveryStatus: "degraded",
    recoverable: false,
    content: appendText(result?.content, message),
    details: isRecord(result?.details)
      ? { ...result.details, deliveryStatus: "degraded", recoverable: false, persistenceError: message }
      : { value: result?.details, deliveryStatus: "degraded", recoverable: false, persistenceError: message }
  };
}

function appendRecoveryToContent(content, recovery) {
  const parsed = parseJsonRecord(content);
  if (parsed) return JSON.stringify({ ...parsed, recovery }, null, 2);
  return appendText(content, JSON.stringify({ recovery }, null, 2));
}

function appendText(content, suffix) {
  const prefix = typeof content === "string" ? content.trimEnd() : JSON.stringify(content ?? {}, null, 2);
  return prefix ? `${prefix}\n\n${suffix}` : suffix;
}

function parseJsonRecord(value) {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isToolResultRecoveryTool(name) {
  return name === TOOL_RESULT_READ_TOOL.name || name === TOOL_RESULT_SEARCH_TOOL.name;
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

async function executeInjectedSkillCreate(call, skillRuntime, signal) {
  const result = await executeSkillCreate(skillRuntime, call, signal);
  return completedSkillResult(result);
}

async function executeInjectedSkillRemove(call, skillRuntime, signal) {
  const result = await executeSkillRemove(skillRuntime, call, signal);
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
  const code = interrupted
    ? "interrupted"
    : typeof error?.code === "string" && (
      error.code.startsWith("ecommerce_image_") ||
      error.code.startsWith("tool_result_") ||
      error.code.startsWith("spreadsheet_")
    )
      ? error.code
      : "tool_execution_failed";
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
