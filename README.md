# Agent Tool Brick

`agent-tool` 是独立的工具执行积木。它把模型可调用工具封装成对象 API 和可选 HTTP 服务，让编排器不需要内嵌具体工具实现。

相关边界文档：

- [Memory Tool Boundary](docs/memory-tool-boundary.md)
- [Tool Provider 对接合同](docs/tool-provider-contract.md)

## 能力边界

本积木负责：

- 工具 manifest 和 OpenAI-compatible tool schemas
- 本地工具调用入口
- 工具 diagnostics
- 工具取消语义
- 面向模型的工具结果压缩
- 一次性命令工具 `run_shell`
- 持续终端会话工具 `exec_command` 和 `write_stdin`
- 通过注入的 `rg` runtime 暴露可选 `workspace_search`
- 通过注入的 `AgentSkill` 对象暴露可选 `skill_find`、`skill_activate`、`skill_resource`，以及显式选择后可用的 `skill_create`、`skill_remove`
- 通过服务端 Tool Gateway 暴露 `web_search` 和 `web_fetch`
- 通过服务端 Tool Gateway 暴露 `email_send`
- 本地呈递 `image_present` 图片 artifact；视觉模型直接接收原生图片内容
- 内置但默认隐藏的电商生图、编辑、批次和资产历史工具
- 通过注入的 `python-runtime` 支持 Python-backed 本地工具执行
- 透传产品注入的 Node 包环境，让 `run_shell` / `exec_command` 可以使用产品组装的能力
- 通过注入的 `playwright-browsers` 为子进程设置 Playwright Chromium 缓存路径
- 内置但按需选择的 `visualization_create_chart` 和 `visualization_create_dashboard`
- 通过 `toolProviders` 组合演示文稿等复杂能力，而不让 AgentCli 感知内部实现

本积木不负责：

- 调用模型 provider
- 编排 chat loop
- 存储 thread
- 对外 SSE 格式
- 长期记忆存储、画像摘要、memory tools 生命周期
- 桌面 UI、安装器、更新器或 release manifest 组合
- 打包 Node、Python、浏览器或 rg 二进制
- 管理 Playwright 浏览器 artifact 的下载、解压或版本选择
- 携带或发布 Playwright JS library；该依赖由产品仓库组装

## Host 入口

`agent-tool` 提供命令入口，供 host launcher、release workflow 和本地 smoke 测试启动或检查工具运行时。它不是面向最终用户的产品 CLI；产品侧 CLI 应由编排积木提供。

```bash
agent-tool version
agent-tool health --json
agent-tool diagnostics --json
agent-tool manifest --json
agent-tool serve --host 127.0.0.1 --port 8791
```

直接工具调用 smoke：

```bash
agent-tool call --tool run_shell --json "{\"mode\":\"process\",\"executable\":\"node\",\"args\":[\"--version\"]}"
```

`run_shell` 用于有边界的一次性命令。`exec_command` 用于可能持续运行、需要后续 stdin、或需要轮询输出而不阻塞 agent turn 的命令。`exec_command` 会在进程仍运行时返回 `session_id`；随后调用 `write_stdin` 可以写入输入，或传空 `chars` 轮询增量输出。

`run_shell` 和 `exec_command` 的模型可见 schema 会包含当前 OS 和 `mode="shell"` 的实际 shell 入口；Windows 下提示 PowerShell 语法，Linux/macOS 下提示 `/bin/bash -lc` / POSIX shell 语法。跨平台命令仍推荐优先使用 `mode="process"`。

## SDK 对象用法

产品仓库组合 brick 时应优先使用对象 API。命令入口继续保留给 release smoke 和 host 管理的服务模式。

```js
import { AgentTool } from "@xuanzhen-tech/agent-tool-brick";
import { AgentSkill } from "@xuanzhen-tech/agent-skill-brick";
import { AgentCli } from "@xuanzhen-tech/agent-cli-brick";

const agentSkill = new AgentSkill();

const agentTool = new AgentTool({
  workspace,
  runtimeDependencies,
  skillRuntime: agentSkill
});

const agent = new AgentCli({
  env: process.env,
  workspace,
  toolRuntime: agentTool,
  skillRuntime: agentSkill,
  runtimeDependencies
});
```

