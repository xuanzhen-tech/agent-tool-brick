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

import { AgentTool } from "../index.mjs";
import { resolveServiceConfig } from "../main/launch-config.mjs";
import { createAgentToolServer } from "../main/server.mjs";

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "agent-tool-server-"));
await fs.writeFile(path.join(workspace, "server-note.txt"), "server needle", "utf8");

// 这个 fixture 模拟产品注入的 AgentSkill 对象。服务不自行读取 index 来伪造
// 远端能力，skill_find / skill_activate 必须委托真实的 skill runtime。
const skillRoot = path.join(workspace, "skills", "server-skill");
await fs.mkdir(skillRoot, { recursive: true });
const skillFile = path.join(skillRoot, "SKILL.md");
await fs.writeFile(skillFile, "---\nname: server-skill\ndescription: Server smoke skill.\n---\n\n# Server Skill\n", "utf8");
const webGateway = await createMockWebGateway();
const skillCalls = [];
const skillRuntime = {
  definitions: [{ name: "server-skill", description: "Server smoke skill." }],
  async find(input, context) {
    skillCalls.push({ operation: "find", input, context });
    if (input.action === "install") {
      return {
        action: "install",
        installed: [{ name: "remote-skill", path: path.join(skillRoot, "remote-skill", "SKILL.md"), source: "skills-sh" }],
        skills: [{ name: "remote-skill" }]
      };
    }
    return {
      action: "search",
      skills: [{ name: "server-skill" }],
      candidates: [{ name: "remote-skill", package: "owner/repo@remote-skill", source: "skills-sh" }]
    };
  },
  async activate(name, context) {
    skillCalls.push({ operation: "activate", name, context });
    if (name !== "server-skill") throw new Error(`Unknown skill: ${name}`);
    return {
      activated: true,
      loadedSkill: { name, content: "# Server Skill", contentHash: "smoke", bytes: 14 }
    };
  }
};
const config = {
  ...resolveServiceConfig(process.env, {
    workspaceRoot: workspace,
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
const runtime = await createAgentToolServer({ config, skillRuntime });
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
  // 没有持续终端时不向模型暴露 write_stdin，避免把它误用成文件写入工具。
  assert.equal(manifest.tools.some((tool) => tool.name === "write_stdin"), false);
  assert.equal(manifest.tools.some((tool) => tool.name === "skill_find"), true);
  assert.equal(manifest.tools.some((tool) => tool.name === "web_search"), true);
  assert.equal(manifest.tools.some((tool) => tool.name === "email_send"), true);

  const skillSearch = await postJson(`${url}/api/tools/call`, {
    schemaVersion: "agent-cli-tool.call.v1",
    toolCallId: "server-skill-search",
    toolName: "skill_find",
    arguments: { action: "search", source: "skills-sh", query: "remote" },
    workspace: { root: workspace }
  });
  assert.equal(skillSearch.status, "completed");
  assert.equal(skillSearch.details.candidates[0].source, "skills-sh");

  const skillInstall = await postJson(`${url}/api/tools/call`, {
    schemaVersion: "agent-cli-tool.call.v1",
    toolCallId: "server-skill-install",
    toolName: "skill_find",
    arguments: { action: "install", source: "skills-sh", package: "owner/repo@remote-skill" },
    workspace: { root: workspace }
  });
  assert.equal(skillInstall.status, "completed");
  assert.equal(skillInstall.details.installed[0].source, "skills-sh");
  assert.deepEqual(skillCalls.find((call) => call.operation === "find" && call.input.action === "install")?.input, {
    action: "install",
    source: "skills-sh",
    package: "owner/repo@remote-skill"
  });

  if (manifest.tools.some((tool) => tool.name === "workspace_search")) {
    const missingPathSearch = await postJson(`${url}/api/tools/call`, {
      schemaVersion: "agent-cli-tool.call.v1",
      toolCallId: "server-search-missing-path",
      toolName: "workspace_search",
      arguments: { query: "needle", path: "does-not-exist" },
      workspace: { root: workspace }
    });
    assert.equal(missingPathSearch.status, "failed");
    assert.equal(missingPathSearch.error.code, "tool_execution_failed");
  }

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

  const activeSessionManifest = await getJson(`${url}/api/tools/manifest`);
  assert.equal(activeSessionManifest.tools.some((tool) => tool.name === "write_stdin"), true);

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

  // 独立 serve 没有 AgentSkill 对象时不能承诺远端能力，因此不暴露 skill 工具。
  const standaloneRuntime = await createAgentToolServer({ config: { ...config, port: 0 } });
  const standalone = await standaloneRuntime.listen();
  try {
    const standaloneManifest = await getJson(`${standalone.url}/api/tools/manifest`);
    assert.equal(standaloneManifest.tools.some((tool) => tool.name === "skill_find"), false);
    assert.equal(standaloneManifest.tools.some((tool) => tool.name === "skill_activate"), false);
  } finally {
    await standaloneRuntime.close();
  }

  // AgentTool 的对象模式可以把复杂 brick 作为 Provider 组合后再暴露 HTTP transport。
  // 这里验证 manifest 和执行路径都复用同一个 Provider，而非只有 SDK 直调能生效。
  const provider = {
    id: "server-provider",
    toolDescriptors: [{
      name: "provider_echo",
      description: "HTTP provider smoke echo.",
      schema: {
        type: "function",
        function: {
          name: "provider_echo",
          description: "HTTP provider smoke echo.",
          parameters: { type: "object", additionalProperties: false }
        }
      },
      permissions: [],
      timeoutMs: 5_000,
      cancelable: true
    }],
    async execute(name, args, context) {
      return {
        status: "completed",
        content: JSON.stringify({ name, args, workspace: context.workspace }),
        details: { name, args, workspace: context.workspace }
      };
    }
  };
  const providerTool = new AgentTool({
    workspace,
    tools: ["provider_echo"],
    toolProviders: [provider]
  });
  const providerRuntime = await providerTool.createServer({ config: { ...config, port: 0 } });
  const providerServer = await providerRuntime.listen();
  try {
    const providerManifest = await getJson(`${providerServer.url}/api/tools/manifest`);
    assert.deepEqual(providerManifest.tools.map((tool) => tool.name), ["provider_echo"]);
    const providerResult = await postJson(`${providerServer.url}/api/tools/call`, {
      schemaVersion: "agent-cli-tool.call.v1",
      toolCallId: "server-provider-call",
      toolName: "provider_echo",
      arguments: { value: "ok" },
      workspace: { root: workspace }
    });
    assert.equal(providerResult.status, "completed");
    assert.equal(providerResult.details.workspace, workspace);
  } finally {
    await providerRuntime.close();
    await providerTool.dispose();
  }
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
