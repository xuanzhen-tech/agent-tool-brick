#!/usr/bin/env node
import { once } from "node:events";
import process from "node:process";

import { brickDefinition } from "./brick-definition.mjs";
import { createDiagnosticsReport, createHealthReport } from "./main/diagnostics.mjs";
import { resolveServiceConfig } from "./main/launch-config.mjs";
import { createAgentToolServer } from "./main/server.mjs";
import { createToolRegistry } from "./main/tool-registry.mjs";
import { createToolResult, validateAgentToolCall } from "./main/tool-contract.mjs";

const command = process.argv[2] || "help";
const args = process.argv.slice(3);

try {
  if (command === "version" || command === "--version" || command === "-v") {
    console.log(brickDefinition.version);
  } else if (command === "health") {
    const config = resolveServiceConfig(process.env, parseCommonOptions(args));
    writeOutput(createHealthReport(config), args);
  } else if (command === "diagnostics") {
    const config = resolveServiceConfig(process.env, parseCommonOptions(args));
    writeOutput(await createDiagnosticsReport(config), args);
  } else if (command === "manifest") {
    const config = resolveServiceConfig(process.env, parseCommonOptions(args));
    const registry = await createToolRegistry(config);
    writeOutput(registry.manifest, args);
  } else if (command === "call") {
    const config = resolveServiceConfig(process.env, parseCommonOptions(args));
    const call = await readToolCallFromArgs(args);
    const validation = validateAgentToolCall(call);
    if (!validation.ok) {
      throw new Error(`Invalid tool call: ${validation.errors.join("; ")}`);
    }
    const registry = await createToolRegistry(config);
    const controller = new AbortController();
    const execution = await registry.execute(call, controller.signal);
    writeOutput(createToolResult({
      toolCallId: call.toolCallId,
      status: execution.status,
      content: execution.content,
      details: execution.details,
      error: execution.error,
      diagnostics: execution.diagnostics,
      artifacts: execution.artifacts
    }), args);
  } else if (command === "serve") {
    await runServe(args);
  } else {
    printHelp();
    process.exitCode = command === "help" || command === "--help" || command === "-h" ? 0 : 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

async function runServe(args) {
  const config = resolveServiceConfig(process.env, parseCommonOptions(args));
  const runtime = await createAgentToolServer({ config });
  const { url } = await runtime.listen();
  console.log(`[agent-tool] listening ${url}`);

  const close = async (signal) => {
    console.log(`[agent-tool] ${signal} received, closing`);
    await runtime.close();
  };

  process.once("SIGINT", () => {
    close("SIGINT").finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    close("SIGTERM").finally(() => process.exit(0));
  });

  await once(runtime.server, "close");
}

function parseCommonOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    if (arg === "--host" && next) {
      options.host = next;
      index += 1;
    } else if (arg === "--port" && next) {
      options.port = Number(next);
      index += 1;
    } else if (arg === "--workspace" && next) {
      options.workspaceRoot = next;
      index += 1;
    } else if (arg === "--rg-bin" && next) {
      options.rgBin = next;
      index += 1;
    } else if (arg === "--node-bin" && next) {
      options.nodeBin = next;
      index += 1;
    } else if (arg === "--token" && next) {
      options.token = next;
      index += 1;
    } else if (arg === "--process-exec-enabled" && next) {
      options.processExecEnabled = parseBooleanArg(next);
      index += 1;
    } else if (arg === "--max-timeout-ms" && next) {
      options.maxTimeoutMs = Number(next);
      index += 1;
    } else if (arg === "--max-output-bytes" && next) {
      options.maxOutputBytes = Number(next);
      index += 1;
    }
  }
  return options;
}

async function readToolCallFromArgs(args) {
  const toolName = readOption(args, "--tool");
  const json = readOption(args, "--json");
  const payload = json ? JSON.parse(json) : JSON.parse(await readStdin());
  return {
    schemaVersion: "agent-cli-tool.call.v1",
    toolCallId: payload.toolCallId || `cli-call-${Date.now()}`,
    toolName: toolName || payload.toolName,
    arguments: payload.arguments || payload,
    workspace: payload.workspace,
    limits: payload.limits
  };
}

function readOption(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function writeOutput(value, args) {
  if (args.includes("--json")) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  if (value?.status && value?.checks) {
    console.log(`${value.status}: ${value.checks.map((check) => `${check.id}=${check.status}`).join(", ")}`);
    return;
  }
  if (value?.transport?.baseUrl) {
    console.log(`${value.id}@${value.version} ${value.transport.baseUrl} tools=${value.tools.length}`);
    return;
  }
  console.log(JSON.stringify(value, null, 2));
}

function parseBooleanArg(value) {
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function printHelp() {
  console.log(`agent-tool ${brickDefinition.version}

Usage:
  agent-tool serve [--host 127.0.0.1] [--port 8791]
  agent-tool health [--json]
  agent-tool diagnostics [--json]
  agent-tool manifest [--json]
  agent-tool call --tool run_shell --json '{"mode":"process","executable":"node","args":["--version"]}'
  agent-tool version
`);
}