`agentTool.definitions` 返回面向模型的 OpenAI-compatible tool schemas。`agentTool.execute(name, args, context)` 执行指定工具，并把持续终端会话保存在当前 `AgentTool` 实例内。注入完整 `AgentSkill` 对象后，`skill_find`、`skill_activate` 和 `skill_resource` 会暴露给模型；它们分别委托该对象完成本地/远端 skill 查找、激活，以及 skill 包资源的受控访问。`skill_create` 和 `skill_remove` 默认隐藏，产品显式加入工具白名单后才允许模型创建、更新或删除 Skill。

默认构造 `new AgentTool()` 保持既有工具集合。产品需要启用新增预制工具或复杂 Provider 时，
显式传 `tools` 白名单；列表以外的工具不会进入模型 schema：

```js
const agentTool = new AgentTool({
  workspace,
  runtimeDependencies,
  tools: ["run_shell", "visualization_create_chart", "visualization_create_dashboard"]
});
```

## 电商图片工具

电商图片能力位于 AgentTool 内，不是独立 Brick。工具默认隐藏，产品只有把名称放进现有 `tools` 白名单后，模型才会看到并调用：

```js
const agentTool = new AgentTool({
  workspace,
  runtimeDependencies,
  tools: [
    "ecommerce_image_generate",
    "ecommerce_image_edit",
    "ecommerce_image_list"
  ]
});
```

`modelId` 必须从 `gpt-image-2` 和 `doubao-seedream-5-0` 中选择，Gateway 负责真实 provider 路由；AgentTool 不接触 provider key 或带日期的内部模型名。一次 generate 通过 `requests` 提交多个场景，每个场景拥有独立 prompt、尺寸、质量和候选数量；所有场景的 `count` 合计最多 9 张。顶层 `basePrompt` 和 `referenceImages` 用于保持商品、Logo 与品牌视觉一致，每个场景还可追加自己的参考图。`count` 表示同一场景的独立候选，不是矩阵、拼图或模型分组。

GPT Image 2 将画面比例与分辨率档位分开：`size` 使用通用 `宽:高` 字符串，例如 `1:1`、`4:5`、`16:9` 或 `9:16`，具体选项由 Product 决定；`resolution` 使用 `1K | 2K | 4K`。Gateway 会把同一公共合同分别转换成 EWO 的比例/档位参数或 API易的精确尺寸。Seedream 5.0 不参与本次合同，仍使用精确 `{ width, height }`，总像素至少为 3,686,400，只支持 PNG/JPEG 且不接受自定义压缩率。旧 Object/HTTP 的 GPT Image 2 精确尺寸调用继续兼容。

```js
const submitted = await agentTool.execute("ecommerce_image_generate", {
  modelId: "gpt-image-2",
  basePrompt: "保持商品结构、颜色、Logo 和品牌视觉一致",
  referenceImages: [{
    path: "uploads/product.png",
    role: "product",
    preserve: "strict"
  }],
  requests: [{
    key: "white-background",
    prompt: "生成纯白底商品主图",
    size: "1:1",
    resolution: "2K",
    quality: "high",
    count: 1
  }, {
    key: "lifestyle",
    prompt: "生成现代厨房使用场景图",
    size: "16:9",
    resolution: "4K",
    quality: "high",
    count: 2
  }],
  output: { format: "png" }
}, { workspace });
```

`ecommerce_image_generate` 和 `ecommerce_image_edit` 会在一次工具调用内完成排队、内部重试、等待、落盘和验证。单图与多图都只向模型返回最终成功、失败或中断结果，不返回 `queued/running`，也不要求模型保存 `operationId` 或轮询状态。只有 `deliveryReady=true` 且存在 artifact 时才代表图片可交付。

