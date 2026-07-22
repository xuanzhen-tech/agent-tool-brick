/**
 * 【文件说明】
 * 本文件实现 AgentTool 内置的数据可视化和结构化 BI 看板工具。
 *
 * 模型只能提交受控的声明式 Vega-Lite spec 与结构化面板数据；这里负责校验、
 * 实际渲染和输出目录写入，不执行模型提供的 HTML 或 JavaScript。每次成功都会
 * 返回 agent-output.v1 artifact，供 AgentCli 和产品 GUI 以统一方式消费。
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { Resvg } from "@resvg/resvg-js";
import { getVegaRuntime } from "./vega-runtime.mjs";

const MAX_INLINE_DATA_BYTES = 2 * 1024 * 1024;
const MAX_DASHBOARD_PANELS = 12;
const MAX_TABLE_ROWS = 500;
const MAX_TITLE_LENGTH = 120;
const DEFAULT_CHART_WIDTH = 680;
const DEFAULT_CHART_HEIGHT = 380;
const MAX_VEGA_EXPRESSION_LENGTH = 4_000;
const FORBIDDEN_VEGA_IDENTIFIERS = /\b(?:__proto__|constructor|prototype|globalThis|global|process|require|module|exports|function|eval|window|document|import|fetch|XMLHttpRequest)\b/i;
const SAFE_VEGA_EXPRESSION_CHARACTERS = /^[\p{L}\p{N}\s_.$()[\]'"+\-*/%<>=!&|?:,]+$/u;

export const VISUALIZATION_OUTPUT_SCHEMA_VERSION = "agent-output.v1";

/**
 * 执行单图表创建。输出目录由工具固定到 workspace/outputs/visualizations，
 * 不接受模型指定的任意磁盘路径，防止工具调用绕开工作区边界。
 */
export async function executeVisualizationCreateChart(call, _config, signal) {
  throwIfAborted(signal);
  const input = normalizeChartInput(call.arguments ?? {});
  const workspace = resolveWorkspace(call);
  const artifact = await renderChartArtifact({
    workspace,
    title: input.title,
    spec: input.spec,
    data: input.data,
    signal
  });
  return completedResult("已生成图表", artifact);
}

/**
 * 执行结构化看板创建。看板由 KPI、洞察、图表和表格面板组成；每个图表面板
 * 都经过与单图表相同的 Vega-Lite 编译和渲染，避免 renderer 合同出现两套逻辑。
 */
export async function executeVisualizationCreateDashboard(call, _config, signal) {
  throwIfAborted(signal);
  const input = normalizeDashboardInput(call.arguments ?? {});
  const workspace = resolveWorkspace(call);
  const artifactId = createArtifactId("dashboard");
  const directory = await createArtifactDirectory(workspace, artifactId);
  const chartArtifacts = [];

  for (const [index, panel] of input.panels.entries()) {
    throwIfAborted(signal);
    if (panel.kind !== "chart") continue;
    const chart = await renderChartFiles({
      directory,
      fileStem: `panel-${String(index + 1).padStart(2, "0")}`,
      title: panel.title,
      spec: panel.spec,
      data: panel.data,
      signal
    });
    chartArtifacts.push({ panelId: panel.id, ...chart });
  }

  const dashboard = {
    schemaVersion: "agent-dashboard.v1",
    id: artifactId,
    title: input.title,
    summary: input.summary,
    kpis: input.kpis,
    insights: input.insights,
    panels: input.panels.map((panel) => panel.kind === "chart"
      ? {
          id: panel.id,
          kind: panel.kind,
          title: panel.title,
          description: panel.description,
          chart: chartArtifacts.find((item) => item.panelId === panel.id)?.inline
        }
      : panel),
    createdAt: new Date().toISOString()
  };
  const dashboardPath = path.join(directory, "dashboard.json");
  const htmlPath = path.join(directory, "dashboard.html");
  const manifestPath = path.join(directory, "manifest.json");
  const dashboardContent = `${JSON.stringify(dashboard, null, 2)}\n`;
  const htmlContent = createDashboardHtml(dashboard, chartArtifacts);
  const chartOutputFiles = chartArtifacts.flatMap((chart) => chart.files.map((file) => toOutputFile(
    workspace,
    path.join(directory, file.path),
    file.mimeType,
    file.bytes
  )));
  await fs.writeFile(dashboardPath, dashboardContent, "utf8");
  await fs.writeFile(htmlPath, htmlContent, "utf8");
  await fs.writeFile(manifestPath, `${JSON.stringify({
    schemaVersion: VISUALIZATION_OUTPUT_SCHEMA_VERSION,
    kind: "visualization",
    renderer: "dashboard",
    id: artifactId,
    title: input.title,
    files: [
      toOutputFile(workspace, dashboardPath, "application/json", Buffer.byteLength(dashboardContent, "utf8")),
      toOutputFile(workspace, htmlPath, "text/html", Buffer.byteLength(htmlContent, "utf8")),
      ...chartOutputFiles
    ]
  }, null, 2)}\n`, "utf8");

  const artifact = {
    schemaVersion: VISUALIZATION_OUTPUT_SCHEMA_VERSION,
    kind: "visualization",
    renderer: "dashboard",
    id: artifactId,
    title: input.title,
    files: [
      toOutputFile(workspace, dashboardPath, "application/json", Buffer.byteLength(dashboardContent, "utf8")),
      toOutputFile(workspace, htmlPath, "text/html", Buffer.byteLength(htmlContent, "utf8")),
      toOutputFile(workspace, manifestPath, "application/json"),
      ...chartOutputFiles
    ],
    data: dashboard
  };
  return completedResult("已生成结构化 BI 看板", artifact);
}

