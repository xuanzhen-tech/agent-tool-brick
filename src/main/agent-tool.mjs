/**
 * 【文件说明】
 * 本文件是 AgentTool 的对象化运行时入口。
 *
 * 它把内置工具、注入的 AgentSkill 和外部 Tool Provider 聚合成一个稳定对象，
 * 统一处理工具白名单、模型 schema、结果压缩、诊断和 HTTP 服务。AgentCli 只需
 * 注入这个对象，不需要理解图表、PPT 等复杂能力 brick 的内部实现。
 */

import { brickDefinition } from "../brick-definition.mjs";
import { createDiagnosticsReport } from "./diagnostics.mjs";
import { isEmailProviderAvailable } from "./email-runtime.mjs";
import { isImagePresentAvailable } from "./image-runtime.mjs";
import { resolveServiceConfig } from "./launch-config.mjs";
import { createRuntimeDependencyConfig } from "./runtime-dependency-config.mjs";
import { createTerminalSessionManager } from "./terminal-runtime.mjs";
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
  WORKSPACE_SEARCH_TOOL,
  WRITE_STDIN_TOOL
} from "./tool-definitions.mjs";
import { getProviderToolAvailability, isToolRequested, normalizeSelectedTools, normalizeToolProviders } from "./tool-provider.mjs";
import { createToolRegistry } from "./tool-registry.mjs";
import { isWebProviderAvailable } from "./web-runtime.mjs";

const TOOL_CALL_SCHEMA_VERSION = "agent-cli-tool.call.v1";
const BUILTIN_TOOL_NAMES = new Set([
  RUN_SHELL_TOOL.name,
  EXEC_COMMAND_TOOL.name,
  WRITE_STDIN_TOOL.name,
  WORKSPACE_SEARCH_TOOL.name,
  SKILL_FIND_TOOL.name,
  SKILL_ACTIVATE_TOOL.name,
  SKILL_RESOURCE_TOOL.name,
  WEB_SEARCH_TOOL.name,
  WEB_FETCH_TOOL.name,
  EMAIL_SEND_TOOL.name,
  IMAGE_PRESENT_TOOL.name,
  VISUALIZATION_CREATE_CHART_TOOL.name,
  VISUALIZATION_CREATE_DASHBOARD_TOOL.name
]);

export class AgentTool {
  constructor(input = {}) {
    const normalizedInput = normalizeConstructorInput(input);
    this.workspace = normalizedInput.workspace;
    this.runtimeDependencies = normalizeRuntimeDependencies(normalizedInput.runtimeDependencies);
    this.skillRuntime = normalizedInput.skillRuntime;
    this.selectedTools = normalizeSelectedTools(normalizedInput.tools);
    this.toolProviders = normalizeToolProviders(normalizedInput.toolProviders);
    assertProviderToolsDoNotShadowBuiltIns(this.toolProviders);

    const runtimeConfig = createRuntimeDependencyConfig(this.runtimeDependencies);
    this.config = resolveServiceConfig(process.env, {
      workspaceRoot: normalizedInput.workspace,
      rgBin: resolveInjectedBin(this.runtimeDependencies, ["tool:rg", "rg"]),
      nodeBin: resolveInjectedBin(this.runtimeDependencies, ["node-runtime", "node"]),
      pythonBin: resolveInjectedBin(this.runtimeDependencies, ["python-runtime", "python"]),
      ...runtimeConfig
    });
    this.terminalManager = createTerminalSessionManager(this.config);
    this.registryPromise = undefined;
  }

  get definition() {
    return brickDefinition;
  }

  /**
   * 返回当前模型实际可见的 OpenAI-compatible schema。
   * tools 未传入时只保留历史默认工具；显式传入 tools 后，内置工具与 Provider
   * 工具都必须经过同一份名称白名单和可用性检查。
   */
  get definitions() {
    return selectModelToolSchemas({
      config: this.config,
      runtimeDependencies: this.runtimeDependencies,
      skillRuntime: this.skillRuntime,
      terminalManager: this.terminalManager,
      selectedTools: this.selectedTools,
      toolProviders: this.toolProviders
    });
  }

  async execute(name, args = {}, context = {}) {
    const toolName = String(name || "").trim();
    if (!toolName) return blockedResult("tool_name_required", "工具名称不能为空。 ");

    const registry = await this.getRegistry();
    return await registry.execute({
      schemaVersion: TOOL_CALL_SCHEMA_VERSION,
      toolCallId: context.toolCallId ?? context.tool_call_id ?? `call-${Date.now().toString(36)}`,
      toolName,
      arguments: parseToolArguments(args),
      workspace: {
        root: context.workspace ?? context.workingDirectory ?? this.workspace ?? this.config.workspaceRoot
      },
      limits: {
        timeoutMs: context.timeoutMs,
        maxOutputChars: context.maxOutputChars
      }
    }, context.signal);
  }

