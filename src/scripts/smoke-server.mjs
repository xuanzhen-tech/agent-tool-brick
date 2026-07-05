import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveServiceConfig } from "../main/launch-config.mjs";
import { createAgentToolServer } from "../main/server.mjs";

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "agent-tool-server-"));
await fs.writeFile(path.join(workspace, "server-note.txt"), "server needle", "utf8");
const config = {
  ...resolveServiceConfig(process.env, {
    workspaceRoot: workspace,
    maxTimeoutMs: 10_000,
    maxOutputBytes: 16_000
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
  await wait(200);
  const canceled = await postJson(`${url}/api/tools/cancel`, {
    toolCallId: "cancel-call",
    reason: "smoke cancel"
  });
  assert.equal(canceled.ok, true);
  assert.equal(canceled.canceled, true);
  const canceledResult = await pending;
  assert.equal(canceledResult.status, "interrupted");
} finally {
  await runtime.close();
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