async function renderChartArtifact({ workspace, title, spec, data, signal }) {
  const artifactId = createArtifactId("chart");
  const directory = await createArtifactDirectory(workspace, artifactId);
  const chart = await renderChartFiles({ directory, fileStem: "chart", title, spec, data, signal });
  const manifestPath = path.join(directory, "manifest.json");
  const artifact = {
    schemaVersion: VISUALIZATION_OUTPUT_SCHEMA_VERSION,
    kind: "visualization",
    renderer: "vega-lite",
    id: artifactId,
    title,
    files: [
      ...chart.files.map((file) => toOutputFile(workspace, path.join(directory, file.path), file.mimeType)),
      toOutputFile(workspace, manifestPath, "application/json")
    ],
    data: chart.inline
  };
  await fs.writeFile(manifestPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return artifact;
}

async function renderChartFiles({ directory, fileStem, title, spec, data, signal }) {
  throwIfAborted(signal);
  const normalizedSpec = normalizeVegaLiteSpec(spec, data, title);
  const { vega, vegaLite } = getVegaRuntime();
  const compiled = vegaLite.compile(normalizedSpec).spec;
  const runtime = vega.parse(compiled);
  const view = new vega.View(runtime, { renderer: "none" });
  const svg = await view.toSVG();
  throwIfAborted(signal);
  const png = new Resvg(svg, { fitTo: { mode: "original" } }).render().asPng();
  const jsonPath = `${fileStem}.vl.json`;
  const svgPath = `${fileStem}.svg`;
  const pngPath = `${fileStem}.png`;
  await Promise.all([
    fs.writeFile(path.join(directory, jsonPath), `${JSON.stringify(normalizedSpec, null, 2)}\n`, "utf8"),
    fs.writeFile(path.join(directory, svgPath), svg, "utf8"),
    fs.writeFile(path.join(directory, pngPath), png)
  ]);
  return {
    files: [
      { path: jsonPath, mimeType: "application/json", bytes: Buffer.byteLength(`${JSON.stringify(normalizedSpec, null, 2)}\n`, "utf8") },
      { path: svgPath, mimeType: "image/svg+xml", bytes: Buffer.byteLength(svg, "utf8") },
      { path: pngPath, mimeType: "image/png", bytes: png.byteLength }
    ],
    inline: {
      schemaVersion: "agent-visualization.vega-lite.v1",
      title,
      spec: normalizedSpec,
      preview: { svgFile: svgPath, pngFile: pngPath }
    }
  };
}

function normalizeChartInput(input) {
  if (!isRecord(input)) throw invalidInput("图表参数必须是对象。");
  return {
    title: normalizeTitle(input.title ?? "未命名图表"),
    spec: requireRecord(input.spec, "spec"),
    data: input.data
  };
}

function normalizeDashboardInput(input) {
  if (!isRecord(input)) throw invalidInput("看板参数必须是对象。");
  const rawPanels = Array.isArray(input.panels) ? input.panels : [];
  if (!rawPanels.length) throw invalidInput("看板至少需要一个 panels 条目。");
  if (rawPanels.length > MAX_DASHBOARD_PANELS) throw invalidInput(`看板最多允许 ${MAX_DASHBOARD_PANELS} 个面板。`);
  const panelIds = new Set();
  const panels = rawPanels.map((raw, index) => {
    if (!isRecord(raw)) throw invalidInput(`panels[${index}] 必须是对象。`);
    const id = normalizeId(raw.id ?? `panel-${index + 1}`);
    if (panelIds.has(id)) throw invalidInput(`看板面板 id 重复: ${id}`);
    panelIds.add(id);
    const kind = String(raw.kind ?? "").trim();
    if (kind === "chart") {
      return {
        id,
        kind,
        title: normalizeTitle(raw.title ?? `图表 ${index + 1}`),
        description: optionalText(raw.description, 600),
        spec: requireRecord(raw.spec, `panels[${index}].spec`),
        data: raw.data
      };
    }
    if (kind === "table") {
      const columns = Array.isArray(raw.columns) ? raw.columns.map((column) => normalizeTitle(column)) : [];
      const rows = Array.isArray(raw.rows) ? raw.rows : [];
      if (!columns.length) throw invalidInput(`panels[${index}] 的 table 需要 columns。`);
      if (rows.length > MAX_TABLE_ROWS) throw invalidInput(`panels[${index}] 的 table 最多允许 ${MAX_TABLE_ROWS} 行。`);
      return {
        id,
        kind,
        title: normalizeTitle(raw.title ?? `表格 ${index + 1}`),
        description: optionalText(raw.description, 600),
        columns,
        rows: rows.map((row) => Array.isArray(row) ? row.map((cell) => serializeCell(cell)) : columns.map((column) => serializeCell(row?.[column])))
      };
    }
    if (kind === "text") {
      return {
        id,
        kind,
        title: normalizeTitle(raw.title ?? `说明 ${index + 1}`),
        content: optionalText(raw.content, 12_000)
      };
    }
    throw invalidInput(`panels[${index}].kind 仅支持 chart、table 或 text。`);
  });
  return {
    title: normalizeTitle(input.title ?? "未命名看板"),
    summary: optionalText(input.summary, 2_000),
    kpis: normalizeKpis(input.kpis),
    insights: normalizeTextList(input.insights, 20, 600),
    panels
  };
}

function normalizeVegaLiteSpec(rawSpec, data, title) {
  const spec = structuredClone(requireRecord(rawSpec, "spec"));
  rejectUnsafeSpec(spec);
  if (!isRecord(spec.encoding) && !Array.isArray(spec.layer) && !Array.isArray(spec.concat) && !Array.isArray(spec.hconcat) && !Array.isArray(spec.vconcat)) {
    throw invalidInput("Vega-Lite spec 必须包含 encoding 或组合图表结构。");
  }
  if (data !== undefined) {
    assertInlineData(data);
    spec.data = { values: data };
  } else if (spec.data !== undefined) {
    if (!isRecord(spec.data) || !Array.isArray(spec.data.values)) {
      throw invalidInput("图表 data 只支持内联 values 数组；不允许 URL、文件或远端数据源。`data` 可由工具参数传入。 ");
    }
    assertInlineData(spec.data.values);
  } else {
    throw invalidInput("图表必须提供 data 或 spec.data.values。 ");
  }
  spec.$schema = "https://vega.github.io/schema/vega-lite/v6.json";
  if (!spec.title) spec.title = title;
  if (!Number.isFinite(spec.width)) spec.width = DEFAULT_CHART_WIDTH;
  if (!Number.isFinite(spec.height)) spec.height = DEFAULT_CHART_HEIGHT;
  return spec;
}

function rejectUnsafeSpec(spec) {
  const serialized = JSON.stringify(spec);
  if (serialized.length > MAX_INLINE_DATA_BYTES) throw invalidInput("图表 spec 超过允许大小。 ");
  // transform 是 Vega-Lite 的正常数据整形能力。旧图表中常见的 fold、calculate
  // 和 aggregate 都依赖它，因此不能粗暴禁止；表达式和值域另由下方单独收紧。
  const prohibited = ["url", "signal", "expr", "lookup"];
  for (const key of prohibited) {
    if (containsKey(spec, key)) {
      throw invalidInput(`图表 spec 不允许 ${key} 字段；请只提交纯声明式内联数据图表。`);
    }
  }
  validateVegaLiteTransforms(spec);
}

/**
 * 校验任意层级上的 Vega-Lite transform。
 *
 * Vega-Lite 的 transform 本身是声明式数据处理，不等同于任意 JavaScript。我们保留
 * 常用的 fold、aggregate、filter 和 calculate，同时限制 calculate/filter 表达式为
 * Vega 的数据表达式子集，拒绝全局对象、构造器与脚本式入口。
 */
function validateVegaLiteTransforms(value) {
  if (Array.isArray(value)) {
    value.forEach(validateVegaLiteTransforms);
    return;
  }
  if (!isRecord(value)) return;
  if (value.transform !== undefined) {
    if (!Array.isArray(value.transform)) throw invalidInput("图表 transform 必须是数组。 ");
    value.transform.forEach((transform, index) => validateVegaLiteTransform(transform, index));
  }
  for (const [key, child] of Object.entries(value)) {
    if (key !== "transform") validateVegaLiteTransforms(child);
  }
}

function validateVegaLiteTransform(transform, index) {
  if (!isRecord(transform)) throw invalidInput(`transform[${index}] 必须是对象。`);
  if (transform.lookup !== undefined) throw invalidInput(`transform[${index}] 不允许 lookup。`);
  if (transform.calculate !== undefined) {
    assertSafeVegaExpression(transform.calculate, `transform[${index}].calculate`);
    if (typeof transform.as !== "string" || !transform.as.trim()) {
      throw invalidInput(`transform[${index}] 使用 calculate 时必须提供 as。`);
    }
  }
  if (typeof transform.filter === "string") {
    assertSafeVegaExpression(transform.filter, `transform[${index}].filter`);
  }
}

function assertSafeVegaExpression(value, label) {
  if (typeof value !== "string" || !value.trim()) throw invalidInput(`${label} 必须是非空字符串。`);
  if (value.length > MAX_VEGA_EXPRESSION_LENGTH) throw invalidInput(`${label} 超过允许长度。`);
  if (!SAFE_VEGA_EXPRESSION_CHARACTERS.test(value) || FORBIDDEN_VEGA_IDENTIFIERS.test(value)) {
    throw invalidInput(`${label} 包含不允许的表达式内容。`);
  }
}

function containsKey(value, key) {
  if (Array.isArray(value)) return value.some((item) => containsKey(item, key));
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([currentKey, currentValue]) => currentKey === key || containsKey(currentValue, key));
}

