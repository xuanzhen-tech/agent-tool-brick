# Agent Tool Brick

`agent-tool` 是独立的工具执行积木。它把模型可调用工具封装成对象 API 和可选 HTTP 服务，让编排器不需要内嵌具体工具实现。

相关边界文档：

- [Memory Tool Boundary](docs/memory-tool-boundary.md)

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
- 通过注入的 `AgentSkill` 对象暴露可选 `skill_find` 和 `skill_activate`
- 通过服务端 Tool Gateway 暴露 `web_search` 和 `web_fetch`
- 通过服务端 Tool Gateway 暴露 `email_send`
- 通过注入的 `python-runtime` 支持 Python-backed 本地工具执行
- 透传产品注入的 Node 包环境，让 `run_shell` / `exec_command` 可以使用产品组装的能力
- 通过注入的 `playwright-browsers` 为子进程设置 Playwright Chromium 缓存路径

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

`agentTool.definitions` 返回面向模型的 OpenAI-compatible tool schemas。`agentTool.execute(name, args, context)` 执行指定工具，并把持续终端会话保存在当前 `AgentTool` 实例内。注入 `AgentSkill` 对象后，`skill_find` 和 `skill_activate` 会暴露给模型，并委托该对象完成本地 skill 查找、远端候选搜索、安装和激活。

`web_search`、`web_fetch` 和 `email_send` 默认通过固定 Server Tool Gateway 转发。Tavily key、SMTP host、SMTP username/password 都只配置在服务器上，产品仓库和 `AgentTool` 构造函数不接收这些密钥。`email_send` 的附件仍由本地 `AgentTool` 读取 workspace 内文件并做大小/路径校验，然后把文件内容随请求交给服务器发送。

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

`skill_find` 和 `skill_activate` 只由注入的 `AgentSkill` 实例提供。独立执行 `agent-tool serve` 时没有该对象，因此不会暴露这两个工具；产品需要 HTTP transport 时应通过 `agentTool.createServer()` 启动，以复用同一个 `AgentSkill` 和终端会话。

`AGENT_TOOL_GATEWAY_BASE_URL` 是可选覆盖项。默认指向固定 Server Tool Gateway；Tavily 和 SMTP 配置必须放在服务器环境变量中，不放在产品仓库或客户端环境变量中。

工具结果压缩默认启用。只有调试原始工具输出时才应设置 `AGENT_TOOL_RESULT_COMPRESSION=off`。

## 五件套验收

本仓库包含五个 brick 的组合 smoke：

```bash
npm run smoke:five-brick-integration
```

真实 Kimi provider 验收：

```powershell
$env:AGENT_CLI_KIMI_API_KEY="<one-time-key>"
npm run smoke:five-brick-kimi
Remove-Item Env:AGENT_CLI_KIMI_API_KEY -ErrorAction SilentlyContinue
```

该 smoke 会组合 `agent-cli`、`agent-tool`、`agent-skill`、`node-runtime` 和 `python-runtime`，验证 skill prompt、`skill_find`、`skill_activate`、`loadedSkill`、`run_shell` 和注入 Python runtime 的完整链路。

## 本地验证

```bash
npm install
npm run release:local
```

`release:local` 覆盖命令入口 smoke、contract smoke、tool smoke、server smoke、artifact 构建、descriptor 生成、placeholder publish、verify 和 package 形状。

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