不同场景按轮询顺序进入全局三个并发槽，优先同时启动各场景的首张图。批次总预算按 `ceil(图片数 / 3) × 390 秒 + 30 秒` 计算，最多 9 张时约 20 分钟。用户中断由 AgentCli 的 `AbortSignal` 直接终止本地批次；已经发给同步上游的请求仍可能继续生成或计费。`ecommerce_image_job_status/cancel/retry` 和旧 `ecommerce_image_batch` 只保留为 SDK/HTTP 兼容与排障入口，不进入模型 definitions。生成结果写入 `outputs/ecommerce-images/`，每张图片都是 `agent-output.v1`、`renderer=ecommerce-image` 的独立 artifact，并通过 `requestKey/requestIndex/outputIndex` 关联原场景。

编辑必须指定 `assetId` 和明确的历史 `versionId`。它会把目标版本、修改意见和可选额外参考图提交给所选模型，并在同一资产下创建 `v2`、`v3` 等新版本；允许 GPT 与 Seedream 交叉编辑，原文件永不覆盖。`versionId` 只在所属 `assetId` 内递增，不能根据对话中的生成次数推断全局 V5。`ecommerce_image_list` 可按 batch、asset 或状态查询，asset 查询返回完整父版本、模型、参数、workspace 相对路径和内容哈希。

参考图只接受当前 workspace 内的 PNG/JPEG/WebP。运行时通过 realpath 阻止路径和符号链接越界，每张最多 10MB、每个 job 最多 5 张且合计最多 30MB；内容按 SHA-256 去重到 `outputs/ecommerce-images/sources/`。AgentTool 不保存 provider key，图片通过 multipart 发送到 Server Tool Gateway。

单个图片任务的 390 秒预算覆盖全部内部重试，Gateway 应在 360 秒内结束单次 provider 请求，生产反向代理应至少允许 420 秒。只有 Gateway 明确返回 `retryable: true` 时才会在总预算内自动重试；网络断开、超时和取消后的上游结果未知，不会自动重放。同一 `toolCallId` 的相同请求会复用已持久化任务，不会重复计费；相同 ID 携带不同参数会被拒绝。

## 商品照片生视频工具

首版商品视频能力固定使用 Seedance 2.0，只处理商品照片，不处理真人、数字人或人脸驱动。两个工具默认隐藏，Product 通过现有白名单选择：

```js
const agentTool = new AgentTool({
  workspace,
  runtimeDependencies,
  skillRuntime: agentSkill,
  tools: ["ecommerce_video_generate", "ecommerce_video_list"]
});
```

`ecommerce_video_generate` 接受 workspace 相对 `imagePath`、完整导演 prompt，以及可选 `aspectRatio`、`duration`、`resolution`、`generateAudio`。默认值为 `adaptive`、6 秒、1080p、无音频；`modelId` 省略时固定为 `doubao-seedance-2-0`。AgentTool 会提交一次任务、持久化 Provider taskId、轮询、下载并验证 MP4，模型不需要保存 taskId 或自行轮询。只有 `deliveryReady=true` 且存在 `kind=video` artifact 才表示完成。

任务写入 `outputs/ecommerce-videos/jobs/<jobId>/manifest.json`，结果写入同目录的 `result.mp4`。manifest 只保存 workspace 相对路径、参数、状态和哈希，不保存图片 Base64、API key 或本机绝对路径。同一 `toolCallId` 会复用已有任务，防止工具重放造成重复计费；进程重启后，已取得 Provider taskId 的未完成任务会继续查询和下载，提交结果不确定且没有 taskId 的任务不会自动重提。

Product 只需要选择上述工具和 `ecommerce-product-video-generation` Skill，并按现有 artifact 方式展示 `video/mp4`。Provider 密钥、Seedance 日期版模型名、轮询和下载接口全部属于 Gateway/AgentTool 边界，Product 不需要增加相关配置。

图表工具真实生成 Vega-Lite JSON、SVG、PNG 和 manifest；看板工具真实生成结构化 JSON、
HTML、图表文件和 manifest。所有正式文件固定写到 `outputs/visualizations/`，并通过
`agent-output.v1` 交给 `AgentCli` 与产品 GUI。图表渲染固定使用随 SDK/artifact 发布的、
可校验来源与哈希的 Vega 6.3.0 / Vega-Lite 6.4.3 静态 bundle，不会在运行时联网下载
图表代码；详情见 [第三方运行时说明](src/main/vendor/THIRD_PARTY_NOTICES.md)。外部 PPT 等
复杂能力则以 `toolProviders` 接入，完整合同见 [Tool Provider 对接合同](docs/tool-provider-contract.md)。