function assertInlineData(data) {
  if (!Array.isArray(data)) throw invalidInput("图表 data 必须是对象数组。 ");
  const serialized = JSON.stringify(data);
  if (Buffer.byteLength(serialized, "utf8") > MAX_INLINE_DATA_BYTES) {
    throw invalidInput(`图表 data 超过 ${MAX_INLINE_DATA_BYTES} 字节限制。`);
  }
  if (!data.every((row) => isRecord(row))) throw invalidInput("图表 data 的每一行必须是对象。 ");
}

function normalizeKpis(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) throw invalidInput("kpis 必须是最多 20 项的数组。 ");
  return value.map((item, index) => {
    if (!isRecord(item)) throw invalidInput(`kpis[${index}] 必须是对象。`);
    return {
      label: normalizeTitle(item.label ?? `指标 ${index + 1}`),
      value: optionalText(item.value, 200),
      change: optionalText(item.change, 200),
      tone: ["neutral", "positive", "negative"].includes(item.tone) ? item.tone : "neutral"
    };
  });
}

function normalizeTextList(value, maxItems, maxChars) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems) throw invalidInput(`列表最多允许 ${maxItems} 项。`);
  return value.map((item) => optionalText(item, maxChars)).filter(Boolean);
}

async function createArtifactDirectory(workspace, artifactId) {
  const directory = path.join(workspace, "outputs", "visualizations", artifactId);
  await fs.mkdir(directory, { recursive: true });
  return directory;
}

