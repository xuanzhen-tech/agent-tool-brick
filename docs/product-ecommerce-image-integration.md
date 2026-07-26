# Product 电商生图接入交接

## 版本

- `@xuanzhen-tech/agent-tool-brick@0.7.0`
- `@xuanzhen-tech/agent-skill-brick@0.5.0`
- `agent-llm-gateway@0.3.0`，由服务端部署，不是 Product npm 依赖

## Product 需要做的事

Product 只负责选择能力并组装现有对象，不复制生图 runtime，也不保存图片 provider key。

创建 `AgentTool` 时，把以下四个默认隐藏工具加入 Product 的工具白名单：

```js
const ecommerceImageTools = [
  "ecommerce_image_generate",
  "ecommerce_image_edit",
  "ecommerce_image_batch",
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

`amazon-product-image-generation` 会教 Agent 填写四个工具的参数、编写亚马逊商品生图提示词、轮询异步批次和继续编辑历史版本。Product 不需要解析 Skill reference。

## Gateway

AgentTool 继续使用既有 Server Tool Gateway 地址：

```text
AGENT_TOOL_GATEWAY_BASE_URL=http://47.109.82.99/agent-llm-gateway
```

API易 key、base URL、模型和 provider 超时只由 Gateway 服务端配置。Product 不增加 provider key、base URL、模型前缀或 Gateway token 表单。

## GUI 与状态

`ecommerce_image_generate` 和 `ecommerce_image_edit` 只提交异步批次，返回 `batchId` 与 `queued` 状态。GUI 不应把提交成功显示成图片已完成。

Agent 会通过 `ecommerce_image_batch` 查询：

```text
queued | running | partial | completed | failed | cancelled | interrupted
```

完成图片使用 `agent-output.v1`：

```text
kind=image
renderer=ecommerce-image
data.batchId
data.assetId
data.versionId
files[].path
```

GUI 可以直接复用现有 image artifact 展示能力。编辑结果沿用原 `assetId`，创建新的 `versionId`，并通过 `parentVersionId` 指向来源版本；不要覆盖旧图片。

## 交互提醒

- `count` 是同一个 `gpt-image-2` 请求需求生成多少张独立候选，不是矩阵、拼图或模型分组。
- 初稿建议 `medium`、`count: 1`；用户明确需要候选时再增加数量，定稿使用 `high`。
- 运行中取消后，上游同步请求仍可能继续生成并计费，GUI 应保留工具返回的提示。
- 网络断开和超时代表上游结果未知，不会自动重试；只有 Gateway 明确返回 `retryable: true` 才会自动重试。
- 图片长期保存在当前 workspace 的 `outputs/ecommerce-images/`，Product 不应另建一套图片版本数据库。

## 验收

1. 新建 workspace，确认四个工具只在 Product 选择后进入 AgentTool definitions。
2. 激活 `amazon-product-image-generation`，确认 Agent 先提交 generate，再轮询 batch。
3. 生成 2 张图片，确认得到 2 个独立 `assetId` 和 `v1`。
4. 选择其中一张编辑，确认同一 `assetId` 新增 `v2`，且 `parentVersionId=v1`。
5. 重启 Product 后用 list 查询，确认批次、资产和版本历史仍存在。
6. 取消运行中批次，确认 GUI 展示“上游仍可能继续生成并计费”的提示。

