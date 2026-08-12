/**
 * 【文件说明】
 * 本文件验证超长 Tool Result 的真实本地恢复链路。
 *
 * 测试使用接近 MCP 返回结构的大型 JSON，完整经过 Provider、AgentTool 压缩、
 * 磁盘持久化、thread scope 校验、结构查看、分页读取和关键词搜索，不以预先
 * 构造好的摘要绕过核心执行路径。
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { AgentTool } from "../index.mjs";
import { resolveServiceConfig } from "../main/launch-config.mjs";
import { createAgentToolServer } from "../main/server.mjs";
import { createToolRegistry } from "../main/tool-registry.mjs";
import { createToolResultStore } from "../main/tool-result-store.mjs";

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "agent-tool-result-workspace-"));
const storeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-tool-result-store-"));
const threadId = "thread-large-mcp-result";
const remoteToolName = "seller_mcp";
const resultStore = createToolResultStore({ rootPath: storeRoot });
const payload = createLargeMcpPayload();
const provider = createLargeResultProvider(payload);
const config = resolveServiceConfig(process.env, {
  workspaceRoot: workspace,
  resultCompressionEnabled: true
});
const registry = await createToolRegistry(config, {
  toolProviders: [provider],
  selectedTools: [remoteToolName],
  resultStore
});

// 恢复工具必须独立于产品白名单存在，否则模型拿到 resultId 后没有读取入口。
assert.deepEqual(
  registry.tools.map((tool) => tool.name).sort(),
  [remoteToolName, "tool_result_read", "tool_result_search"].sort()
);
const objectRuntime = new AgentTool({ workspace, tools: [remoteToolName], toolProviders: [provider] });
assert.equal(objectRuntime.definitions.some((schema) => schema.function.name === "tool_result_read"), true);
assert.equal(objectRuntime.definitions.some((schema) => schema.function.name === "tool_result_search"), true);
await objectRuntime.dispose();

const largeResult = await execute(registry, {
  toolName: remoteToolName,
  toolCallId: "call-large-mcp",
  threadId,
  arguments: { action: "call", name: "keepa_info" }
});
assert.equal(largeResult.status, "completed");
assert.equal(largeResult.deliveryStatus, "recoverable_summary");
assert.equal(largeResult.recoverable, true);
assert.match(largeResult.content, /agent-tool-result-compressed/);
assert.match(largeResult.content, /tool_result_read/);
assert.equal(typeof largeResult.resultRef.resultId, "string");
assert.equal(largeResult.resultRef.toolName, remoteToolName);
assert.equal(largeResult.resultRef.toolCallId, "call-large-mcp");
assert.equal(largeResult.resultRef.bytes > 250_000, true);
assert.equal(largeResult.availablePaths.some((entry) => entry.path === "/data/price" && entry.length === 366), true);

const inspect = await execute(registry, {
  toolName: "tool_result_read",
  toolCallId: "call-inspect",
  threadId,
  arguments: { resultId: largeResult.resultRef.resultId }
});
assert.equal(inspect.status, "completed");
const inspectContent = JSON.parse(inspect.content);
assert.equal(inspectContent.availablePaths.some((entry) => entry.path === "/data/buyBox"), true);

const page = await execute(registry, {
  toolName: "tool_result_read",
  toolCallId: "call-read-page",
  threadId,
  arguments: {
    resultId: largeResult.resultRef.resultId,
    path: "/data/price",
    offset: 120,
    limit: 7
  }
});
assert.equal(page.status, "completed");
const pageContent = JSON.parse(page.content);
assert.equal(pageContent.total, 366);
assert.equal(pageContent.items.length, 7);
assert.equal(pageContent.items[0].day, 120);
assert.equal(pageContent.nextOffset, 127);

const search = await execute(registry, {
  toolName: "tool_result_search",
  toolCallId: "call-search",
  threadId,
  arguments: { resultId: largeResult.resultRef.resultId, query: "ASIN-END-365" }
});
assert.equal(search.status, "completed");
assert.equal(JSON.parse(search.content).matches.some((entry) => entry.path === "/data/price/365/asin"), true);

// HTTP transport 也必须保留恢复合同；服务层重新包装 result 后仍能继续读取。
const server = await createAgentToolServer({
  config: { ...config, host: "127.0.0.1", port: 0 },
  createRegistry: async () => registry
});
const serverAddress = await server.listen();
try {
  const httpLarge = await postTool(serverAddress.url, {
    schemaVersion: "agent-cli-tool.call.v1",
    toolCallId: "call-http-large",
    toolName: remoteToolName,
    arguments: {},
    workspace: { root: workspace },
    traceContext: { threadId }
  });
  assert.equal(httpLarge.status, "completed");
  const httpSummary = JSON.parse(httpLarge.content);
  const httpResultId = httpSummary.recovery.resultRef.resultId;
  assert.equal(httpLarge.details.__toolResultRecovery.resultRef.resultId, httpResultId);

  const httpPage = await postTool(serverAddress.url, {
    schemaVersion: "agent-cli-tool.call.v1",
    toolCallId: "call-http-read",
    toolName: "tool_result_read",
    arguments: { resultId: httpResultId, path: "/data/price", offset: 365, limit: 1 },
    workspace: { root: workspace },
    traceContext: { threadId }
  });
  assert.equal(JSON.parse(httpPage.content).items[0].asin, "ASIN-END-365");
} finally {
  await server.close();
}

// resultId 只能在产生它的 thread 中读取；错误必须是模型可修正的结构化结果。
const wrongThread = await execute(registry, {
  toolName: "tool_result_read",
  toolCallId: "call-wrong-thread",
  threadId: "thread-other",
  arguments: { resultId: largeResult.resultRef.resultId, path: "/data/price", limit: 1 }
});
assert.equal(wrongThread.status, "failed");
assert.equal(wrongThread.error.code, "tool_result_not_found");

// 外置保存失败时保留摘要，但必须明确标记不可恢复，防止模型假设遗漏内容。
const failedStoreRegistry = await createToolRegistry(config, {
  toolProviders: [provider],
  selectedTools: [remoteToolName],
  resultStore: {
    async persist() {
      const error = new Error("disk unavailable");
      error.code = "ENOSPC";
      throw error;
    },
    async read() {},
    async search() {}
  }
});
const degraded = await execute(failedStoreRegistry, {
  toolName: remoteToolName,
  toolCallId: "call-persist-failure",
  threadId,
  arguments: {}
});
assert.equal(degraded.status, "completed");
assert.equal(degraded.deliveryStatus, "degraded");
assert.equal(degraded.recoverable, false);
assert.match(degraded.content, /持久化失败/);

const scopePath = resultStore.scopePath(threadId);
assert.equal((await fs.readdir(scopePath)).length >= 2, true);
await resultStore.deleteThread(threadId);
await assert.rejects(fs.access(scopePath));

// 过期引用在读取时立即失效，不会继续泄漏旧数据。
let clock = new Date("2026-08-12T00:00:00.000Z");
const expiryRoot = path.join(storeRoot, "expiry");
const expiryStore = createToolResultStore({
  rootPath: expiryRoot,
  retentionMs: 1_000,
  now: () => clock
});
const expiring = await expiryStore.persist({
  threadId: "thread-expiry",
  toolName: remoteToolName,
  toolCallId: "call-expiry",
  result: { content: "temporary" }
});
clock = new Date("2026-08-12T00:00:02.000Z");
await assert.rejects(
  expiryStore.read({ threadId: "thread-expiry", resultId: expiring.resultRef.resultId }),
  (error) => error.code === "tool_result_expired"
);

// 单个数组项超过读取预算时不强塞正文，而是返回可继续深入的精确路径。
const boundedStore = createToolResultStore({ rootPath: path.join(storeRoot, "bounded") });
const bounded = await boundedStore.persist({
  threadId: "thread-bounded",
  toolName: remoteToolName,
  toolCallId: "call-bounded",
  result: { content: JSON.stringify({ data: [{ huge: "H".repeat(20_000) }] }) }
});
const boundedPage = await boundedStore.read({
  threadId: "thread-bounded",
  resultId: bounded.resultRef.resultId,
  path: "/data",
  limit: 10,
  maxChars: 1_000
});
assert.equal(boundedPage.items.length, 0);
assert.equal(boundedPage.oversizedItemPath, "/data/0");

// 磁盘上限按最旧结果淘汰；较新的结果仍然可读。
const cappedStore = createToolResultStore({
  rootPath: path.join(storeRoot, "capped"),
  maxTotalBytes: 1_500
});
const oldest = await cappedStore.persist({
  threadId: "thread-cap",
  toolName: remoteToolName,
  toolCallId: "call-oldest",
  result: { content: "A".repeat(900) }
});
await new Promise((resolve) => setTimeout(resolve, 5));
const newest = await cappedStore.persist({
  threadId: "thread-cap",
  toolName: remoteToolName,
  toolCallId: "call-newest",
  result: { content: "B".repeat(900) }
});
await cappedStore.cleanup();
await assert.rejects(
  cappedStore.read({ threadId: "thread-cap", resultId: oldest.resultRef.resultId }),
  (error) => error.code === "tool_result_not_found"
);
assert.equal((await cappedStore.read({ threadId: "thread-cap", resultId: newest.resultRef.resultId })).resultRef.resultId, newest.resultRef.resultId);

await fs.rm(workspace, { recursive: true, force: true });
await fs.rm(storeRoot, { recursive: true, force: true });
console.log("[smoke-tool-results] ok");

function createLargeMcpPayload() {
  const rows = Array.from({ length: 366 }, (_, index) => ({
    day: index,
    asin: index === 365 ? "ASIN-END-365" : `ASIN-${String(index).padStart(3, "0")}`,
    timestamp: `2026-08-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
    value: 99 + index / 100,
    note: `historical-price-evidence-${index}-${"x".repeat(360)}`
  }));
  return {
    code: "OK",
    message: "success",
    data: {
      price: rows,
      buyBox: rows.map((row) => ({ ...row, seller: `seller-${row.day}` })),
      rating: rows.map((row) => ({ day: row.day, value: 4.5, asin: row.asin }))
    }
  };
}

function createLargeResultProvider(value) {
  return {
    id: "seller-mcp-fixture",
    toolDescriptors: [{
      name: remoteToolName,
      defaultVisible: true,
      schema: {
        type: "function",
        function: {
          name: remoteToolName,
          description: "真实形态的大型 MCP 数据 fixture。",
          parameters: { type: "object", properties: {} }
        }
      }
    }],
    async execute() {
      const remote = {
        content: [{ type: "text", text: JSON.stringify(value) }],
        isError: false
      };
      return {
        status: "completed",
        content: JSON.stringify({ serverId: "seller", remoteToolName: "keepa_info", result: remote }),
        details: { serverId: "seller", remoteToolName: "keepa_info", result: remote }
      };
    }
  };
}

async function execute(registryValue, input) {
  return await registryValue.execute({
    schemaVersion: "agent-cli-tool.call.v1",
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    arguments: input.arguments,
    workspace: { root: workspace },
    traceContext: { threadId: input.threadId }
  }, new AbortController().signal, { threadId: input.threadId });
}

async function postTool(baseUrl, body) {
  const response = await fetch(`${baseUrl}/api/tools/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  assert.equal(response.status, 200);
  return await response.json();
}
