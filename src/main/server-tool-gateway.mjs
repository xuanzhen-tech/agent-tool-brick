/**
 * server tool gateway 客户端。
 *
 * agent-tool 不保存 Tavily、SMTP 等服务端密钥。本模块只负责把工具调用
 * 转发到固定 Gateway；真正的 Tavily key、SMTP 密码和 provider 策略都在
 * 服务器进程中读取。
 */

export function isServerToolGatewayAvailable(config) {
  return config.toolGatewayBaseUrl
    ? { available: true, detail: `server tool gateway=${config.toolGatewayBaseUrl}` }
    : { available: false, detail: "AGENT_TOOL_GATEWAY_BASE_URL is not configured." };
}

export async function postServerToolGatewayJson(config, path, body, signal) {
  const availability = isServerToolGatewayAvailable(config);
  if (!availability.available) {
    throw createGatewayError("server_tool_gateway_unavailable", availability.detail);
  }
  const response = await fetch(joinUrl(config.toolGatewayBaseUrl, path), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
    signal
  });
  const parsed = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw createGatewayError(readErrorCode(parsed) ?? "server_tool_gateway_http_error", readErrorMessage(parsed) ?? `Server tool gateway returned HTTP ${response.status}.`);
  }
  if (parsed?.ok === false || parsed?.error) {
    throw createGatewayError(readErrorCode(parsed) ?? "server_tool_gateway_error", readErrorMessage(parsed) ?? "Server tool gateway returned an error.");
  }
  return parsed;
}

export async function postServerToolGatewayMultipart(config, path, input, signal) {
  const availability = isServerToolGatewayAvailable(config);
  if (!availability.available) {
    throw createGatewayError("server_tool_gateway_unavailable", availability.detail, {
      retryable: false
    });
  }

  const form = new FormData();
  form.set("request", JSON.stringify(input?.request ?? {}));
  if (input?.trace && Object.keys(input.trace).length > 0) {
    // trace 独立于严格的 provider request 合同。旧 Gateway 会忽略该字段，
    // 新 Gateway 则用它把图片请求关联到 thread/turn/tool call。
    form.set("trace", JSON.stringify(input.trace));
  }
  for (const image of input?.images ?? []) {
    form.append(
      "image",
      new Blob([Uint8Array.from(image.bytes)], { type: image.mimeType }),
      image.filename
    );
  }

  let response;
  try {
    response = await fetch(joinUrl(config.toolGatewayBaseUrl, path), {
      method: "POST",
      body: form,
      signal
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw createGatewayError("server_tool_gateway_network_error", error instanceof Error ? error.message : String(error), {
      retryable: false
    });
  }
  const parsed = await response.json().catch(() => ({}));
  if (!response.ok || parsed?.ok === false || parsed?.error) {
    throw createGatewayError(
      readErrorCode(parsed) ?? "server_tool_gateway_http_error",
      readErrorMessage(parsed) ?? `Server tool gateway returned HTTP ${response.status}.`,
      {
        statusCode: response.status,
        retryable: typeof parsed?.error?.retryable === "boolean"
          ? parsed.error.retryable
          : false
      }
    );
  }
  return parsed;
}

export async function requestServerToolGatewayJson(config, path, options = {}, signal) {
  const response = await requestServerToolGateway(config, path, {
    method: options.method ?? "GET",
    signal
  });
  const parsed = await response.json().catch(() => ({}));
  if (!response.ok || parsed?.ok === false || parsed?.error) {
    throw createGatewayError(
      readErrorCode(parsed) ?? "server_tool_gateway_http_error",
      readErrorMessage(parsed) ?? `Server tool gateway returned HTTP ${response.status}.`,
      {
        statusCode: response.status,
        retryable: typeof parsed?.error?.retryable === "boolean" ? parsed.error.retryable : false
      }
    );
  }
  return parsed;
}

export async function requestServerToolGatewayBinary(config, path, signal) {
  const response = await requestServerToolGateway(config, path, { method: "GET", signal });
  if (!response.ok) {
    const parsed = await response.json().catch(() => ({}));
    throw createGatewayError(
      readErrorCode(parsed) ?? "server_tool_gateway_http_error",
      readErrorMessage(parsed) ?? `Server tool gateway returned HTTP ${response.status}.`,
      {
        statusCode: response.status,
        retryable: typeof parsed?.error?.retryable === "boolean" ? parsed.error.retryable : false
      }
    );
  }
  return {
    bytes: Buffer.from(await response.arrayBuffer()),
    mimeType: response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
  };
}

async function requestServerToolGateway(config, path, options) {
  const availability = isServerToolGatewayAvailable(config);
  if (!availability.available) {
    throw createGatewayError("server_tool_gateway_unavailable", availability.detail, { retryable: false });
  }
  try {
    return await fetch(joinUrl(config.toolGatewayBaseUrl, path), {
      method: options.method,
      signal: options.signal
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw createGatewayError(
      "server_tool_gateway_network_error",
      error instanceof Error ? error.message : String(error),
      { retryable: true }
    );
  }
}

function joinUrl(baseUrl, path) {
  return `${String(baseUrl).replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

function readErrorCode(value) {
  return typeof value?.error?.code === "string" ? value.error.code : undefined;
}

function readErrorMessage(value) {
  return typeof value?.error?.message === "string"
    ? value.error.message
    : typeof value?.message === "string" ? value.message : undefined;
}

function createGatewayError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = details.statusCode;
  error.retryable = details.retryable === true;
  return error;
}
