# Agent Tool Brick

`agent-tool` is a standalone tool execution brick. It exposes a local HTTP tool service that an agent orchestrator can discover and call without embedding tool implementations in the orchestrator runtime.

## Boundary

This brick owns:

- tool manifest and tool schemas
- local tool call endpoint
- tool diagnostics
- tool cancel semantics
- model-facing tool result compression
- `run_shell`
- `exec_command` and `write_stdin` for persistent terminal sessions
- optional `workspace_search` through an injected `rg` runtime
- optional `skill_find` and `skill_activate` through an injected agent-skill index
- optional `web_search` and `web_fetch` through Tavily or a generic web gateway

This brick does not own:

- model provider calls
- chat loop orchestration
- thread storage
- external SSE formatting
- desktop UI, installer, updater, or release manifest composition
- Node, Python, browser, or rg binaries

## Host Entrypoint

`agent-tool` includes a command entrypoint so host launchers, release workflows,
and local smoke tests can start or inspect the tool runtime. It is not a
user-facing product CLI; the product-facing CLI is expected to be provided by
the orchestrator brick.

```bash
agent-tool version
agent-tool health --json
agent-tool diagnostics --json
agent-tool manifest --json
agent-tool serve --host 127.0.0.1 --port 8791
```

Direct tool call smoke:

```bash
agent-tool call --tool run_shell --json "{\"mode\":\"process\",\"executable\":\"node\",\"args\":[\"--version\"]}"
```

Use `run_shell` for bounded one-shot commands. Use `exec_command` when a command
may keep running, needs later stdin, or should be polled without blocking the
agent turn. `exec_command` returns a `session_id` while the process is alive;
call `write_stdin` with that `session_id` to send input or with empty `chars` to
poll incremental output.

## HTTP API

```text
GET  /api/health
GET  /api/tools/manifest
GET  /api/tools/diagnostics
POST /api/tools/call
POST /api/tools/cancel
```

Tool calls use `agent-cli-tool.call.v1` and return `agent-cli-tool.result.v1`.

## Runtime Env

```text
AGENT_TOOL_HOST
AGENT_TOOL_PORT
AGENT_TOOL_TOKEN
AGENT_TOOL_WORKSPACE_ROOT
AGENT_TOOL_NODE_BIN
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

`AGENT_TOOL_RG_BIN` is optional. When rg is unavailable, `workspace_search` is not exposed and diagnostics reports a warning.

`AGENT_TOOL_SKILL_INDEX` is optional. When it points to an `agent-skill.index.v1` file, `skill_find` and `skill_activate` are exposed.

Web tools are optional. Configure `AGENT_TOOL_TAVILY_API_KEY` or `AGENT_TOOL_WEB_GATEWAY_BASE_URL` plus `AGENT_TOOL_WEB_GATEWAY_TOKEN` to expose `web_search` and `web_fetch`.

Tool result compression is enabled by default. Set `AGENT_TOOL_RESULT_COMPRESSION=off` only for debugging raw tool output.

## Local Verification

```bash
npm install
npm run release:local
```

`release:local` covers command-entrypoint smoke, contract smoke, tool smoke, server smoke, artifact build, descriptor generation, placeholder publish, verification, and package shape.

## Artifact

The runtime artifact is a `win32-x64` zip:

```text
dist/agent-tool-0.1.1-win32-x64.zip
dist/build-artifact.json
dist/descriptor.local.json
dist/descriptor.oss.placeholder.json
```

The descriptor uses:

```text
type: tool
slot: tool:agent-tool
install.command: agent-tool serve
```

The artifact intentionally excludes Node, Python, Playwright browsers, rg binaries, `.env`, UI code, and host-specific config files.
