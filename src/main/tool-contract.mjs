import { resolveServiceConfig } from "./launch-config.mjs";

export const AGENT_TOOL_MANIFEST_SCHEMA_VERSION = "agent-cli-tool.manifest.v1";
export const AGENT_TOOL_CALL_SCHEMA_VERSION = "agent-cli-tool.call.v1";
export const AGENT_TOOL_RESULT_SCHEMA_VERSION = "agent-cli-tool.result.v1";

export function createAgentToolManifest(input = {}) {
  const config = input.config ?? resolveServiceConfig(input.env ?? process.env, input.overrides ?? {});
  const tools = input.tools ?? [];
  return {
    schemaVersion: AGENT_TOOL_MANIFEST_SCHEMA_VERSION,
    id: "agent-tool",
    version: input.version ?? "0.1.0",
    transport: {
      type: "http",
      baseUrl: input.baseUrl ?? config.baseUrl
    },
    tools: tools.map(toManifestTool),
    diagnostics: {
      endpoint: "/api/tools/diagnostics"
    }
  };
}

export function validateAgentToolManifest(manifest) {
  const errors = [];
  if (!isObject(manifest)) return { ok: false, errors: ["manifest must be an object"] };
  requireString(manifest, "schemaVersion", errors);
  requireString(manifest, "id", errors);
  requireString(manifest, "version", errors);
  if (manifest.schemaVersion !== AGENT_TOOL_MANIFEST_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${AGENT_TOOL_MANIFEST_SCHEMA_VERSION}`);
  }
  if (!isObject(manifest.transport)) {
    errors.push("transport must be an object");
  } else {
    requireString(manifest.transport, "type", errors, "transport");
    requireString(manifest.transport, "baseUrl", errors, "transport");
    if (manifest.transport.type !== "http") errors.push("transport.type must be http");
  }
  if (!Array.isArray(manifest.tools)) {
    errors.push("tools must be an array");
  } else {
    manifest.tools.forEach((tool, index) => {
      if (!isObject(tool)) {
        errors.push(`tools[${index}] must be an object`);
        return;
      }
      requireString(tool, "name", errors, `tools[${index}]`);
      if (!isObject(tool.schema)) errors.push(`tools[${index}].schema must be an object`);
      if (!Array.isArray(tool.permissions)) errors.push(`tools[${index}].permissions must be an array`);
      if (!Number.isInteger(tool.timeoutMs) || tool.timeoutMs <= 0) errors.push(`tools[${index}].timeoutMs must be a positive integer`);
      if (typeof tool.cancelable !== "boolean") errors.push(`tools[${index}].cancelable must be boolean`);
    });
  }
  return { ok: errors.length === 0, errors, value: errors.length === 0 ? manifest : undefined };
}

export function validateAgentToolCall(call) {
  const errors = [];
  if (!isObject(call)) return { ok: false, errors: ["tool call must be an object"] };
  if (call.schemaVersion !== undefined && call.schemaVersion !== AGENT_TOOL_CALL_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${AGENT_TOOL_CALL_SCHEMA_VERSION}`);
  }
  requireString(call, "toolCallId", errors);
  requireString(call, "toolName", errors);
  if (call.arguments !== undefined && !isObject(call.arguments)) errors.push("arguments must be an object when provided");
  if (call.workspace !== undefined && !isObject(call.workspace)) errors.push("workspace must be an object when provided");
  if (call.limits !== undefined && !isObject(call.limits)) errors.push("limits must be an object when provided");
  return { ok: errors.length === 0, errors, value: errors.length === 0 ? call : undefined };
}

export function validateAgentToolResult(result) {
  const errors = [];
  if (!isObject(result)) return { ok: false, errors: ["tool result must be an object"] };
  if (result.schemaVersion !== AGENT_TOOL_RESULT_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${AGENT_TOOL_RESULT_SCHEMA_VERSION}`);
  }
  requireString(result, "toolCallId", errors);
  requireString(result, "status", errors);
  if (!["completed", "failed", "interrupted", "blocked"].includes(result.status)) {
    errors.push("status must be completed, failed, interrupted, or blocked");
  }
  if (result.error !== undefined && !isObject(result.error)) errors.push("error must be an object when provided");
  return { ok: errors.length === 0, errors, value: errors.length === 0 ? result : undefined };
}

export function createToolResult({ toolCallId, status, content = "", details, error, diagnostics = [], artifacts = [] }) {
  return {
    schemaVersion: AGENT_TOOL_RESULT_SCHEMA_VERSION,
    toolCallId,
    status,
    content,
    ...(details !== undefined ? { details } : {}),
    ...(error !== undefined ? { error } : {}),
    diagnostics,
    artifacts
  };
}

export function formatToolResultContent(value) {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function toManifestTool(tool) {
  return {
    name: tool.name,
    description: tool.description,
    schema: tool.schema,
    permissions: tool.permissions ?? [],
    timeoutMs: tool.timeoutMs,
    cancelable: tool.cancelable === true,
    ...(tool.available === false ? { available: false } : {}),
    ...(tool.unavailableReason ? { unavailableReason: tool.unavailableReason } : {})
  };
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireString(object, key, errors, path = "") {
  const field = path ? `${path}.${key}` : key;
  if (typeof object[key] !== "string" || object[key].trim() === "") {
    errors.push(`${field} is required`);
  }
}