`web_search`、`web_fetch` 和 `email_send` 默认通过固定 Server Tool Gateway 转发。Tavily key、SMTP host、SMTP username/password 都只配置在服务器上，产品仓库和 `AgentTool` 构造函数不接收这些密钥。`email_send` 的附件由本地 `AgentTool` 读取 workspace 内文件并做大小/路径校验后上传；`image_present` 完全在本地校验和登记图片 artifact，不上传图片到 Gateway。

`image_present` 是通用看图工具，不是 PPT 专属 QA。模型先用其他工具渲染 PNG/JPEG/WebP，再调用：

```js
await agentTool.execute("image_present", {
  path: "outputs/slide-01.png"
});
```

工具会产出 `kind=image`、`renderer=image-present` 的 `agent-output.v1` artifact，供产品从 workspace 的 `outputs/` 展示。`AgentCli` 会查询 Gateway 的模型能力：当前模型支持视觉时，仅在紧随的下一次请求附上原生图片；不支持时，模型不会收到任何伪造的文字描述。

`skill_find` 支持两类动作：

```js
await agentTool.execute("skill_find", {
  action: "search",
  source: "all",
  query: "github"
});

await agentTool.execute("skill_find", {
  action: "install",
  source: "skillhub",
  slug: "owner-repo-github"
});
```

搜索结果里的 `skills` 是已安装 skill，`candidates` 是远端候选。完整 `SKILL.md` 内容只会在后续 `skill_activate` 中通过 `loadedSkill` payload 返回。

### 创建 Skill

需要让 Agent 沉淀新能力时，产品显式选择 `skill_create`，并继续注入同一个
`AgentSkill` 对象：

```js
const agentTool = new AgentTool({
  workspace,
  skillRuntime: agentSkill,
  tools: ["skill_find", "skill_create", "skill_remove", "skill_activate", "skill_resource"]
});
```

```js
await agentTool.execute("skill_create", {
  name: "marketplace-review-analysis",
  description: "分析电商评论主题和改进机会。适用于用户要求整理评论或比较竞品口碑时。",
  instructions: "# Review Analysis\n\n1. 确认站点和样本范围。\n2. 保留原始证据。",
  requiredTools: ["workspace_search"],
  files: [{
    path: "references/field-contract.md",
    content: "# 字段口径\n\n..."
  }, {
    path: "assets/report-template.xlsx",
    sourcePath: "uploads/report-template.xlsx"
  }],
  conflict: "check"
}, { workspace });
```

`skill_create` 不直接写固定的 `~/.agent-cli/skills`，也不读写产品选择状态。
它在系统临时目录组装包，然后调用当前注入对象的 `AgentSkill.install()`；因此产品
自定义的 `skillsPath`、选择代理、事务安装、冲突保护和索引刷新仍是唯一事实来源。
`sourcePath` 必须是 workspace 内的相对路径，且只允许复制到 `assets/`。同名 Skill
默认返回冲突；只有用户明确授权更新或覆盖时才使用 `conflict: "replace"`。

### 删除 Skill

`skill_remove` 只接受当前 `AgentSkill` 索引中的精确 id 或 name，不接受目录路径。产品
必须显式把它加入工具白名单；模型也必须在用户明确提出删除后传入 `confirm: true`：

```js
await agentTool.execute("skill_remove", {
  skill: "marketplace-review-analysis",
  confirm: true,
  reason: "用户不再需要该能力"
});
```

实际删除由注入对象的 `AgentSkill.remove()` 完成，包括受管目录、安装记录、索引刷新
和当前实例选择更新。工具不会调用 shell，也不会根据猜测路径删除文件。产品配置若仍
显式选择同名预制 Skill，下次创建 `AgentSkill` 时它可能重新安装；需要永久取消该
产品选择时，产品还应同步更新自己的 Skill 白名单。

## Skill 资源工具

`skill_activate` 只会加载 `SKILL.md`，同时返回 `references/` 与 `assets/` 的轻量清单；
它不会把 reference 全文混进普通工具结果，也不会复制 asset。模型需要资源时使用唯一的
`skill_resource` 工具：