  async diagnostics(context = {}) {
    const config = {
      ...this.config,
      workspaceRoot: context.workspace ?? context.workingDirectory ?? this.workspace ?? this.config.workspaceRoot
    };
    const report = await createDiagnosticsReport(config, {
      terminalManager: this.terminalManager,
      skillRuntime: this.skillRuntime
    });
    report.checks.push(...createCompositionChecks({
      selectedTools: this.selectedTools,
      toolProviders: this.toolProviders,
      definitions: this.definitions
    }));
    report.status = report.checks.some((check) => check.status === "fail")
      ? "fail"
      : report.checks.some((check) => check.status === "warn")
        ? "warn"
        : "pass";
    return report;
  }

  // 使用同一对象启动 HTTP transport，保证 Provider、skill runtime 和终端会话不被拆开。
  async createServer(input = {}) {
    const { createAgentToolServer } = await import("./server.mjs");
    return await createAgentToolServer({
      ...input,
      config: input.config ?? this.config,
      terminalManager: input.terminalManager ?? this.terminalManager,
      skillRuntime: input.skillRuntime ?? this.skillRuntime,
      selectedTools: input.selectedTools ?? this.selectedTools,
      providerEntries: input.providerEntries ?? this.toolProviders,
      createRegistry: input.createRegistry ?? (() => this.getRegistry())
    });
  }

  async dispose() {
    this.terminalManager.closeAll("AgentTool 已释放。");
    await Promise.all(this.toolProviders.map(async ({ provider }) => {
      if (typeof provider.dispose === "function") await provider.dispose();
    }));
  }

  async getRegistry() {
    if (!this.registryPromise) {
      this.registryPromise = createToolRegistry(this.config, {
        terminalManager: this.terminalManager,
        skillRuntime: this.skillRuntime,
        selectedTools: this.selectedTools,
        providerEntries: this.toolProviders
      });
    }
    return await this.registryPromise;
  }
}

function normalizeConstructorInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  return {
    workspace: input.workspace,
    runtimeDependencies: input.runtimeDependencies,
    skillRuntime: input.skillRuntime,
    tools: input.tools,
    toolProviders: input.toolProviders
  };
}

function selectModelToolSchemas({ config, runtimeDependencies, skillRuntime, terminalManager, selectedTools, toolProviders }) {
  const tools = [];
  const add = (tool, available = true) => {
    if (available && isToolRequested(tool.name, selectedTools, tool.defaultVisible !== false)) {
      tools.push(tool);
    }
  };

  if (config.processExecEnabled !== false) {
    add(RUN_SHELL_TOOL);
    add(EXEC_COMMAND_TOOL);
    if (terminalManager?.stats().running > 0) add(WRITE_STDIN_TOOL);
  }
  add(WORKSPACE_SEARCH_TOOL, Boolean(config.rgBin || hasRuntimeDependency(runtimeDependencies, ["tool:rg", "rg"])));
  if (skillRuntime) {
    add(SKILL_FIND_TOOL);
    add(SKILL_ACTIVATE_TOOL);
    add(SKILL_RESOURCE_TOOL, hasSkillResourceApi(skillRuntime));
  }
  if (isWebProviderAvailable(config).available) {
    add(WEB_SEARCH_TOOL);
    add(WEB_FETCH_TOOL);
  }
  add(EMAIL_SEND_TOOL, isEmailProviderAvailable(config).available);
  add(IMAGE_PRESENT_TOOL, isImagePresentAvailable().available);
  add(VISUALIZATION_CREATE_CHART_TOOL);
  add(VISUALIZATION_CREATE_DASHBOARD_TOOL);

  for (const providerEntry of toolProviders) {
    for (const descriptor of providerEntry.descriptors) {
      const availability = getProviderToolAvailability(providerEntry, descriptor);
      if (availability.available && isToolRequested(descriptor.name, selectedTools, descriptor.defaultVisible)) {
        tools.push(descriptor);
      }
    }
  }
  return tools.map((tool) => decorateToolSchemaForRuntime(tool.schema, config));
}

