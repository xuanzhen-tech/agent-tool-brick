/**
 * 【文件说明】
 * 本文件实现确定性表格检查、计算和校验工具的 Node 侧边界。
 *
 * 模型只能提交声明式参数；真正的数据读取和 Decimal 运算交给随积木发布的
 * Python worker。完整数据保存在 workspace/temp，工具结果只返回摘要和稳定引用。
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runProcess } from "./process-runtime.mjs";

const WORKER_PATH = fileURLToPath(new URL("./spreadsheet-worker.py", import.meta.url));
const WORKER_TIMEOUT_MS = 120_000;
const WORKER_OUTPUT_BYTES = 2 * 1024 * 1024;
const ID_PATTERN = /^(?:analysis|result|validation)-[a-z0-9-]{8,80}$/;
const DATA_REF_SCHEMA_VERSION = "agent-spreadsheet.data-ref.v1";
const RESULT_SCHEMA_VERSION = "agent-spreadsheet.result.v1";
const DATA_SCHEMA_VERSION = "agent-spreadsheet.data.v1";

export async function executeSpreadsheetInspect(call, config, signal) {
  const value = await runSpreadsheetWorker("inspect", call, config, signal);
  if (!value.ok) return workerFailureResult(value.error);
  const summary = value.value;
  if (summary.inspectionStatus === "blocked") {
    const content = {
      analysisId: summary.analysisId,
      inspectionStatus: summary.inspectionStatus,
      source: summary.source,
      warnings: summary.warnings,
      guidance: summary.guidance
    };
    return {
      status: "blocked",
      content: JSON.stringify(content),
      details: {
        blocked: true,
        reasonCode: "spreadsheet_no_table_detected",
        analysisId: summary.analysisId,
        manifestPath: summary.manifestPath
      },
      error: { code: "spreadsheet_no_table_detected", message: summary.guidance }
    };
  }
  return {
    status: "completed",
    content: JSON.stringify({
      analysisId: summary.analysisId,
      inspectionStatus: summary.inspectionStatus,
      source: summary.source,
      sheets: summary.sheets,
      tables: summary.tables,
      warnings: summary.warnings,
      guidance: summary.guidance
    }),
    details: {
      analysisId: summary.analysisId,
      inspectionStatus: summary.inspectionStatus,
      manifestPath: summary.manifestPath,
      tableCount: summary.tables.length,
      warningCount: summary.warnings.length
    }
  };
}

export async function executeSpreadsheetCompute(call, config, signal) {
  const value = await runSpreadsheetWorker("compute", call, config, signal);
  if (!value.ok) return workerFailureResult(value.error);
  const summary = value.value;
  return {
    status: "completed",
    content: JSON.stringify({
      analysisId: summary.analysisId,
      results: summary.results,
      warnings: summary.warnings,
      guidance: "正式数字、图表和看板应继续引用这里返回的 analysisId/resultId，不要重新心算或复制后再计算。"
    }),
    details: {
      analysisId: summary.analysisId,
      resultIds: summary.results.map((item) => item.resultId),
      resultCount: summary.results.length,
      warningCount: summary.warnings.length
    }
  };
}

export async function executeSpreadsheetValidate(call, config, signal) {
  const value = await runSpreadsheetWorker("validate", call, config, signal);
  if (!value.ok) return workerFailureResult(value.error);
  const summary = value.value;
  const failed = summary.validationStatus === "failed";
  const blocked = summary.validationStatus === "blocked";
  const content = {
    analysisId: summary.analysisId,
    validationId: summary.validationId,
    validationStatus: summary.validationStatus,
    counts: summary.counts,
    checks: summary.checks,
    checksTruncated: summary.checksTruncated,
    reportPath: summary.reportPath,
    guidance: failed || blocked
      ? "数据闭环未通过。只能交付差异、可用范围和补数清单，不得继续输出正式经营策略。"
      : "数据闭环已通过；正式交付仍须引用相同的 analysisId/resultId。"
  };
  if (blocked) {
    return {
      status: "blocked",
      content: JSON.stringify(content),
      details: compactValidationDetails(summary, true),
      error: { code: "spreadsheet_validation_blocked", message: content.guidance }
    };
  }
  if (failed) {
    return {
      status: "failed",
      content: JSON.stringify(content),
      details: compactValidationDetails(summary, false),
      error: { code: "spreadsheet_validation_failed", message: content.guidance }
    };
  }
  return {
    status: "completed",
    content: JSON.stringify(content),
    details: {
      analysisId: summary.analysisId,
      validationId: summary.validationId,
      validationStatus: summary.validationStatus,
      counts: summary.counts,
      reportPath: summary.reportPath
    }
  };
}

/**
 * 解析可视化工具使用的 canonical dataRef，并重新校验磁盘内容哈希。
 */
