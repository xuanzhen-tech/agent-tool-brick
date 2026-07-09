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

function createGatewayError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