```js
await agentTool.execute("skill_resource", {
  action: "read_reference",
  skill: "brief-writer",
  path: "references/usage.md"
}, { workspace });

await agentTool.execute("skill_resource", {
  action: "copy_asset",
  skill: "brief-writer",
  path: "assets/template.docx"
}, { workspace });
```

- `read_reference` 只接受 `references/...` 下的 UTF-8 文本，返回
  `loadedSkillReference`。`AgentCli` 会将其升级为专门上下文块并跨轮保留。
- `copy_asset` 只接受 `assets/...`。模型不能指定目标路径，文件固定物化到
  `workspace/temp/skill-assets/<skill>/<contentHash>/<fileName>`，返回 workspace 相对路径。
- `scripts/` 和任意工作区路径都不能通过此工具读取或执行；需要通用底层操作时才由
  `run_shell` 作为保底工具处理。

产品主路径只需要传 `workspace`、`runtimeDependencies` 和 `skillRuntime`。其中 `runtimeDependencies` 是 Node、Python、rg、产品 Node 包、Playwright browsers 等运行时注入的唯一入口；`skillRuntime` 是 skill 查找和激活的唯一入口。对象模式不再接收 `rgBin`、`nodeBin`、`pythonBin`、`skillIndexPath`、web provider、shell 限制或 terminal 限制等散参。

当产品希望 agent 在 shell 脚本里使用 Playwright 时，产品仓库应把 `playwright` npm 依赖加入产品包，并通过 `runtimeDependencies` 注入一个 `node-package` 项。`agent-tool` 只把该项转换为 `NODE_PATH` / `NODE_OPTIONS` 等子进程环境，不直接依赖 Playwright。`playwright-browsers` 仍只负责提供 Chromium 缓存，并通过 `PLAYWRIGHT_BROWSERS_PATH` 暴露给子进程。

产品主路径不需要配置 web provider 或邮件 provider。若要在本地开发中替换服务器地址，可设置 `AGENT_TOOL_GATEWAY_BASE_URL`；未设置时默认使用 `http://47.109.82.99/agent-llm-gateway`。

## HTTP API

```text
GET  /api/health
GET  /api/tools/manifest
GET  /api/tools/diagnostics
POST /api/tools/call
POST /api/tools/cancel
```

工具调用使用 `agent-cli-tool.call.v1`，返回 `agent-cli-tool.result.v1`。

## Runtime Env

```text
AGENT_TOOL_HOST
AGENT_TOOL_PORT
AGENT_TOOL_TOKEN
AGENT_TOOL_WORKSPACE_ROOT
AGENT_TOOL_NODE_BIN
AGENT_TOOL_PYTHON_BIN
AGENT_TOOL_RG_BIN
PLAYWRIGHT_BROWSERS_PATH
AGENT_TOOL_PLAYWRIGHT_BROWSERS_PATH
AGENT_TOOL_NODE_PACKAGE_PATHS
AGENT_TOOL_NODE_IMPORT_REGISTERS
AGENT_TOOL_NODE_OPTIONS
AGENT_TOOL_GATEWAY_BASE_URL
AGENT_TOOL_WEB_MAX_RESULTS
AGENT_TOOL_PROCESS_EXEC_ENABLED
AGENT_TOOL_MAX_TIMEOUT_MS
AGENT_TOOL_MAX_OUTPUT_BYTES
AGENT_TOOL_TERMINAL_SESSION_TTL_MS
AGENT_TOOL_TERMINAL_MAX_SESSIONS
AGENT_TOOL_TERMINAL_MAX_OUTPUT_BYTES
AGENT_TOOL_RESULT_COMPRESSION
```

`AGENT_TOOL_RG_BIN` 是可选项。缺少 rg 时，`workspace_search` 不暴露，diagnostics 给出 warn。

`AGENT_TOOL_PYTHON_BIN` 是可选项。配置后，`run_shell` 和 `exec_command` 会把 `executable: "python"`、`"python3"` 或 `"py"` 解析到注入的私有 Python runtime；diagnostics 会验证该 runtime 能导入声明的通用依赖。