export async function resolveSpreadsheetDataRef(workspace, input) {
  const ref = normalizeDataRef(input);
  const workspaceRoot = await resolveWorkspaceRoot(workspace);
  const expectedAnalysisDirectory = path.join(workspaceRoot, "temp", "spreadsheets", ref.analysisId);
  const analysisDirectory = await fs.realpath(expectedAnalysisDirectory).catch(() => undefined);
  if (!analysisDirectory || !isPathInside(workspaceRoot, analysisDirectory)) {
    throw spreadsheetError("spreadsheet_result_not_found", "找不到安全的表格分析目录。", { ref });
  }
  const manifestPath = path.join(analysisDirectory, "results", `${ref.resultId}.manifest.json`);
  const manifest = await readJson(manifestPath, "spreadsheet_result_not_found");
  if (manifest.schemaVersion !== RESULT_SCHEMA_VERSION || manifest.analysisId !== ref.analysisId || manifest.resultId !== ref.resultId) {
    throw spreadsheetError("spreadsheet_result_invalid", "表格结果 manifest 与 dataRef 不一致。", { ref });
  }
  const expectedDataPath = resolveChildPath(analysisDirectory, manifest.dataFile, "spreadsheet_result_invalid");
  const dataPath = await fs.realpath(expectedDataPath).catch(() => undefined);
  if (!dataPath || !isPathInside(analysisDirectory, dataPath)) {
    throw spreadsheetError("spreadsheet_result_invalid", "表格结果文件逃逸分析目录。", { ref });
  }
  const raw = await fs.readFile(dataPath);
  const actualHash = crypto.createHash("sha256").update(raw).digest("hex");
  if (actualHash !== manifest.dataHash) {
    throw spreadsheetError("spreadsheet_result_hash_mismatch", "表格结果内容已变化，不能继续用于正式可视化。", {
      expected: manifest.dataHash,
      actual: actualHash
    });
  }
  const data = JSON.parse(raw.toString("utf8"));
  if (data.schemaVersion !== DATA_SCHEMA_VERSION || !Array.isArray(data.rows) || !Array.isArray(data.columns)) {
    throw spreadsheetError("spreadsheet_result_invalid", "表格结果数据结构无效。", { ref });
  }
  return {
    ref,
    rows: materializeVisualizationRows(data.rows, data.columns),
    rawRows: data.rows,
    columns: data.columns,
    rowCount: Number(manifest.rowCount ?? data.rows.length),
    truncated: Boolean(manifest.truncated),
    provenance: {
      schemaVersion: DATA_REF_SCHEMA_VERSION,
      analysisId: ref.analysisId,
      resultId: ref.resultId,
      queryId: manifest.queryId,
      sourceHash: manifest.sourceHash,
      dataHash: manifest.dataHash,
      lineage: manifest.lineage
    }
  };
}

export async function resolveSpreadsheetValueRef(workspace, input, cache = new Map()) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw spreadsheetError("spreadsheet_value_ref_invalid", "valueRef 必须是对象。", {});
  }
  const ref = normalizeDataRef(input);
  const key = `${ref.analysisId}:${ref.resultId}`;
  let resolved = cache.get(key);
  if (!resolved) {
    resolved = await resolveSpreadsheetDataRef(workspace, ref);
    cache.set(key, resolved);
  }
  const rowIndex = input.rowIndex === undefined ? 0 : Number(input.rowIndex);
  if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= resolved.rawRows.length) {
    throw spreadsheetError("spreadsheet_value_ref_invalid", `valueRef.rowIndex 超出结果范围: ${input.rowIndex}`, {});
  }
  const field = typeof input.field === "string" ? input.field.trim() : "";
  if (!field || !Object.hasOwn(resolved.rawRows[rowIndex], field)) {
    throw spreadsheetError("spreadsheet_value_ref_invalid", `valueRef.field 不存在: ${field || "<empty>"}`, {});
  }
  const value = resolved.rawRows[rowIndex][field];
  if (value === null || value === undefined) {
    throw spreadsheetError("spreadsheet_value_not_computable", `引用值不可计算: ${field}`, {});
  }
  return { value: String(value), provenance: resolved.provenance };
}

export function isSpreadsheetDataRef(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && value.schemaVersion === DATA_REF_SCHEMA_VERSION);
}

