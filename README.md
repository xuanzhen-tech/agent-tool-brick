# Agent Tool Brick

`agent-tool` 是独立的工具执行积木。它把模型可调用工具封装成对象 API 和可选 HTTP 服务，让编排器不需要内嵌具体工具实现。

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
- 通过 Tavily 或通用 web gateway 暴露可选 `web_search` 和 `web_fetch`
- 通过注入的 `python-runtime` 支持 Python-backed 本地工具执行

本积木不负责：

- 调用模型 provider
- 编排 chat loop
- 存储 thread
- 对外 SSE 格式
- 桌面 UI、安装器、更新器或 release manifest 组合
- 打包 Node、Python、浏览器或 rg 二进制

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

产品主路径只需要传 `workspace`、`runtimeDependencies` 和 `skillRuntime`。其中 `runtimeDependencies` 是 Node、Python、rg 等运行时注入的唯一入口；`skillRuntime` 是 skill 查找和激活的唯一入口。对象模式不再接收 `rgBin`、`nodeBin`、`pythonBin`、`skillIndexPath`、web provider、shell 限制或 terminal 限制等散参。

web 工具仍然是可选能力，但 provider 配置不属于 `AgentTool` 构造函数。当前实现只在内部环境变量已经配置时暴露 `web_search` 和 `web_fetch`；没有配置时不会暴露这两个工具。

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
AGENT_TOOL_SKILL_INDEX
AGENT_TOOL_TAVILY_API_KEY
AGENT_TOOL_WEB_GATEWAY_BASE_URL
AGENT_TOOL_WEB_GATEWAY_TOKEN
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

`AGENT_TOOL_SKILL_INDEX` 只用于服务模式兼容。对象模式下应通过 `skillRuntime` 注入 `AgentSkill` 实例来暴露 `skill_find` 和 `skill_activate`。服务模式的 index-only 路径只代表“已安装 skills 的轻量查询”，不负责远端 provider 搜索或安装。

web 工具是可选项。配置 `AGENT_TOOL_TAVILY_API_KEY`，或配置 `AGENT_TOOL_WEB_GATEWAY_BASE_URL` 和 `AGENT_TOOL_WEB_GATEWAY_TOKEN` 后，才会暴露 `web_search` 和 `web_fetch`。

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
dist/agent-tool-0.2.0-win32-x64.zip
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

artifact 刻意不包含 Node、Python、Playwright browsers、rg 二进制、`.env`、UI 代码和 host 专属配置。