`AGENT_TOOL_NODE_PACKAGE_PATHS` / `AGENT_TOOL_NODE_IMPORT_REGISTERS` / `AGENT_TOOL_NODE_OPTIONS` 来自产品注入的 `node-package` runtime dependency。它们用于让 `run_shell` 和 `exec_command` 的 Node 子进程解析产品包内的 JS 依赖，例如产品侧安装的 `playwright`。

`PLAYWRIGHT_BROWSERS_PATH` 来自可选的 `playwright-browsers` runtime dependency。配置后，Node 子进程可以使用该路径下的 Chromium 缓存；Playwright JS library 本身仍由产品仓库依赖提供。

`skill_find`、`skill_activate`、`skill_resource`、`skill_create` 和 `skill_remove` 只由注入的 `AgentSkill` 实例提供。独立执行 `agent-tool serve` 时没有该对象，因此不会暴露这些工具；产品需要 HTTP transport 时应通过 `agentTool.createServer()` 启动，以复用同一个 `AgentSkill` 和终端会话。`skill_create` 要求该对象实现公开的 `install()`，`skill_remove` 要求实现 `remove()`；二者始终需要产品在 `tools` 中显式选择。

`AGENT_TOOL_GATEWAY_BASE_URL` 是可选覆盖项。默认指向固定 Server Tool Gateway；Tavily 和 SMTP 配置必须放在服务器环境变量中，不放在产品仓库或客户端环境变量中。

工具结果压缩默认启用。超过预算的完整结果不会直接丢弃：AgentTool 将其保存到 `~/.agent-cli/tool-results/<threadId>/`，并向模型返回 `resultId`。模型可用自动暴露的 `tool_result_read` 查看结构和分页读取，也可用 `tool_result_search` 搜索必要证据。恢复范围绑定原 thread，默认保留 7 天；删除 thread 时同步清理。只有调试原始工具输出时才应设置 `AGENT_TOOL_RESULT_COMPRESSION=off`。

## 五件套验收

本仓库包含五个 brick 的组合 smoke：

```bash
npm run smoke:five-brick-integration
```

超长 MCP 风格结果的压缩、落盘与恢复测试：

```bash
npm run smoke:tool-results
npm run smoke:agent-cli-tool-result-recovery
```

真实 Kimi provider 验收：

```powershell
$env:AGENT_CLI_KIMI_API_KEY="<one-time-key>"
npm run smoke:five-brick-kimi
Remove-Item Env:AGENT_CLI_KIMI_API_KEY -ErrorAction SilentlyContinue
```

该 smoke 会组合 `agent-cli`、`agent-tool`、`agent-skill`、`node-runtime` 和 `python-runtime`，验证 skill prompt、`skill_find`、`skill_activate`、`skill_resource`、`loadedSkill`、`run_shell` 和注入 Python runtime 的完整链路。

## 本地验证

```bash
npm install
npm run release:local
```

`release:local` 覆盖命令入口 smoke、contract smoke、tool smoke、server smoke、artifact 构建、descriptor 生成、placeholder publish、verify 和 package 形状。

可视化与编排器的跨仓库联调可额外执行：

```bash
npm run smoke:agent-cli-integration
```

该 smoke 需要本机存在同级 `agent-cli-brick` 仓库，或通过 `AGENT_CLI_REPO` 指定其位置。它会真实生成结构化 BI 看板，确认 `AgentCli` 收到 `agent_output`、thread transcript 可回放，并且下一轮模型上下文只含产物摘要。

## 产物

runtime artifact 是 `win32-x64` zip：

```text
dist/agent-tool-0.2.7-win32-x64.zip
dist/build-artifact.json
dist/descriptor.local.json
dist/descriptor.oss.placeholder.json
```

descriptor 使用：

```text
type: tool
slot: tool:agent-tool
install.command: agent-tool serve
```

artifact 刻意不包含 Node、Python、Playwright browsers、rg 二进制、`.env`、UI 代码、host 专属配置或 Playwright JS library。Playwright JS library 由产品仓库依赖提供；浏览器缓存仍由 `playwright-package` 提供。
