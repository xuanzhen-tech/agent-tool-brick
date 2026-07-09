/**
 * 本地 HTTP 工具服务的端到端 smoke 测试。
 *
 * 测试会在随机 localhost 端口启动服务，验证 manifest 和调用路由，并使用
 * mock web gateway，让 web 工具行为保持确定性且不依赖外部网络服务。
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { resolveServiceConfig } from "../main/launch-config.mjs";
import { createAgentToolServer } from "../main/server.mjs";

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "agent-tool-server-"));
await fs.writeFile(path.join(workspace, "server-note.txt"), "server needle", "utf8");

// 这个 skill fixture 用来证明当 AGENT_TOOL_SKILL_INDEX 指向合法 index 文件时，
// 服务能够暴露 skill_find 和 skill_activate。
const skillRoot = path.join(workspace, "skills", "server-skill");
await fs.mkdir(skillRoot, { recursive: true });
const skillFile = path.join(skillRoot, "SKILL.md");
await fs.writeFile(skillFile, "---\nname: server-skill\ndescription: Server smoke skill.\n---\n\n# Server Skill\n", "utf8");
const skillIndexPath = path.join(workspace, "agent-skill.index.json");
await fs.writeFile(skillIndexPath, JSON.stringify({
  schemaVersion: "agent-skill.index.v1",
  generatedAt: new Date().toISOString(),
  roots: [],
  skills: [{
    id: "server-skill",
    name: "server-skill",
    description: "Server smoke skill.",
    path: skillFile,
    source: "workspace",
    capabilities: ["smoke"],
    requiredTools: [],
    optionalTools: [],
    requiredEnv: [],
    enabled: true,
    contentHash: "smoke",
    bytes: 80
  }],
  diagnostics: []
}, null, 2), "utf8");
const webGateway = await createMockWebGateway();
const config = {
  ...resolveServiceConfig(process.env, {
    workspaceRoot: workspace,
    skillIndexPath,
    webGatewayBaseUrl: webGateway.url,
    webGatewayToken: "smoke-token",
    maxTimeoutMs: 10_000,
    maxOutputBytes: 16_000,
    terminalSessionTtlMs: 5_000,
    terminalMaxSessions: 4,
    terminalMaxOutputBytes: 16_000
  }),
  port: 0
};
const runtime = await createAgentToolServer({ config });
const { url } = await runtime.listen();

try {
  const health = await getJson(`${url}/api/health`);
  assert.equal(health.ok, true);

  const diagnostics = await getJson(`${url}/api/tools/diagnostics`);
  assert.equal(["pass", "warn"].includes(diagnostics.status), true);

  const manifest = await getJson(`${url}/api/tools/manifest`);
  assert.equal(manifest.schemaVersion, "agent-cli-tool.manifest.v1");
  assert.equal(manifest.tools.some((tool) => tool.name === "run_shell"), true);
  assert.equal(manifest.tools.some((tool) => tool.name === "exec_command"), true);
  assert.equal(manifest.tools.some((tool) => tool.name === "write_stdin"), true);
  assert.equal(manifest.tools.some((tool) => tool.name === "skill_find"), true);
  assert.equal(manifest.tools.some((tool) => tool.name === "web_search"), true);
  assert.equal(manifest.tools.some((tool) => tool.name === "email_send"), true);

  const result = await postJson(`${url}/api/tools/call`, {
    schemaVersion: "agent-cli-tool.call.v1",
    toolCallId: "server-call",
    toolName: "run_shell",
    arguments: {
      mode: "process",
      executable: process.execPath,
      args: ["-e", "console.log('server-ok')"]
    },
    workspace: { root: workspace },
    limits: { timeoutMs: 5_000, maxOutputChars: 8_000 }
  });
  assert.equal(result.status, "completed");
  assert.match(result.content, /server-ok/);

  const pending = postJson(`${url}/api/tools/call`, {
    schemaVersion: "agent-cli-tool.call.v1",
    toolCallId: "cancel-call",
    toolName: "run_shell",
    arguments: {
      mode: "process",
      executable: process.execPath,
      args: ["-e", "setTimeout(() => {}, 10000)"]
    },
    workspace: { root: workspace },
    limits: { timeoutMs: 10_000, maxOutputChars: 8_000 }
  });
  const canceled = await cancelUntilActive(`${url}/api/tools/cancel`, {
    toolCallId: "cancel-call",
    reason: "smoke cancel"
  });
  assert.equal(canceled.ok, true);
  assert.equal(canceled.canceled, true);
  const canceledResult = await pending;
  assert.equal(canceledResult.status, "interrupted");

  const terminalStart = await postJson(`${url}/api/tools/call`, {
    schemaVersion: "agent-cli-tool.call.v1",
    toolCallId: "server-terminal-start",
    toolName: "exec_command",
    arguments: {
      mode: "process",
      executable: process.execPath,
      args: ["-e", "console.log('server-terminal-ready'); setInterval(() => console.log('server-terminal-tick'), 200);"],
      yield_time_ms: 100,
      timeoutMs: 5_000
    },
    workspace: { root: workspace },
    limits: { timeoutMs: 5_000, maxOutputChars: 8_000 }
  });
  assert.equal(terminalStart.status, "completed");
  assert.equal(terminalStart.details.running, true);
  assert.ok(terminalStart.details.session_id);

  const sessionCanceled = await postJson(`${url}/api/tools/cancel`, {
    session_id: terminalStart.details.session_id,
    reason: "smoke terminal cancel"
  });
  assert.equal(sessionCanceled.ok, true);
  assert.equal(sessionCanceled.canceled, true);

  const terminalAfterCancel = await postJson(`${url}/api/tools/call`, {
    schemaVersion: "agent-cli-tool.call.v1",
    toolCallId: "server-terminal-after-cancel",
    toolName: "write_stdin",
    arguments: {
      session_id: terminalStart.details.session_id,
      chars: "",
      yield_time_ms: 300
    },
    workspace: { root: workspace },
    limits: { timeoutMs: 5_000, maxOutputChars: 8_000 }
  });
  assert.equal(terminalAfterCancel.status, "interrupted");

  const skillResult = await postJson(`${url}/api/tools/call`, {
    schemaVersion: "agent-cli-tool.call.v1",
    toolCallId: "server-skill-call",
    toolName: "skill_activate",
    arguments: { skill: "server-skill" },
    workspace: { root: workspace }
  });
  assert.equal(skillResult.status, "completed");
  assert.equal(skillResult.details.loadedSkill.name, "server-skill");

  const webSearch = await postJson(`${url}/api/tools/call`, {
    schemaVersion: "agent-cli-tool.call.v1",
    toolCallId: "server-web-search",
    toolName: "web_search",
    arguments: { query: "agent tool smoke" },
    workspace: { root: workspace }
  });
  assert.equal(webSearch.status, "completed");
  assert.match(webSearch.content, /Example Result/);

  const webFetch = await postJson(`${url}/api/tools/call`, {
    schemaVersion: "agent-cli-tool.call.v1",
    toolCallId: "server-web-fetch",
    toolName: "web_fetch",
    arguments: { url: "https://example.com/article" },
    workspace: { root: workspace }
  });
  assert.equal(webFetch.status, "completed");
  assert.match(webFetch.content, /Readable body/);

  const email = await postJson(`${url}/api/tools/call`, {
    schemaVersion: "agent-cli-tool.call.v1",
    toolCallId: "server-email-send",
    toolName: "email_send",
    arguments: {
      to: "ops@example.com",
      subject: "Smoke report",
      text: "server smoke email"
    },
    workspace: { root: workspace }
  });
  assert.equal(email.status, "completed");
  assert.equal(email.details.messageId, "mock-message-id");
} finally {
  await runtime.close();
  await webGateway.close();
}

console.log("[smoke-server] ok");

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    assert.fail(await response.text());
  }
  return await response.json();
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    assert.fail(await response.text());
  }
  return await response.json();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cancelUntilActive(url, body) {
  let last;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await wait(100);
    last = await postJson(url, body);
    if (last.canceled) return last;
  }
  return last;
}

async function createMockWebGateway() {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (request.method === "POST" && url.pathname === "/api/tools/web/search") {
      responseJson(response, {
        ok: true,
        results: [{ title: "Example Result", url: "https://example.com/article", snippet: "A smoke result." }]
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/tools/web/fetch") {
      responseJson(response, {
        ok: true,
        title: "Example Article",
        rawContent: "Readable body from the mock gateway."
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/tools/email/send") {
      responseJson(response, {
        ok: true,
        messageId: "mock-message-id",
        accepted: ["ops@example.com"],
        rejected: [],
        attachmentCount: 0
      });
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };
}

function responseJson(response, body) {
  response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}
