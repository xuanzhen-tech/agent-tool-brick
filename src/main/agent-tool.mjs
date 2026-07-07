/**
 * AgentTool 对象化运行时入口。
 *
 * 本文件把工具 registry、终端会话、搜索、web 和 skill 适配能力封装成
 * 一个可被 AgentCli 直接注入的对象。对象主接口只接收 workspace、
 * runtimeDependencies 和 skillRuntime，其它 provider、限流和服务细节都留在
 * 积木内部默认策略或 host 服务模式里。
 */

import { brickDefinition } from "../brick-definition.mjs";
import { createDiagnosticsReport } from "./diagnostics.mjs";
import { resolveServiceConfig } from "./launch-config.mjs";
import { createTerminalSessionManager } from "./terminal-runtime.mjs";
import {
  EXEC_COMMAND_TOOL,
  RUN_SHELL_TOOL,
  SKILL_ACTIVATE_TOOL,
  SKILL_FIND_TOOL,
  WEB_FETCH_TOOL,
  WEB_SEARCH_TOOL,
  WRITE_STDIN_TOOL,
  WORKSPACE_SEARCH_TOOL
} from "./tool-definitions.mjs";
import { createToolRegistry } from "./tool-registry.mjs";
import { isWebProviderAvailable } from "./web-runtime.mjs";

const TOOL_CALL_SCHEMA_VERSION = "agent-cli-tool.call.v1";

export class AgentTool {
  constructor(input = {}) {
    const normalizedInput = normalizeConstructorInput(input);
    this.workspace = normalizedInput.workspace;
    this.runtimeDependencies = normalizeRuntimeDependencies(normalizedInput.runtimeDependencies);
    this.skillRuntime = normalizedInput.skillRuntime;
    this.config = resolveServiceConfig(process.env, {
      workspaceRoot: normalizedInput.workspace,
      rgBin: resolveInjectedBin(this.runtimeDependencies, ["tool:rg", "rg"]),
      nodeBin: resolveInjectedBin(this.runtimeDependencies, ["node-runtime", "node"]),
      pythonBin: resolveInjectedBin(this.runtimeDependencies, ["python-runtime", "python"])
    });
    this.terminalManager = createTerminalSessionManager(this.config);
    this.registryPromise = undefined;
  }

  get definition() {
    return brickDefinition;
  }

  get definitions() {
    return selectModelToolSchemas({
      config: this.config,
      runtimeDependencies: this.runtimeDependencies,
      skillRuntime: this.skillRuntime
    });
  }

  async execute(name, args = {}, context = {}) {
    const toolName = String(name || "").trim();
    if (!toolName) return blockedResult("tool_name_required", "tool name is required");

    const parsedArgs = parseToolArguments(args);
    if (toolName === SKILL_FIND_TOOL.name || toolName === SKILL_ACTIVATE_TOOL.name) {
      return await this.executeSkillTool(toolName, parsedArgs, context);
    }

    const registry = await this.getRegistry();
    return await registry.execute({
      schemaVersion: TOOL_CALL_SCHEMA_VERSION,
      toolCallId: context.toolCallId ?? context.tool_call_id ?? `call-${Date.now().toString(36)}`,
      toolName,
      arguments: parsedArgs,
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
    const report = await createDiagnosticsReport(config, { terminalManager: this.terminalManager });
    if (this.skillRuntime) {
      report.checks.push({
        id: "tool.skill_runtime",
        status: "pass",
        summary: "AgentSkill object is injected; skill_find and skill_activate are exposed.",
        detail: `${this.skillRuntime.definitions?.length ?? 0} cached skills`
      });
      report.status = report.checks.some((check) => check.status === "fail")
        ? "fail"
        : report.checks.some((check) => check.status === "warn")
          ? "warn"
          : "pass";
    }
    return report;
  }

  async dispose() {
    this.terminalManager.closeAll("AgentTool disposed.");
  }

  async getRegistry() {
    if (!this.registryPromise) {
      this.registryPromise = createToolRegistry(this.config, { terminalManager: this.terminalManager });
    }
    return await this.registryPromise;
  }

  async executeSkillTool(toolName, args, context) {
    if (!this.skillRuntime) {
      return blockedResult("skill.unavailable", "AgentSkill runtime is not injected.");
    }
    try {
      if (toolName === SKILL_FIND_TOOL.name) {
        const result = await this.skillRuntime.find(args, context);
        return completedResult(toolName, context, result);
      }
      const skillName = args.skill ?? args.name ?? args.id;
      const result = await this.skillRuntime.activate(skillName, context);
      return completedResult(toolName, context, result);
    } catch (error) {
      return failedResult("skill.failed", error instanceof Error ? error.message : String(error));
    }
  }
}

function normalizeConstructorInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }
  return {
    workspace: input.workspace,
    runtimeDependencies: input.runtimeDependencies,
    skillRuntime: input.skillRuntime
  };
}

function selectModelToolSchemas({ config, runtimeDependencies, skillRuntime }) {
  const tools = [];
  if (config.processExecEnabled !== false) {
    tools.push(RUN_SHELL_TOOL, EXEC_COMMAND_TOOL, WRITE_STDIN_TOOL);
  }
  if (config.rgBin || hasRuntimeDependency(runtimeDependencies, ["tool:rg", "rg"])) {
    tools.push(WORKSPACE_SEARCH_TOOL);
  }
  if (skillRuntime) {
    tools.push(SKILL_FIND_TOOL, SKILL_ACTIVATE_TOOL);
  }
  if (isWebProviderAvailable(config).available) {
    tools.push(WEB_SEARCH_TOOL, WEB_FETCH_TOOL);
  }
  // AgentCli 需要的是 OpenAI-compatible tool schema，而不是带权限字段的 manifest item。
  return tools.map((tool) => tool.schema);
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

function completedResult(toolName, context, details) {
  return {
    status: "completed",
    content: JSON.stringify(details ?? {}, null, 2),
    details,
    toolName,
    toolCallId: context.toolCallId ?? context.tool_call_id
  };
}

function blockedResult(code, message) {
  return {
    status: "blocked",
    content: message,
    details: {
      blocked: true,
      reasonCode: code,
      reason: message
    },
    error: {
      code,
      message
    }
  };
}

function failedResult(code, message) {
  return {
    status: "failed",
    content: message,
    details: {
      failed: true,
      reasonCode: code,
      reason: message
    },
    error: {
      code,
      message
    }
  };
}

function normalizeRuntimeDependencies(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).map(([key, dependency]) => ({
    key,
    ...(dependency && typeof dependency === "object" ? dependency : { value: dependency })
  }));
}

function hasRuntimeDependency(dependencies, candidates) {
  return dependencies.some((dependency) => {
    const values = [dependency.key, dependency.slot, dependency.id, dependency.type, dependency.name]
      .filter(Boolean)
      .map((item) => String(item).toLowerCase());
    return candidates.some((candidate) => values.includes(candidate.toLowerCase()));
  });
}

function resolveInjectedBin(dependencies, candidates) {
  const dependency = dependencies.find((item) => {
    const values = [item.key, item.slot, item.id, item.type, item.name]
      .filter(Boolean)
      .map((value) => String(value).toLowerCase());
    return candidates.some((candidate) => values.includes(candidate.toLowerCase()));
  });
  return dependency?.bin ?? dependency?.path ?? dependency?.executable ?? dependency?.value;
}
