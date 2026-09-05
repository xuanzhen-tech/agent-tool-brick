/**
 * 使用同一真实模型，对比 run_shell 与专属表格工具的准确率和上下文成本。
 * 该脚本会产生真实模型调用，不进入 release:local。
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { AgentTool } from "../src/index.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agentCliRepo = process.env.AGENT_CLI_REPO || path.join(path.dirname(repoRoot), "agent-cli-brick");
const { AgentCli, createServerGatewayLlmRuntime } = await import(pathToFileURL(path.join(agentCliRepo, "src", "index.mjs")));
const options = parseArgs(process.argv.slice(2));
const pythonBin = process.env.AGENT_TOOL_PYTHON_BIN || "python";
const gatewayBaseUrl = String(process.env.AGENT_CLI_LLM_GATEWAY_URL || "http://47.109.82.99/agent-llm-gateway").replace(/\/+$/, "");
const modelId = options.model || process.env.AGENT_TOOL_SPREADSHEET_EVAL_MODEL || "gpt-5.6-sol";
const fixtureRoot = path.join(os.tmpdir(), `spreadsheet-ab-fixtures-${crypto.randomUUID()}`);
const fixtureScript = path.join(repoRoot, "scripts", "create-spreadsheet-eval-fixtures.py");
const generated = spawnSync(pythonBin, [fixtureScript, fixtureRoot], { encoding: "utf8", windowsHide: true, timeout: 180_000 });
assert.equal(generated.status, 0, generated.stderr || generated.stdout);
const manifest = JSON.parse(await fs.readFile(path.join(fixtureRoot, "manifest.json"), "utf8"));
const selectedCases = selectCases(manifest.cases, options);
const arms = options.arm === "both" ? ["shell", "spreadsheet"] : [options.arm];
const reportRoot = path.join(repoRoot, "evals", "spreadsheets", "results", timestamp());
await fs.mkdir(reportRoot, { recursive: true });
const report = {
  schemaVersion: "agent-spreadsheet.ab-eval.v1",
  generatedAt: new Date().toISOString(),
  modelId,
  gatewayBaseUrl,
  repetitions: options.repetitions,
  cases: [],
  summary: undefined
};

console.log(`[spreadsheet-ab-eval] model=${modelId} cases=${selectedCases.map((item) => item.id).join(",")} arms=${arms.join(",")}`);
try {
  for (const currentCase of selectedCases) {
    for (let repetition = 1; repetition <= options.repetitions; repetition += 1) {
      for (const arm of arms) {
        console.log(`[spreadsheet-ab-eval] start case=${currentCase.id} arm=${arm} repetition=${repetition}`);
        const result = await runCase({ currentCase, arm, repetition });
        report.cases.push(result);
        await writeReport();
        console.log(`[spreadsheet-ab-eval] done case=${currentCase.id} arm=${arm} score=${result.score} promptTokens=${result.metrics.promptTokensTotal ?? "n/a"} durationMs=${result.metrics.durationMs}`);
      }
    }
  }
  report.summary = summarize(report.cases);
  await writeReport();
  printSummary(report.summary);
  console.log(`[spreadsheet-ab-eval] report=${path.join(reportRoot, "report.json")}`);
} finally {
  await fs.rm(fixtureRoot, { recursive: true, force: true });
}

async function runCase({ currentCase, arm, repetition }) {
  const workspace = path.join(os.tmpdir(), `spreadsheet-ab-${currentCase.id}-${arm}-${crypto.randomUUID()}`);
  await fs.cp(path.join(fixtureRoot, currentCase.id), workspace, { recursive: true });
  const tools = arm === "shell"
    ? ["run_shell"]
    : ["spreadsheet_inspect", "spreadsheet_compute", "spreadsheet_validate"];
  const toolRuntime = new AgentTool({
    workspace,
    runtimeDependencies: [{ type: "python-runtime", bin: pythonBin }],
    tools
  });
  const modelRequests = [];
  const env = {
    AGENT_CLI_AI_MODEL: modelId,
    AGENT_CLI_LLM_GATEWAY_URL: gatewayBaseUrl,
    AGENT_CLI_AUTO_COMPACT_ENABLED: "false",
    AGENT_CLI_REQUEST_TIMEOUT_MS: String(options.timeoutMs)
  };
  const gatewayRuntime = createServerGatewayLlmRuntime({ env });
  const llmRuntime = {
    kind: "spreadsheet-ab-instrumented-gateway",
    async chat(request) {
      modelRequests.push({
        requestId: request.requestId,
        messageChars: JSON.stringify(request.messages ?? []).length,
        toolSchemaChars: JSON.stringify(request.tools ?? []).length,
        messageCount: request.messages?.length ?? 0,
        toolCount: request.tools?.length ?? 0
      });
      return gatewayRuntime.chat(request);
    }
  };
  const threadId = `spreadsheet-eval-${arm}-${crypto.randomUUID()}`;
  const traceId = `spreadsheet-eval-trace-${crypto.randomUUID()}`;
  const agent = new AgentCli({
    agentId: `spreadsheet-eval-${arm}`,
    env,
    workspace,
    threadId,
    threadStore: createInMemoryThreadStore(),
    llmRuntime,
    toolRuntime,
    systemPrompt: [
      "你正在参加表格数据分析评测。只使用当前可见工具，不得声称使用了不可见工具。",
      "所有数字必须从文件确定性读取和计算；正式结论前检查来源、行数、重复、联接基数和算术闭环。",
      "工具失败时应修正参数或明确阻断，不得靠心算补齐。最终回复必须简洁列出关键数字、校验结论和不能使用的数据。"
    ].join("\n")
  });
  const events = [];
  const startedAt = Date.now();
  let runtimeError;
  try {
    const prompt = [
      `评测任务：${currentCase.task}`,
      `输入文件：${currentCase.files.join("、")}`,
      "使用当前可见工具完成分析。不得要求人工先整理文件，也不得全量输出明细。"
    ].join("\n");
    await withTimeout((async () => {
      for await (const event of agent.chat(prompt, { threadId, traceId, workspace, includeInternalEvents: true })) {
        events.push(event);
      }
    })(), options.timeoutMs, `case ${currentCase.id}/${arm}`);
  } catch (error) {
    runtimeError = error instanceof Error ? error.message : String(error);
  } finally {
    await agent.dispose?.();
    await toolRuntime.dispose?.();
    await fs.rm(workspace, { recursive: true, force: true });
  }
  const finalText = events.filter((event) => event.type === "assistant_delta").map((event) => event.content || "").join("");
  const toolNames = events.filter((event) => event.type === "tool_start").map((event) => event.toolName);
  const toolEvents = events
    .filter((event) => event.type === "tool_start" || event.type === "tool_end")
    .map((event) => ({
      type: event.type,
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      status: event.status,
      ...(event.detail !== undefined ? { detail: event.detail } : {}),
      ...(event.result !== undefined ? { result: event.result } : {})
    }));
  const usageEvents = events.filter((event) => event.type === "model_usage").map((event) => event.usage ?? event.tokenUsage ?? {});
  const scored = scoreCase(currentCase, arm, finalText, toolNames, runtimeError);
  return {
    caseId: currentCase.id,
    difficulty: currentCase.difficulty,
    arm,
    repetition,
    threadId,
    traceId,
    score: scored.score,
    passed: scored.score >= 80 && !runtimeError,
    checks: scored.checks,
    toolPolicy: scored.toolPolicy,
    runtimeError,
    finalText,
    toolNames,
    toolEvents,
    metrics: {
      durationMs: Date.now() - startedAt,
      modelRequests: modelRequests.length,
      toolCalls: toolNames.length,
      promptTokensTotal: sumUsage(usageEvents, ["promptTokens", "prompt_tokens", "inputTokens", "input_tokens"]),
      promptTokensMax: maxUsage(usageEvents, ["promptTokens", "prompt_tokens", "inputTokens", "input_tokens"]),
      completionTokensTotal: sumUsage(usageEvents, ["completionTokens", "completion_tokens", "outputTokens", "output_tokens"]),
      messageCharsTotal: sum(modelRequests.map((item) => item.messageChars)),
      messageCharsMax: Math.max(0, ...modelRequests.map((item) => item.messageChars)),
      toolSchemaCharsTotal: sum(modelRequests.map((item) => item.toolSchemaChars)),
      toolResultCharsTotal: sum(events.filter((event) => event.type === "tool_end").map((event) => String(event.result ?? "").length))
    },
    modelRequests
  };
}

function scoreCase(currentCase, arm, text, toolNames, runtimeError) {
  const checks = currentCase.checks.map((check) => {
    const passed = check.type === "number"
      ? containsNumber(text, check.value)
      : new RegExp(check.pattern, "iu").test(text);
    return { ...check, passed };
  });
  const assertionWeight = sum(checks.map((check) => Number(check.weight || 0)));
  const assertionEarned = sum(checks.filter((check) => check.passed).map((check) => Number(check.weight || 0)));
  const normalizedAssertions = assertionWeight > 0 ? assertionEarned / assertionWeight * 90 : 90;
  const toolPolicy = arm === "shell"
    ? { passed: toolNames.length > 0 && toolNames.every((name) => name === "run_shell"), expected: ["run_shell"], actual: toolNames }
    : {
        passed: !toolNames.includes("run_shell") && currentCase.specializedRequiredTools.every((name) => toolNames.includes(name)),
        expected: currentCase.specializedRequiredTools,
        actual: toolNames
      };
  const score = runtimeError ? 0 : Math.round(Math.min(100, normalizedAssertions + (toolPolicy.passed ? 10 : 0)));
  return { score, checks, toolPolicy };
}

function containsNumber(text, expected) {
  const target = canonicalNumber(expected);
  const candidates = String(text).match(/[-+]?\d(?:[\d\s.,，]*\d)?/g) ?? [];
  return candidates.some((candidate) => canonicalNumberCandidates(candidate).has(target));
}

function canonicalNumber(value) {
  const normalized = String(value).replace(/[\s]/g, "").replace(/^\+/, "");
  if (!/^-?\d+(?:\.\d+)?$/.test(normalized)) {
    throw new Error(`无法规范化数字：${value}`);
  }
  const [integer, fraction = ""] = normalized.split(".");
  const cleanFraction = fraction.replace(/0+$/, "");
  const magnitude = String(BigInt(integer.replace(/^-/, "") || "0"));
  const sign = integer.startsWith("-") && (magnitude !== "0" || cleanFraction) ? "-" : "";
  const normalizedInteger = `${sign}${magnitude}`;
  return cleanFraction ? `${normalizedInteger}.${cleanFraction}` : normalizedInteger;
}

function canonicalNumberCandidates(value) {
  const token = String(value).replace(/[\s]/g, "").replace(/，/g, ",").replace(/^\+/, "");
  const variants = new Set([token]);
  const dotCount = (token.match(/\./g) ?? []).length;
  const commaCount = (token.match(/,/g) ?? []).length;

  if (commaCount > 0) {
    variants.add(token.replace(/,/g, ""));
    variants.add(token.replace(/\./g, "").replace(/,/g, "."));
  }
  if (dotCount > 0) {
    variants.add(token.replace(/\./g, ""));
  }
  if (dotCount > 0 || commaCount > 0) {
    variants.add(token.replace(/[.,]/g, ""));
  }

  const canonical = new Set();
  for (const variant of variants) {
    try {
      canonical.add(canonicalNumber(variant));
    } catch {
      // 同一文本可能有多种地区数字解释，只保留语法有效的候选。
    }
  }
  return canonical;
}

function summarize(runs) {
  const byArm = {};
  for (const arm of ["shell", "spreadsheet"]) {
    const selected = runs.filter((run) => run.arm === arm);
    if (!selected.length) continue;
    byArm[arm] = {
      runs: selected.length,
      passRate: selected.filter((run) => run.passed).length / selected.length,
      averageScore: average(selected.map((run) => run.score)),
      averageDurationMs: average(selected.map((run) => run.metrics.durationMs)),
      averagePromptTokensTotal: averageAvailable(selected.map((run) => run.metrics.promptTokensTotal)),
      averagePromptTokensMax: averageAvailable(selected.map((run) => run.metrics.promptTokensMax)),
      averageMessageCharsTotal: average(selected.map((run) => run.metrics.messageCharsTotal)),
      averageToolSchemaCharsTotal: average(selected.map((run) => run.metrics.toolSchemaCharsTotal)),
      averageToolResultCharsTotal: average(selected.map((run) => run.metrics.toolResultCharsTotal)),
      averageToolCalls: average(selected.map((run) => run.metrics.toolCalls))
    };
  }
  return { byArm };
}

function printSummary(summary) {
  console.log("[spreadsheet-ab-eval] summary");
  for (const [arm, value] of Object.entries(summary.byArm)) {
    console.log(`  ${arm}: score=${value.averageScore.toFixed(1)} passRate=${(value.passRate * 100).toFixed(0)}% promptTokens=${formatOptional(value.averagePromptTokensTotal)} messageChars=${value.averageMessageCharsTotal.toFixed(0)} toolResultChars=${value.averageToolResultCharsTotal.toFixed(0)} durationMs=${value.averageDurationMs.toFixed(0)}`);
  }
}

function parseArgs(args) {
  const values = Object.fromEntries(args.filter((arg) => arg.startsWith("--") && arg.includes("=")).map((arg) => {
    const [key, ...rest] = arg.slice(2).split("=");
    return [key, rest.join("=")];
  }));
  const arm = values.arm || "both";
  if (!["shell", "spreadsheet", "both"].includes(arm)) throw new Error("--arm 只支持 shell、spreadsheet 或 both。");
  const repetitions = Number(values.repetitions || 1);
  const timeoutMs = Number(values["timeout-ms"] || 600_000);
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 10) throw new Error("--repetitions 必须是 1-10。");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 10_000) throw new Error("--timeout-ms 至少为 10000。");
  return {
    all: args.includes("--all"),
    cases: values.cases ? values.cases.split(",").filter(Boolean) : undefined,
    model: values.model,
    arm,
    repetitions,
    timeoutMs
  };
}

function selectCases(cases, input) {
  if (input.all) return cases;
  const ids = input.cases ?? ["clean-single-table", "multi-file-localized-union", "join-cardinality-trap"];
  const selected = ids.map((id) => cases.find((item) => item.id === id));
  const missing = ids.filter((_, index) => !selected[index]);
  if (missing.length) throw new Error(`未知 case: ${missing.join(", ")}`);
  return selected;
}

function createInMemoryThreadStore() {
  const records = new Map();
  const threads = new Map();
  return {
    filePath: "memory://spreadsheet-ab-eval",
    markStaleRunningThreadsInterrupted() {},
    markUserInput(id, userInputAt) { threads.set(id, { ...(threads.get(id) ?? { threadId: id }), userInputAt }); },
    upsertThread(thread) {
      const next = { ...(threads.get(thread.threadId) ?? {}), ...thread };
      threads.set(thread.threadId, next);
      return next;
    },
    getThread(id) { return threads.get(id) ?? null; },
    listThreads() { return [...threads.values()]; },
    appendEvent(id, runId, event) {
      const items = records.get(id) ?? [];
      const seq = items.length + 1;
      const stored = { ...event, threadId: id, runId, seq };
      items.push({ threadId: id, runId, seq, type: stored.type, event: stored });
      records.set(id, items);
      return { event: stored };
    },
    loadEvents(id, afterSeq = 0) { return (records.get(id) ?? []).filter((record) => record.seq > afterSeq); }
  };
}

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} 超过 ${timeoutMs}ms。`)), timeoutMs);
        timer.unref?.();
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function writeReport() {
  await fs.writeFile(path.join(reportRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function sum(values) { return values.reduce((total, value) => total + Number(value || 0), 0); }
function average(values) { return values.length ? sum(values) / values.length : 0; }
function averageAvailable(values) {
  const available = values.filter((value) => Number.isFinite(value));
  return available.length ? average(available) : undefined;
}
function sumUsage(usages, keys) {
  const values = usages.map((usage) => readNumber(usage, keys)).filter((value) => value !== undefined);
  return values.length ? sum(values) : undefined;
}
function maxUsage(usages, keys) {
  const values = usages.map((usage) => readNumber(usage, keys)).filter((value) => value !== undefined);
  return values.length ? Math.max(...values) : undefined;
}
function readNumber(value, keys) {
  for (const key of keys) {
    const candidate = Number(value?.[key]);
    if (Number.isFinite(candidate)) return candidate;
  }
  return undefined;
}
function formatOptional(value) { return Number.isFinite(value) ? value.toFixed(0) : "n/a"; }
function timestamp() { return new Date().toISOString().replace(/[:.]/g, "-"); }
