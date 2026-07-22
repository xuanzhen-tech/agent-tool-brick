/**
 * 【文件说明】
 * 本脚本执行真实 Vega-Lite 与 Resvg 渲染，验证 agent-tool 的预制图表和 BI
 * 看板不是只返回 schema 或 mock 数据，而是会生成可打开的 workspace 输出文件。
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { AgentTool } from "../index.mjs";

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "agent-tool-visualization-"));
const tool = new AgentTool({
  workspace,
  tools: ["visualization_create_chart", "visualization_create_dashboard"]
});

try {
  assert.deepEqual(
    tool.definitions.map((item) => item.function?.name).sort(),
    ["visualization_create_chart", "visualization_create_dashboard"].sort()
  );

  const chart = await tool.execute("visualization_create_chart", {
    title: "月度销量",
    data: [
      { month: "一月", sales: 12 },
      { month: "二月", sales: 18 },
      { month: "三月", sales: 15 }
    ],
    spec: {
      mark: "bar",
      encoding: {
        x: { field: "month", type: "nominal", title: "月份" },
        y: { field: "sales", type: "quantitative", title: "销量" }
      }
    }
  }, { workspace });
  assert.equal(chart.status, "completed");
  await assertArtifactFiles(chart.artifacts?.[0], workspace, [".vl.json", ".svg", ".png", "manifest.json"]);
  const chartSvg = await readArtifact(chart.artifacts[0], workspace, ".svg");
  assert.match(chartSvg, /<svg/);

  const dashboard = await tool.execute("visualization_create_dashboard", {
    title: "销售概览",
    summary: "用于 smoke 的结构化看板。",
    kpis: [{ label: "总销量", value: "45", change: "+12%", tone: "positive" }],
    insights: ["二月销量最高。"],
    panels: [
      {
        id: "trend",
        kind: "chart",
        title: "月度趋势",
        data: [{ month: "一月", sales: 12 }, { month: "二月", sales: 18 }],
        spec: {
          mark: "line",
          encoding: {
            x: { field: "month", type: "ordinal" },
            y: { field: "sales", type: "quantitative" }
          }
        }
      },
      {
        id: "detail",
        kind: "table",
        title: "数据明细",
        columns: ["月份", "销量"],
        rows: [["一月", 12], ["二月", 18]]
      }
    ]
  }, { workspace });
  assert.equal(dashboard.status, "completed");
  await assertArtifactFiles(dashboard.artifacts?.[0], workspace, ["dashboard.json", "dashboard.html", ".svg", ".png"]);
  const dashboardHtml = await readArtifact(dashboard.artifacts[0], workspace, "dashboard.html");
  assert.match(dashboardHtml, /销售概览/);
  assert.match(dashboardHtml, /panel-01\.svg/);

  const transformed = await tool.execute("visualization_create_chart", {
    title: "旧图表兼容的 transform",
    data: [{ month: "一月", online: 12, offline: 8 }, { month: "二月", online: 18, offline: 10 }],
    spec: {
      mark: "bar",
      transform: [
        { fold: ["online", "offline"], as: ["channel", "sales"] },
        { calculate: "if(datum.channel == 'online', '线上', '线下')", as: "channelLabel" }
      ],
      encoding: {
        x: { field: "month", type: "nominal" },
        y: { field: "sales", type: "quantitative" },
        color: { field: "channelLabel", type: "nominal" }
      }
    }
  }, { workspace });
  assert.equal(transformed.status, "completed", transformed.content);

  const unsafe = await tool.execute("visualization_create_chart", {
    title: "非法图表",
    data: [{ category: "A", value: 1 }],
    spec: {
      mark: "bar",
      data: { url: "https://example.invalid/data.json" },
      encoding: { x: { field: "category", type: "nominal" }, y: { field: "value", type: "quantitative" } }
    }
  }, { workspace });
  assert.equal(unsafe.status, "failed");
  assert.equal(unsafe.error.code, "tool_execution_failed");

  const unsafeExpression = await tool.execute("visualization_create_chart", {
    title: "非法表达式",
    data: [{ category: "A", value: 1 }],
    spec: {
      mark: "bar",
      transform: [{ calculate: "global.process.exit()", as: "unsafe" }],
      encoding: { x: { field: "category", type: "nominal" }, y: { field: "value", type: "quantitative" } }
    }
  }, { workspace });
  assert.equal(unsafeExpression.status, "failed");
  assert.equal(unsafeExpression.error.code, "tool_execution_failed");

  console.log("[smoke-visualizations] ok", workspace);
} finally {
  await tool.dispose();
  await fs.rm(workspace, { recursive: true, force: true });
}

async function assertArtifactFiles(artifact, workspaceRoot, expectedNames) {
  assert.equal(artifact?.schemaVersion, "agent-output.v1");
  assert.equal(artifact?.kind, "visualization");
  assert.equal(Array.isArray(artifact?.files), true);
  for (const expected of expectedNames) {
    const file = artifact.files.find((item) => item.path.endsWith(expected));
    assert.ok(file, `缺少产物文件: ${expected}`);
    const absolute = path.join(workspaceRoot, file.path);
    const stat = await fs.stat(absolute);
    assert.ok(stat.size > 0, `产物为空: ${file.path}`);
  }
}

async function readArtifact(artifact, workspaceRoot, ending) {
  const file = artifact.files.find((item) => item.path.endsWith(ending));
  assert.ok(file, `未找到 ${ending}`);
  return await fs.readFile(path.join(workspaceRoot, file.path), "utf8");
}
