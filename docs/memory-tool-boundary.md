# Memory Tool Boundary

本文说明 `agent-tool-brick` 与 `agent-memory-brick` 的边界。

## Conclusion

Memory tools 不实现到 `agent-tool-brick` 内部。

原因：

- memory 有自己的 SQLite 存储、migration、审计、画像摘要和后台维护生命周期。
- memory 写入会影响后续 prompt 注入，不是一次性工具调用。
- memory 的作用域入口是 `memoryRoot`，由 product/host 映射用户身份；这不属于通用工具 runtime。

## Runtime Composition

Product/host 应创建三个对象：

```js
const agentTool = new AgentTool({ workspace, runtimeDependencies, skillRuntime });
const agentMemory = new AgentMemory({ memoryRoot, runner });

const agent = new AgentCli({
  workspace,
  toolRuntime: agentTool,
  memoryRuntime: agentMemory,
  skillRuntime
});
```

`AgentCli` 负责把工具 schema 合并：

```text
agentTool.definitions
agentMemory.toolDefinitions
```

并按名称路由：

```text
memory_* -> agentMemory.execute()
其它工具 -> agentTool.execute()
```

## agent-tool-brick Responsibilities

`agent-tool-brick` 继续负责：

- `run_shell`
- `exec_command`
- `write_stdin`
- `workspace_search`
- `web_search`
- `web_fetch`
- `email_send`
- `skill_find`
- `skill_activate`
- 工具结果压缩和 diagnostics

## agent-memory-brick Responsibilities

`agent-memory-brick` 负责：

- `memory_search`
- `memory_read`
- `memory_list`
- `memory_write`
- `memory_update`
- `memory_archive`
- `memory_forget`
- SQLite 长期记忆存储
- `profile_summary`
- 后台维护和审计

## Product Rule

Product 层不要把 memory tool 转发给 `AgentTool` HTTP server。前端查看记忆也不要调用 `AgentTool`。

产品查看画像应通过 product 自己包的 memory API/IPC 调用 `AgentMemory.getProfileSummary()`、`status()`、`list()`、`read()` 等 SDK 方法。