function resolveWorkspace(call) {
  const workspace = call?.workspace?.root;
  if (typeof workspace !== "string" || !workspace.trim()) {
    throw invalidInput("可视化工具需要调用方提供绝对 workspace 路径。 ");
  }
  return path.resolve(workspace);
}

function createArtifactId(prefix) {
  return `${prefix}-${new Date().toISOString().replaceAll(/[-:.TZ]/g, "").slice(0, 14)}-${crypto.randomUUID().slice(0, 8)}`;
}

function toOutputFile(workspace, absolutePath, mimeType, bytes) {
  return {
    path: path.relative(workspace, absolutePath).replaceAll(path.sep, "/"),
    mimeType,
    ...(Number.isFinite(bytes) ? { bytes } : {})
  };
}

function completedResult(message, artifact) {
  return {
    status: "completed",
    content: `${message}：${artifact.files.map((file) => file.path).join("、")}`,
    details: {
      artifact: summarizeArtifact(artifact)
    },
    artifacts: [artifact]
  };
}

function summarizeArtifact(artifact) {
  return {
    schemaVersion: artifact.schemaVersion,
    kind: artifact.kind,
    renderer: artifact.renderer,
    id: artifact.id,
    title: artifact.title,
    files: artifact.files
  };
}

function createDashboardHtml(dashboard, charts) {
  const chartByPanel = new Map(charts.map((chart) => [chart.panelId, chart]));
  const panelHtml = dashboard.panels.map((panel) => {
    if (panel.kind === "chart") {
      const chart = chartByPanel.get(panel.id);
      return `<section class="panel"><h2>${escapeHtml(panel.title)}</h2>${panel.description ? `<p>${escapeHtml(panel.description)}</p>` : ""}<img src="${escapeHtml(chart?.files.find((file) => file.path.endsWith(".svg"))?.path ?? "")}" alt="${escapeHtml(panel.title)}"></section>`;
    }
    if (panel.kind === "table") {
      const head = panel.columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("");
      const body = panel.rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("");
      return `<section class="panel"><h2>${escapeHtml(panel.title)}</h2><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></section>`;
    }
    return `<section class="panel"><h2>${escapeHtml(panel.title)}</h2><p>${escapeHtml(panel.content)}</p></section>`;
  }).join("\n");
  const kpis = dashboard.kpis.map((kpi) => `<article class="kpi ${escapeHtml(kpi.tone)}"><span>${escapeHtml(kpi.label)}</span><strong>${escapeHtml(kpi.value)}</strong>${kpi.change ? `<small>${escapeHtml(kpi.change)}</small>` : ""}</article>`).join("");
  const insights = dashboard.insights.length ? `<section class="insights"><h2>关键洞察</h2><ul>${dashboard.insights.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></section>` : "";
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(dashboard.title)}</title><style>
body{font-family:Arial,"Microsoft YaHei",sans-serif;margin:32px;color:#18212f;background:#f7f9fc}h1{margin-bottom:6px}.summary{color:#526174}.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin:20px 0}.kpi,.panel,.insights{background:#fff;border:1px solid #dce3ed;border-radius:6px;padding:16px}.kpi span,.kpi small{display:block;color:#5f6e7f}.kpi strong{font-size:28px;display:block;margin:8px 0}.positive strong{color:#147a48}.negative strong{color:#bd3030}.panel{margin:14px 0}img{max-width:100%;height:auto}table{border-collapse:collapse;width:100%}th,td{border:1px solid #dce3ed;padding:8px;text-align:left}th{background:#f1f5f9}</style></head>
<body><h1>${escapeHtml(dashboard.title)}</h1>${dashboard.summary ? `<p class="summary">${escapeHtml(dashboard.summary)}</p>` : ""}<div class="kpis">${kpis}</div>${insights}<main>${panelHtml}</main></body></html>`;
}

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new Error(String(signal.reason ?? "可视化任务已取消。"));
}

function normalizeTitle(value) {
  const text = optionalText(value, MAX_TITLE_LENGTH);
  if (!text) throw invalidInput("标题必须是非空字符串。 ");
  return text;
}

function normalizeId(value) {
  const text = String(value ?? "").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(text)) {
    throw invalidInput("面板 id 只能使用字母、数字、下划线和连字符。 ");
  }
  return text;
}

function optionalText(value, maxLength) {
  if (value === undefined || value === null) return "";
  const text = String(value).trim();
  if (text.length > maxLength) throw invalidInput(`文本长度不能超过 ${maxLength} 个字符。`);
  return text;
}

function serializeCell(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function requireRecord(value, label) {
  if (!isRecord(value)) throw invalidInput(`${label} 必须是对象。`);
  return value;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidInput(message) {
  const error = new Error(message);
  error.code = "invalid_visualization_input";
  return error;
}
