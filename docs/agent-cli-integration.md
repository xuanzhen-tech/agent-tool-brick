# Agent CLI Integration

`agent-cli` should consume `agent-tool` as an external tool provider.

## Discovery

The host launcher starts `agent-tool serve`, then injects one of:

```text
AGENT_CLI_TOOL_ENDPOINT=http://127.0.0.1:8791
AGENT_CLI_TOOL_MANIFEST=<path or URL to manifest>
```

The preferred v1 path is `AGENT_CLI_TOOL_ENDPOINT`, with `agent-cli` reading:

```text
GET /api/tools/manifest
```

## Tool Call Flow

1. `agent-cli` fetches the manifest.
2. `agent-cli` injects available tool schemas into the model request.
3. The model emits an OpenAI-compatible tool call.
4. `agent-cli` owns `threadId`, `runId`, and `toolCallId`.
5. `agent-cli` calls `POST /api/tools/call`.
6. `agent-tool` executes and returns `agent-cli-tool.result.v1`.
7. `agent-cli` writes thread events and maps them to external SSE.

`agent-tool` compresses model-facing tool results before returning them. The response keeps stable status, error, diagnostics, artifacts, and metadata, while large `content` / `details` payloads are summarized with hash, length, head/tail, and important paths. `agent-cli` should treat the returned `content` as the content to send back to the model.

Example:

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

## Cancel Flow

When `agent-cli` receives chat cancel, it should propagate:

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

`agent-tool` aborts the running process when possible and returns `status: "interrupted"` from the pending call.

## Failure Behavior

If `agent-tool` is missing:

- `agent-cli` still starts.
- chat without external tools still works.
- external tool schemas are not injected.
- diagnostics warns.

If `rg` is missing:

- `agent-tool` still starts.
- `run_shell` remains available when enabled.
- `workspace_search` is not exposed.
- diagnostics warns.

If `agent-skill` index is missing:

- `agent-tool` still starts.
- `skill_find` and `skill_activate` are not exposed.
- diagnostics warns.

When `skill_activate` succeeds, `agent-tool` returns a `loadedSkill` payload. The orchestrator owns persistence, duplicate detection, and rendering that payload into durable skill context.

If web provider config is missing:

- `agent-tool` still starts.
- `web_search` and `web_fetch` are not exposed.
- diagnostics warns.
