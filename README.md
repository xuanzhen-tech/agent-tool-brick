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
- optional `workspace_search` through an injected `rg` runtime

This brick does not own:

- model provider calls
- chat loop orchestration
- thread storage
- external SSE formatting
- desktop UI, installer, updater, or release manifest composition
- Node, Python, browser, or rg binaries

## CLI

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
AGENT_TOOL_PROCESS_EXEC_ENABLED
AGENT_TOOL_MAX_TIMEOUT_MS
AGENT_TOOL_MAX_OUTPUT_BYTES
AGENT_TOOL_RESULT_COMPRESSION
```

`AGENT_TOOL_RG_BIN` is optional. When rg is unavailable, `workspace_search` is not exposed and diagnostics reports a warning.

Tool result compression is enabled by default. Set `AGENT_TOOL_RESULT_COMPRESSION=off` only for debugging raw tool output.

## Local Verification

```bash
npm install
npm run release:local
```

`release:local` covers CLI smoke, contract smoke, tool smoke, server smoke, artifact build, descriptor generation, placeholder publish, verification, and package shape.

## Artifact

The runtime artifact is a `win32-x64` zip:

```text
dist/agent-tool-0.1.0-win32-x64.zip
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