async function runSpreadsheetWorker(action, call, config, signal) {
  const workspace = await resolveWorkspaceRoot(call?.workspace?.root);
  if (!config?.pythonBin) {
    return {
      ok: false,
      error: {
        code: "spreadsheet_python_runtime_unavailable",
        message: "表格工具需要产品注入 python-runtime。",
        blocked: true
      }
    };
  }
  const result = await runProcess({
    executable: config.pythonBin,
    args: [WORKER_PATH],
    cwd: workspace,
    stdin: JSON.stringify({ action, workspace, arguments: call.arguments ?? {} }),
    timeoutMs: Math.min(Number(config.maxTimeoutMs ?? WORKER_TIMEOUT_MS), WORKER_TIMEOUT_MS),
    maxOutputBytes: WORKER_OUTPUT_BYTES,
    signal,
    env: config.runtimeEnv ? { ...process.env, ...config.runtimeEnv } : process.env
  });
  if (result.interrupted) {
    return { ok: false, error: { code: "spreadsheet_interrupted", message: "表格操作已中断。", interrupted: true } };
  }
  if (result.timedOut) {
    return { ok: false, error: { code: "spreadsheet_timeout", message: "表格操作超过 120 秒限制。" } };
  }
  if (result.exitCode !== 0) {
    return {
      ok: false,
      error: {
        code: "spreadsheet_worker_failed",
        message: result.stderr.trim() || `Python worker 退出码为 ${result.exitCode}。`
      }
    };
  }
  try {
    const parsed = JSON.parse(result.stdout);
    return parsed?.ok === true
      ? parsed
      : { ok: false, error: parsed?.error ?? { code: "spreadsheet_worker_failed", message: "Python worker 返回未知错误。" } };
  } catch {
    return {
      ok: false,
      error: {
        code: "spreadsheet_worker_invalid_response",
        message: "无法解析 Python worker 返回值。",
        details: { stdout: result.stdout.slice(0, 2_000), stderr: result.stderr.slice(0, 2_000) }
      }
    };
  }
}

function workerFailureResult(error = {}) {
  const status = error.interrupted ? "interrupted" : error.blocked ? "blocked" : "failed";
  const message = error.message || "表格操作失败。";
  return {
    status,
    content: message,
    details: {
      blocked: status === "blocked",
      interrupted: status === "interrupted",
      reasonCode: error.code ?? "spreadsheet_operation_failed",
      reason: message,
      ...(error.details ? { evidence: error.details } : {})
    },
    error: { code: error.code ?? "spreadsheet_operation_failed", message }
  };
}

function compactValidationDetails(summary, blocked) {
  return {
    blocked,
    reasonCode: blocked ? "spreadsheet_validation_blocked" : "spreadsheet_validation_failed",
    analysisId: summary.analysisId,
    validationId: summary.validationId,
    validationStatus: summary.validationStatus,
    counts: summary.counts,
    reportPath: summary.reportPath
  };
}

async function resolveWorkspaceRoot(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw spreadsheetError("spreadsheet_workspace_required", "表格工具需要调用方提供绝对 workspace 路径。", {});
  }
  const resolved = path.resolve(value);
  const stat = await fs.stat(resolved).catch(() => undefined);
  if (!stat?.isDirectory()) {
    throw spreadsheetError("spreadsheet_workspace_invalid", "workspace 不存在或不是目录。", { workspace: resolved });
  }
  return await fs.realpath(resolved);
}

function normalizeDataRef(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw spreadsheetError("spreadsheet_data_ref_invalid", "dataRef 必须是对象。", {});
  }
  if (value.schemaVersion !== DATA_REF_SCHEMA_VERSION) {
    throw spreadsheetError("spreadsheet_data_ref_invalid", `dataRef.schemaVersion 必须是 ${DATA_REF_SCHEMA_VERSION}。`, {});
  }
  const analysisId = normalizeId(value.analysisId, "analysisId");
  const resultId = normalizeId(value.resultId, "resultId");
  return { schemaVersion: DATA_REF_SCHEMA_VERSION, analysisId, resultId };
}

function normalizeId(value, name) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!ID_PATTERN.test(normalized)) {
    throw spreadsheetError("spreadsheet_data_ref_invalid", `${name} 格式无效。`, {});
  }
  return normalized;
}

function resolveChildPath(parent, relativePath, code) {
  if (typeof relativePath !== "string" || !relativePath.trim() || path.isAbsolute(relativePath)) {
    throw spreadsheetError(code, "表格结果包含非法文件路径。", {});
  }
  const resolved = path.resolve(parent, relativePath);
  const relative = path.relative(parent, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw spreadsheetError(code, "表格结果文件路径逃逸分析目录。", {});
  }
  return resolved;
}

function isPathInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function readJson(filePath, code) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    throw spreadsheetError(code, "找不到或无法读取表格结果。", { message: error instanceof Error ? error.message : String(error) });
  }
}

function materializeVisualizationRows(rows, columns) {
  const types = new Map(columns.map((column) => [column.name, column.type]));
  return rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => {
    if (value === null || value === undefined) return [key, null];
    if (["decimal", "integer", "number"].includes(types.get(key))) {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) {
        throw spreadsheetError("spreadsheet_visualization_value_invalid", `字段 ${key} 无法转换为有限数值。`, { value });
      }
      return [key, numeric];
    }
    return [key, value];
  })));
}

function spreadsheetError(code, message, details) {
  return Object.assign(new Error(message), { code, details });
}
