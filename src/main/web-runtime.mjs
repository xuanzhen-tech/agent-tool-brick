/**
 * agent-tool 中由服务端 Gateway 支撑的 web 工具。
 *
 * Tavily key 不进入产品仓库，也不进入 AgentTool 构造函数。这里只把
 * web_search/web_fetch 请求转发到 server tool gateway。
 */

import { numberField, stringField } from "./env.mjs";
import { isServerToolGatewayAvailable, postServerToolGatewayJson } from "./server-tool-gateway.mjs";

const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS = 20;
const FETCH_CONTENT_LIMIT = 12_000;

export function isWebProviderAvailable(config) {
  const gateway = isServerToolGatewayAvailable(config);
  if (!gateway.available) {
    return {
      available: false,
      detail: gateway.detail
    };
  }
  return {
    available: true,
    detail: `${gateway.detail}; server-side Tavily configuration is checked at call time.`
  };
}

export async function executeWebSearch(call, config, signal) {
  const query = stringField(call.arguments?.query);
  if (!query) {
    return blockedResult("query_required", "query is required");
  }
  const maxResults = clampMaxResults(numberField(call.arguments?.maxResults) ?? config.webMaxResults);
  try {
    const body = await postServerToolGatewayJson(config, "/api/tools/web/search", { query, maxResults }, signal);
    const results = Array.isArray(body.results) ? body.results.map(normalizeSearchResult) : [];
    return {
      status: "completed",
      content: JSON.stringify({ query, results }, null, 2),
      details: {
        query,
        maxResults,
        results
      }
    };
  } catch (error) {
    return failedResult(readErrorCode(error) ?? "web_search_failed", formatError(error), { query, maxResults });
  }
}

export async function executeWebFetch(call, config, signal) {
  const url = stringField(call.arguments?.url);
  const validationError = validateHttpUrl(url);
  if (validationError) {
    return blockedResult("invalid_url", validationError);
  }

  try {
    const result = await postServerToolGatewayJson(config, "/api/tools/web/fetch", { url }, signal);
    const rawContent = result.rawContent || "";
    if (!rawContent) {
      return blockedResult("empty_content", "No content found.");
    }

    const content = rawContent.slice(0, FETCH_CONTENT_LIMIT);
    const truncated = rawContent.length > FETCH_CONTENT_LIMIT;
    return {
      status: "completed",
      content: `# ${result.title || "Untitled"}\n\n${content}`,
      details: {
        url,
        title: result.title || "Untitled",
        bytes: Buffer.byteLength(rawContent, "utf8"),
        truncated
      }
    };
  } catch (error) {
    return failedResult(readErrorCode(error) ?? "web_fetch_failed", formatError(error), { url });
  }
}

function normalizeSearchResult(value) {
  const record = value && typeof value === "object" ? value : {};
  return {
    title: typeof record.title === "string" ? record.title : "",
    url: typeof record.url === "string" ? record.url : "",
    snippet: typeof record.snippet === "string"
      ? record.snippet
      : typeof record.content === "string"
        ? record.content
        : ""
  };
}

function validateHttpUrl(value) {
  if (!value) return "url is required";
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "URL must use http:// or https://.";
    }
  } catch {
    return "URL must include a valid schema, for example https://example.com.";
  }
  return undefined;
}

function clampMaxResults(value) {
  const parsed = Number.isInteger(value) && value > 0 ? value : DEFAULT_MAX_RESULTS;
  return Math.max(1, Math.min(parsed, MAX_RESULTS));
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

function failedResult(code, message, details = {}) {
  return {
    status: "failed",
    content: message,
    details: {
      ...details,
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

function readErrorCode(error) {
  return typeof error?.code === "string" ? error.code : undefined;
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}
