/**
 * Provider-backed web tools for agent-tool.
 *
 * The brick exposes stable `web_search` and `web_fetch` model tools, but keeps
 * provider choice behind configuration. This mirrors the baseline Tavily/gateway
 * contract while avoiding SDK dependencies inside the runtime artifact.
 */

import { numberField, stringField } from "./env.mjs";

const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS = 20;
const FETCH_CONTENT_LIMIT = 12_000;

export function isWebProviderAvailable(config) {
  const provider = resolveWebProvider(config);
  if (!provider.available) {
    return {
      available: false,
      detail: "AGENT_TOOL_TAVILY_API_KEY, TAVILY_API_KEY, or AGENT_TOOL_WEB_GATEWAY_* is not configured."
    };
  }
  return {
    available: true,
    detail: provider.kind === "gateway" ? "generic web gateway configured" : "Tavily configured"
  };
}

export async function executeWebSearch(call, config, signal) {
  const query = stringField(call.arguments?.query);
  if (!query) {
    return blockedResult("query_required", "query is required");
  }
  const maxResults = clampMaxResults(numberField(call.arguments?.maxResults) ?? config.webMaxResults);
  const results = await getWebClient(config).search({ query, maxResults, signal });
  return {
    status: "completed",
    content: JSON.stringify({ query, results }, null, 2),
    details: {
      query,
      maxResults,
      results
    }
  };
}

export async function executeWebFetch(call, config, signal) {
  const url = stringField(call.arguments?.url);
  const validationError = validateHttpUrl(url);
  if (validationError) {
    return blockedResult("invalid_url", validationError);
  }

  const result = await getWebClient(config).fetch({ url, signal });
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
}

function getWebClient(config) {
  const provider = resolveWebProvider(config);
  if (!provider.available) {
    throw new Error("web provider is not configured.");
  }
  return provider.kind === "gateway"
    ? createGatewayWebClient(provider)
    : createTavilyWebClient(provider);
}

function resolveWebProvider(config) {
  if (config.webGatewayBaseUrl && config.webGatewayToken) {
    return {
      available: true,
      kind: "gateway",
      baseUrl: config.webGatewayBaseUrl.replace(/\/+$/, ""),
      token: config.webGatewayToken
    };
  }
  if (config.tavilyApiKey) {
    return {
      available: true,
      kind: "tavily",
      apiKey: config.tavilyApiKey
    };
  }
  return { available: false };
}

function createGatewayWebClient(provider) {
  return {
    async search({ query, maxResults, signal }) {
      const body = await postJson(`${provider.baseUrl}/web/search`, provider.token, { query, maxResults }, signal);
      const results = Array.isArray(body.results) ? body.results : [];
      return results.map(normalizeSearchResult);
    },
    async fetch({ url, signal }) {
      const body = await postJson(`${provider.baseUrl}/web/fetch`, provider.token, { url }, signal);
      return {
        title: typeof body.title === "string" ? body.title : "Untitled",
        rawContent: typeof body.rawContent === "string" ? body.rawContent : typeof body.content === "string" ? body.content : ""
      };
    }
  };
}

function createTavilyWebClient(provider) {
  return {
    async search({ query, maxResults, signal }) {
      const body = await postJson("https://api.tavily.com/search", undefined, {
        api_key: provider.apiKey,
        query,
        max_results: maxResults
      }, signal);
      const results = Array.isArray(body.results) ? body.results : [];
      return results.map(normalizeSearchResult);
    },
    async fetch({ url, signal }) {
      const body = await postJson("https://api.tavily.com/extract", undefined, {
        api_key: provider.apiKey,
        urls: [url]
      }, signal);
      const failed = Array.isArray(body.failed_results) ? body.failed_results[0] : undefined;
      if (failed?.error) {
        throw new Error(String(failed.error));
      }
      const result = Array.isArray(body.results) ? body.results[0] : undefined;
      if (!result) {
        throw new Error("No results found.");
      }
      return {
        title: typeof result.title === "string" ? result.title : "Untitled",
        rawContent: typeof result.raw_content === "string"
          ? result.raw_content
          : typeof result.rawContent === "string"
            ? result.rawContent
            : ""
      };
    }
  };
}

async function postJson(url, token, body, signal) {
  const headers = {
    "content-type": "application/json"
  };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal
  });
  const parsed = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof parsed.error === "string" ? parsed.error : `Web provider request failed: ${response.status}`);
  }
  return parsed;
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
