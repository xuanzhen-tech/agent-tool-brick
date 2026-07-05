import http from "node:http";

import { createDiagnosticsReport, createHealthReport } from "./diagnostics.mjs";
import { resolveServiceConfig } from "./launch-config.mjs";
import { createToolRegistry } from "./tool-registry.mjs";
import { createToolResult, validateAgentToolCall } from "./tool-contract.mjs";

const DEFAULT_BODY_LIMIT = 1024 * 1024;

export async function createAgentToolServer(input = {}) {
  const config = input.config ?? resolveServiceConfig(process.env, input);
  const activeCalls = new Map();

  const server = http.createServer(async (request, response) => {
    try {
      if (!isAuthorized(request, config)) {
        sendJson(response, 401, { error: { code: "unauthorized", message: "Unauthorized." } });
        return;
      }

      const url = new URL(request.url || "/", `http://${request.headers.host || `${config.host}:${config.port}`}`);
      if (request.method === "GET" && url.pathname === "/api/health") {
        sendJson(response, 200, createHealthReport(config));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/tools/diagnostics") {
        sendJson(response, 200, await createDiagnosticsReport(config));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/tools/manifest") {
        const registry = await createToolRegistry(config);
        sendJson(response, 200, registry.manifest);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/tools/call") {
        const body = await readRequestJson(request);
        const validation = validateAgentToolCall(body);
        if (!validation.ok) {
          sendJson(response, 400, { error: { code: "invalid_tool_call", message: validation.errors.join("; ") } });
          return;
        }

        const registry = await createToolRegistry(config);
        const controller = new AbortController();
        activeCalls.set(body.toolCallId, {
          controller,
          toolName: body.toolName,
          startedAt: new Date().toISOString()
        });
        try {
          const execution = await registry.execute(body, controller.signal);
          sendJson(response, 200, createToolResult({
            toolCallId: body.toolCallId,
            status: execution.status,
            content: execution.content,
            details: execution.details,
            error: execution.error,
            diagnostics: execution.diagnostics,
            artifacts: execution.artifacts
          }));
        } finally {
          activeCalls.delete(body.toolCallId);
        }
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/tools/cancel") {
        const body = await readRequestJson(request);
        const toolCallId = typeof body.toolCallId === "string" ? body.toolCallId : "";
        const active = activeCalls.get(toolCallId);
        if (active) {
          active.controller.abort(body.reason || "Tool call canceled.");
        }
        sendJson(response, 200, {
          ok: true,
          canceled: Boolean(active),
          toolCallId
        });
        return;
      }

      sendJson(response, 404, { error: { code: "not_found", message: "Not found." } });
    } catch (error) {
      sendJson(response, 500, {
        error: {
          code: "internal_error",
          message: error instanceof Error ? error.message : String(error)
        }
      });
    }
  });

  return {
    config,
    server,
    activeCalls,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, config.host, () => {
          server.off("error", reject);
          resolve();
        });
      });
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : config.port;
      return {
        url: `http://${config.host}:${actualPort}`
      };
    },
    async close() {
      for (const active of activeCalls.values()) {
        active.controller.abort("Server is closing.");
      }
      activeCalls.clear();
      await new Promise((resolve) => server.close(() => resolve()));
    }
  };
}

function isAuthorized(request, config) {
  if (!config.token) return true;
  const header = request.headers["x-agent-tool-token"];
  if (header === config.token) return true;
  const authorization = request.headers.authorization;
  return authorization === `Bearer ${config.token}`;
}

async function readRequestJson(request, limit = DEFAULT_BODY_LIMIT) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > limit) throw new Error("Request body too large.");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  return JSON.parse(text);
}

function sendJson(response, statusCode, payload) {
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(body);
}
