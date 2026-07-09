# Agent CLI 集成合同

`agent-cli` 应把 `agent-tool` 作为外部工具提供者消费，而不是内嵌具体工具实现。

## 发现方式

对象化集成是当前主路径：

```js
const agentTool = new AgentTool({ runtimeDependencies, skillRuntime });
const agent = new AgentCli({ workspace, toolRuntime: agentTool, skillRuntime });
```

`workspace` 属于 `AgentCli` 的运行上下文，不是 `AgentTool` 产品主入口的必填项。`AgentCli` 在派发工具调用时会把当前 workspace 放入 context，`AgentTool` 只消费这个 context。

服务模式仍可用于 host launcher。host 启动 `agent-tool serve` 后，可向编排器注入：

```text
AGENT_CLI_TOOL_ENDPOINT=http://127.0.0.1:8791
AGENT_CLI_TOOL_MANIFEST=<manifest 文件路径或 URL>
```

v1 推荐使用 `AGENT_CLI_TOOL_ENDPOINT`，再读取：

```text
GET /api/tools/manifest
```

## 工具调用流程

1. `agent-cli` 从 `toolRuntime.definitions` 或 HTTP manifest 获取工具 schemas。
2. `agent-cli` 把可用工具 schemas 注入模型请求。
3. 模型发出 OpenAI-compatible tool call。
4. `agent-cli` 持有 `threadId`、`runId` 和 `toolCallId`。
5. 对象模式下，`agent-cli` 调用 `toolRuntime.execute(name, args, context)`。
6. 服务模式下，`agent-cli` 调用 `POST /api/tools/call`。
7. `agent-tool` 执行工具并返回 `agent-cli-tool.result.v1`。
8. `agent-cli` 写入 thread 事件，并映射为外部事件流。

`agent-tool` 返回前会压缩面向模型的工具结果。响应保留稳定的 status、error、diagnostics、artifacts 和 metadata；大体量 `content` / `details` 会被摘要为 hash、长度、head/tail 和关键路径。`agent-cli` 应把返回的 `content` 当作回填给模型的工具内容。

## Shell 生命周期

shell 工具按生命周期拆分：

- `run_shell` 是一次性命令，直到完成、超时或取消后返回。
- `exec_command` 启动持续终端命令；如果进程仍在运行，会快速返回 `details.session_id`。
- `write_stdin` 向持续终端会话写入输入；`chars` 为空时用于轮询增量输出。

编排器遇到 dev server、watcher、REPL 或可能阻塞模型 turn 的命令时，应优先使用 `exec_command` / `write_stdin`。

示例：

```json
{
  "schemaVersion": "agent-cli-tool.call.v1",
  "threadId": "thread-1",
  "runId": "run-1",
  "toolCallId": "call-1",
  "toolName": "run_shell",
  "arguments": {
    "mode": "process",
    "executable": "node",
    "args": ["--version"]
  },
  "workspace": {
    "root": "C:\\Project"
  },
  "limits": {
    "timeoutMs": 20000,
    "maxOutputChars": 20000
  }
}
```

## 取消流程

`agent-cli` 收到 chat cancel 后，应向工具层传播取消信号。服务模式使用：

```text
POST /api/tools/cancel
```

```json
{
  "threadId": "thread-1",
  "runId": "run-1",
  "toolCallId": "call-1",
  "reason": "Agent turn interrupted by client."
}
```

`agent-tool` 会尽力中止运行中的进程，并让 pending call 返回 `status: "interrupted"`。

如果 `exec_command` 已经返回持续会话，则通过 `session_id` 取消：

```json
{
  "session_id": "terminal-labc123-1",
  "reason": "Agent turn interrupted by client."
}
```

## 缺失依赖行为

缺少 `agent-tool` 时：

- `agent-cli` 仍可启动。
- 不需要外部工具的 chat 仍可运行。
- 外部工具 schemas 不注入。
- diagnostics 给出 warn。

缺少 `rg` 时：

- `agent-tool` 仍可启动。
- 启用时 `run_shell` 仍可用。
- `workspace_search` 不暴露。
- diagnostics 给出 warn。

缺少 `AgentSkill` 对象或兼容 index 时：

- `agent-tool` 仍可启动。
- `skill_find` 和 `skill_activate` 不暴露。
- diagnostics 给出 warn。

`skill_activate` 成功时，`agent-tool` 返回 `loadedSkill` payload。编排器负责持久化、去重，并把该 payload 渲染成可跨轮保留的 skill 上下文。

web 和 email 工具：

- `agent-tool` 仍可启动。
- `web_search`、`web_fetch` 和 `email_send` 默认通过 Server Tool Gateway 暴露。
- Tavily 和 SMTP 配置只放在服务器，不放在产品仓库。
- 如果服务器缺少 Tavily/SMTP 配置，工具调用返回明确 `failed` 结果；编排器不需要向产品层索要 key。
