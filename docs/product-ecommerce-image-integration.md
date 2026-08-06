# Product 电商生图接入交接

## 版本

- `@xuanzhen-tech/agent-tool-brick@0.11.0`
- `@xuanzhen-tech/agent-skill-brick@0.8.2`
- `agent-llm-gateway@0.3.0`，由服务端部署，不是 Product npm 依赖

## Product 需要做的事

Product 只负责选择能力并组装现有对象，不复制生图 runtime，也不保存图片 provider key。

创建 `AgentTool` 时，把以下默认隐藏工具加入 Product 的工具白名单：

```js
const ecommerceImageTools = [
  "ecommerce_image_generate",
  "ecommerce_image_edit",
  "ecommerce_image_list"
];

const agentTool = new AgentTool({
  workspace,
  runtimeDependencies,
  skillRuntime: agentSkill,
  tools: ecommerceImageTools
});
```

创建 `AgentSkill` 时，把内置 Skill 名称加入 Product 的 Skill 选择数组：

```js
const agentSkill = new AgentSkill({
  skills: ["amazon-product-image-generation"]
});
```

`amazon-product-image-generation` 会教 Agent 编写电商图片提示词和继续编辑历史版本。新版 Skill 不再要求 Agent 保存 batchId、轮询、取消或重试；这些状态由 AgentTool 内部管理。Product 不需要解析 Skill reference，也不需要把兼容状态工具加入模型白名单。

## Gateway

AgentTool 继续使用既有 Server Tool Gateway 地址：

```text
AGENT_TOOL_GATEWAY_BASE_URL=http://47.109.82.99/agent-llm-gateway
```

EWO/API易 key、base URL、模型和 provider 超时只由 Gateway 服务端配置。Product 不增加 provider key、base URL、模型前缀或 Gateway token 表单。

## GUI 与状态

`ecommerce_image_generate` 和 `ecommerce_image_edit` 会创建本地任务并等待：

- 单个图片任务的总预算为 390 秒，包含内部安全重试。
- generate 可在一个 `requests` 数组中提交白底图、场景图和特写图等不同 prompt，并共享 `basePrompt` 与商品参考图。
- GPT Image 2 的每个 request 使用独立的 `size: 1:1|3:2|2:3` 与 `resolution: 1K|2K|4K`；Product 可直接将这两个字段做成选择器。
- 不同场景按轮询顺序进入三个全局并发槽，最多 9 张时总预算约 20 分钟。
- 工具只向模型返回 completed、failed 或 interrupted 最终结果。
- `deliveryReady=true` 且存在 artifact 才表示图片可交付。
- 部分成功返回顶层 failed、`operationStatus=partial`，并保留已经验证的 artifacts。

任务状态为：

```text
queued | running | partial | completed | failed | cancelled | interrupted
```

`operationId` 与兼容字段 `batchId` 仍用于日志和排障。Product 如需后台诊断，可以直接通过 SDK/HTTP 调用 `ecommerce_image_job_status/cancel/retry`；这些接口不进入模型 definitions。用户在对话中取消任务时，应中断 AgentCli 当前调用，由 `AbortSignal` 贯穿到 AgentTool，不让模型决定取消。

完成图片使用 `agent-output.v1`：

```text
kind=image
renderer=ecommerce-image
data.batchId
data.assetId
data.versionId
data.versionScope=asset
data.requestKey
data.requestIndex
data.outputIndex
files[].path
```

GUI 可以直接复用现有 image artifact 展示能力。编辑结果沿用原 `assetId`，创建新的 `versionId`，并通过 `parentVersionId` 指向来源版本；不要覆盖旧图片。`versionId` 只在所属 asset 内递增，新 asset 的第一张图始终是 `v1`，不能按对话轮次解释成全局 V5。

## 交互提醒

- `requests` 表达不同场景，单个 request 的 `count` 表达该场景的独立候选，不是矩阵、拼图或模型分组。
- 顶层 `basePrompt/referenceImages` 负责跨场景一致性；场景专属参考图放在 `additionalReferenceImages`。
- 初稿建议 `medium`、`count: 1`；用户明确需要候选时再增加数量，定稿使用 `high`。
- 用户中断后，上游同步请求仍可能继续生成并计费，GUI 应保留工具返回的提示。
- 网络断开和超时代表上游结果未知，不会自动重试；只有 Gateway 明确返回 `retryable: true` 才会自动重试。
- 同一 `toolCallId` 重放会返回已有 operation；同一 ID 携带不同参数会返回幂等冲突。
- 图片长期保存在当前 workspace 的 `outputs/ecommerce-images/`，Product 不应另建一套图片版本数据库。

## 验收

1. 新建 workspace，确认生图工具只在 Product 选择后进入 AgentTool definitions。
2. 生成单张图片，确认一次 generate 调用直接得到 `deliveryReady=true` 和真实文件。
3. 构造慢速多图任务，确认 generate 在中间状态不会提前返回，也不会产生 `nextAction`。
4. 一次提交白底、场景、特写三个 request，确认它们并发开始并按 request 分组返回。
5. 同一场景生成 2 张候选，确认得到 2 个独立 `assetId` 和各自的 `v1`。
6. 选择其中一张编辑，确认同一 `assetId` 新增 `v2`，且 `parentVersionId=v1`。
7. 重启 Product 后用 list 查询，确认资产和版本历史仍存在；排障时可用 SDK status 查询历史 batch。
8. 中断运行中任务，确认本地 queued/running 项全部收敛，且结果提示上游仍可能继续生成和计费。