function createCompositionChecks({ selectedTools, toolProviders, definitions }) {
  const visibleNames = new Set(definitions.map((definition) => definition?.function?.name).filter(Boolean));
  const knownNames = new Set(BUILTIN_TOOL_NAMES);
  for (const provider of toolProviders) {
    for (const descriptor of provider.descriptors) knownNames.add(descriptor.name);
  }
  const checks = [{
    id: "tool.composition",
    status: "pass",
    summary: selectedTools === undefined
      ? "使用历史默认工具集合；新增预制工具未自动暴露。"
      : `已按白名单选择 ${selectedTools.size} 个工具。`,
    detail: `visible=${[...visibleNames].join(",") || "none"}`
  }];
  if (selectedTools !== undefined) {
    const unknown = [...selectedTools].filter((name) => !knownNames.has(name));
    if (unknown.length) {
      checks.push({
        id: "tool.selection",
        status: "warn",
        summary: "部分请求工具不存在于当前 AgentTool 组合中。",
        detail: unknown.join(", ")
      });
    }
    const unavailable = [...selectedTools].filter((name) => knownNames.has(name) && !visibleNames.has(name));
    if (unavailable.length) {
      checks.push({
        id: "tool.availability",
        status: "warn",
        summary: "部分已选择工具因运行时或会话条件未暴露。",
        detail: unavailable.join(", ")
      });
    }
  }
  for (const providerEntry of toolProviders) {
    if (typeof providerEntry.provider.diagnostics !== "function") continue;
    checks.push({
      id: `tool.provider.${providerEntry.id}`,
      status: "pass",
      summary: `已注入 Tool Provider: ${providerEntry.id}`,
      detail: providerEntry.descriptors.map((item) => item.name).join(", ")
    });
  }
  return checks;
}

function assertProviderToolsDoNotShadowBuiltIns(toolProviders) {
  for (const providerEntry of toolProviders) {
    for (const descriptor of providerEntry.descriptors) {
      if (BUILTIN_TOOL_NAMES.has(descriptor.name)) {
        throw new Error(`Tool Provider ${providerEntry.id} 不能覆盖内置工具: ${descriptor.name}`);
      }
    }
  }
}

function hasSkillResourceApi(skillRuntime) {
  return Boolean(skillRuntime && typeof skillRuntime.readReference === "function" && typeof skillRuntime.resolveAsset === "function");
}

function decorateToolSchemaForRuntime(schema, config = {}) {
  const name = schema?.function?.name;
  if (!["run_shell", "exec_command"].includes(name)) return schema;
  const packageNames = Array.isArray(config.nodePackageNames) ? config.nodePackageNames : [];
  const hasPlaywrightPackage = packageNames.some((packageName) => packageName.toLowerCase() === "playwright");
  if (!packageNames.length && !config.playwrightBrowsersPath) return schema;
  const clone = JSON.parse(JSON.stringify(schema));
  const hints = [];
  if (packageNames.length > 0) hints.push(`产品注入的 Node 包可供子进程使用：${packageNames.join(", ")}。`);
  if (hasPlaywrightPackage && config.playwrightBrowsersPath) {
    hints.push("Playwright Chromium 缓存已通过 PLAYWRIGHT_BROWSERS_PATH 配置。");
  } else if (config.playwrightBrowsersPath) {
    hints.push("已配置 Playwright 浏览器缓存路径 PLAYWRIGHT_BROWSERS_PATH。 ");
  }
  clone.function.description = `${clone.function.description} ${hints.join(" ")}`;
  return clone;
}

function parseToolArguments(args) {
  if (args === undefined || args === null || args === "") return {};
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return args && typeof args === "object" && !Array.isArray(args) ? args : {};
}

function blockedResult(code, message) {
  return {
    status: "blocked",
    content: message,
    details: { blocked: true, reasonCode: code, reason: message },
    error: { code, message }
  };
}

function normalizeRuntimeDependencies(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).map(([key, dependency]) => ({ key, ...(dependency && typeof dependency === "object" ? dependency : { value: dependency }) }));
}

function hasRuntimeDependency(dependencies, candidates) {
  return dependencies.some((dependency) => {
    const values = [dependency.key, dependency.slot, dependency.id, dependency.type, dependency.name].filter(Boolean).map((item) => String(item).toLowerCase());
    return candidates.some((candidate) => values.includes(candidate.toLowerCase()));
  });
}

function resolveInjectedBin(dependencies, candidates) {
  const dependency = dependencies.find((item) => {
    const values = [item.key, item.slot, item.id, item.type, item.name].filter(Boolean).map((value) => String(value).toLowerCase());
    return candidates.some((candidate) => values.includes(candidate.toLowerCase()));
  });
  return dependency?.bin ?? dependency?.path ?? dependency?.executable ?? dependency?.value;
}
