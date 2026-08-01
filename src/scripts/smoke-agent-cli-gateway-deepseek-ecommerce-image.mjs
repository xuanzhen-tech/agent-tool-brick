/**
 * AgentCli、AgentTool、DeepSeek 与真实生图 Gateway 的人工验收。
 *
 * 本脚本不 mock 模型或图片服务，也不读取 provider key。它验证 DeepSeek 能使用
 * 新版多场景合同在一次工具调用中并发生成三种职责，再完成“生成 v1 -> 编辑 v2”，
 * 并以磁盘 manifest、图片 hash 和 AgentCli 工具事件作为事实依据。该测试消耗真实
 * 模型与生图额度，不进入 release:local。
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../..");
const agentCliRepository = process.env.AGENT_CLI_REPO
  || "C:/Users/ddger/Documents/agent-cli-brick";
const gatewayBaseUrl = String(
  process.env.AGENT_CLI_LLM_GATEWAY_URL
  || "http://47.109.82.99/agent-llm-gateway"
).replace(/\/+$/, "");
const modelId = process.env.AGENT_TOOL_REAL_DEEPSEEK_MODEL || "deepseek-v4-pro";
const timeoutMs = readPositiveInteger(process.env.AGENT_TOOL_REAL_IMAGE_TIMEOUT_MS, 900_000);
const threadId = `thread-deepseek-image-${crypto.randomUUID()}`;
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-tool-deepseek-image-"));
const workspace = path.join(temporaryRoot, "workspace");
const threadsPath = path.join(temporaryRoot, "threads");
const selectedTools = [
  "ecommerce_image_generate",
  "ecommerce_image_edit",
  "ecommerce_image_list"
];

const { AgentCli } = await import(pathToFileURL(path.join(agentCliRepository, "src", "index.mjs")));
const { AgentTool } = await import(pathToFileURL(path.join(repositoryRoot, "src", "index.mjs")));

let agent;
let agentTool;
let succeeded = false;
try {
  await fs.mkdir(workspace, { recursive: true });
  agentTool = new AgentTool({ workspace, tools: selectedTools });
  assert.deepEqual(
    agentTool.definitions.map((definition) => definition.function.name).sort(),
    [...selectedTools].sort()
  );

  agent = new AgentCli({
    env: {
      AGENT_CLI_LLM_GATEWAY_URL: gatewayBaseUrl,
      AGENT_CLI_REQUEST_TIMEOUT_MS: String(timeoutMs),
      AGENT_CLI_AUTO_COMPACT_ENABLED: "false"
    },
    modelId,
    threadId,
    workspace,
    threadsPath,
    toolRuntime: agentTool
  });

  console.log(`[deepseek-image] gateway=${gatewayBaseUrl}`);
  console.log(`[deepseek-image] model=${modelId} threadId=${threadId}`);
  console.log(`[deepseek-image] workspace=${workspace}`);

  const generateEvents = await collectChatEvents(agent, [
    "这是一次真实电商生图工具验收。",
    "必须只调用一次 ecommerce_image_generate，并在同一个 requests 数组中生成三张 1024x1024、medium 质量的 PNG 图片。",
    "共享约束：三张图都是同一只没有品牌文字的青绿色保温杯，保持杯身形状、颜色和杯盖结构一致。",
    "三个 request 的 key 分别为 white-background、lifestyle、detail：第一张是纯白背景商品主图；第二张是现代厨房自然使用场景；第三张是杯盖与杯口材质细节特写。每个 request 的 count 都是 1。",
    "生成工具会自行等待到最终状态。只能依据 deliveryReady 和 artifact 判断是否完成，不得虚构 operationId、assetId、versionId 或文件路径。"
  ].join("\n"), timeoutMs);
  assertToolSequence(generateEvents, "ecommerce_image_generate");
  assert.equal(
    generateEvents.filter(
      (event) => event.type === "tool_start" && event.toolName === "ecommerce_image_generate"
    ).length,
    1,
    "多场景图片必须通过一次 generate 工具调用提交。"
  );
  assert.equal(
    generateEvents.some((event) => event.type === "tool_start" && event.toolName === "ecommerce_image_batch"),
    false,
    "新版组合不应调用旧 ecommerce_image_batch。"
  );

  const batch = await readSingleBatch(workspace);
  assert.deepEqual(batch.requests.map((request) => request.key), [
    "white-background",
    "lifestyle",
    "detail"
  ]);
  assert.equal(batch.items.length, 3);
  assert.equal(new Set(batch.items.slice(0, 3).map((item) => item.requestKey)).size, 3);
  const startedTimes = batch.items.map((item) => Date.parse(item.startedAt));
  assert.equal(startedTimes.every(Number.isFinite), true);
  assert.ok(
    Math.max(...startedTimes) - Math.min(...startedTimes) < 5_000,
    "三个场景应在同一并发波次启动。"
  );

  const assets = await readAssets(workspace);
  assert.equal(assets.length, 3, "一次多场景调用应创建三个独立 asset。");
  for (const candidate of assets) {
    assert.deepEqual(candidate.versions.map((version) => version.versionId), ["v1"]);
    await assertStoredVersion(workspace, candidate.versions[0]);
  }
  const asset = assets.find(
    (candidate) => candidate.versions[0].requestKey === "white-background"
  );
  assert.ok(asset, "必须能按 requestKey 找到白底图资产。");

  const editEvents = await collectChatEvents(agent, [
    "请继续修改刚刚生成的图片。",
    `必须调用 ecommerce_image_edit，assetId=${asset.assetId}，versionId=v1。`,
    "把背景改成浅灰色摄影棚台面，并保持保温杯的形状、青绿色和主体构图不变；尺寸仍为 1024x1024，质量 medium。",
    "只有工具返回 deliveryReady=true 且磁盘 artifact 已验证时，才能报告新版本完成。"
  ].join("\n"), timeoutMs);
  assertToolSequence(editEvents, "ecommerce_image_edit");

  const editedAsset = await readAsset(workspace, asset.assetId);
  assert.deepEqual(editedAsset.versions.map((version) => version.versionId), ["v1", "v2"]);
  assert.equal(editedAsset.versions[1].parentVersionId, "v1");
  assert.equal(editedAsset.versions[1].versionScope, "asset");
  await assertStoredVersion(workspace, editedAsset.versions[1]);

  const status = agent.status({ threadId });
  console.log(`[deepseek-image] traceId=${status.traceId}`);
  console.log(`[deepseek-image] assetId=${asset.assetId} versions=v1,v2`);
  console.log("[deepseek-image] ok");
  succeeded = true;
} finally {
  await agent?.dispose();
  await agentTool?.dispose();
  if (succeeded) {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  } else {
    console.error(`[deepseek-image] failed workspace retained at ${temporaryRoot}`);
  }
}

async function collectChatEvents(agentInstance, message, timeout) {
  const events = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(`真实生图验收超过 ${timeout}ms。`), timeout);
  try {
    for await (const event of agentInstance.chat(message, {
      signal: controller.signal,
      includeInternalEvents: true
    })) {
      events.push(event);
    }
    return events;
  } finally {
    clearTimeout(timer);
  }
}

function assertToolSequence(events, expectedToolName) {
  const toolStartIndex = events.findIndex(
    (event) => event.type === "tool_start" && event.toolName === expectedToolName
  );
  const toolEndIndex = events.findIndex(
    (event) => event.type === "tool_end"
      && event.toolName === expectedToolName
      && event.status === "completed"
  );
  const finalAssistantIndex = events.findLastIndex(
    (event) => event.type === "assistant_delta" && event.content
  );
  assert.ok(toolStartIndex >= 0, `DeepSeek 未调用 ${expectedToolName}。`);
  assert.ok(toolEndIndex > toolStartIndex, `${expectedToolName} 未成功结束。`);
  assert.ok(finalAssistantIndex > toolEndIndex, "最终用户回复必须出现在已验证工具结果之后。");
}

async function readAssets(workspaceRoot) {
  const assetsDirectory = path.join(workspaceRoot, "outputs", "ecommerce-images", "assets");
  const entries = await fs.readdir(assetsDirectory, { withFileTypes: true });
  const assetDirectories = entries.filter((entry) => entry.isDirectory());
  return await Promise.all(assetDirectories.map((entry) => readAsset(workspaceRoot, entry.name)));
}

async function readSingleBatch(workspaceRoot) {
  const batchesDirectory = path.join(workspaceRoot, "outputs", "ecommerce-images", "batches");
  const entries = (await fs.readdir(batchesDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory());
  assert.equal(entries.length, 1, "首次多场景生成必须只创建一个 batch。");
  return JSON.parse(await fs.readFile(
    path.join(batchesDirectory, entries[0].name, "manifest.json"),
    "utf8"
  ));
}

async function readAsset(workspaceRoot, assetId) {
  return JSON.parse(await fs.readFile(path.join(
    workspaceRoot,
    "outputs",
    "ecommerce-images",
    "assets",
    assetId,
    "manifest.json"
  ), "utf8"));
}

async function assertStoredVersion(workspaceRoot, version) {
  assert.equal(version.status, "completed");
  assert.equal(version.versionScope, "asset");
  const filePath = path.join(workspaceRoot, ...version.path.split("/"));
  const bytes = await fs.readFile(filePath);
  assert.ok(bytes.byteLength > 0);
  assert.equal(bytes.byteLength, version.bytes);
  assert.equal(sha256(bytes), version.contentHash);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function readPositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
