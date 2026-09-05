/**
 * 【文件说明】
 * 本脚本使用真实 Python/openpyxl 工作簿验证表格检查、Decimal 计算、质量门、
 * 数据引用和可视化闭环，不使用 fetch 或伪造的 worker 返回值。
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AgentTool } from "../index.mjs";

const pythonBin = process.env.AGENT_TOOL_PYTHON_BIN || "python";
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "agent-tool-spreadsheet-"));
const externalRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-tool-spreadsheet-outside-"));
const fixtureScript = fileURLToPath(new URL("./create-spreadsheet-fixtures.py", import.meta.url));
const fixture = spawnSync(pythonBin, [fixtureScript, workspace], { encoding: "utf8", windowsHide: true });
assert.equal(fixture.status, 0, fixture.stderr || fixture.stdout);

await fs.writeFile(path.join(workspace, "uploads", "ambiguous.csv"), "id,spend\na,\"1,234.56\"\n", "utf8");
await fs.writeFile(path.join(workspace, "uploads", "simple.tsv"), "id\tvalue\na\t1\nb\t2\n", "utf8");
await fs.writeFile(path.join(workspace, "uploads", "numeric-order.csv"), "id,value\na,2\nb,10\n", "utf8");
await fs.writeFile(
  path.join(workspace, "uploads", "many-zero-denominators.csv"),
  `id,spend,sales\n${Array.from({ length: 150 }, (_, index) => `row-${index + 1},1,0`).join("\n")}\n`,
  "utf8"
);
await fs.writeFile(
  path.join(workspace, "uploads", "large.csv"),
  `id,value\n${Array.from({ length: 100_001 }, (_, index) => `row-${index + 1},${index + 1}`).join("\n")}\n`,
  "utf8"
);
await fs.writeFile(path.join(workspace, "uploads", "corrupt.xlsx"), "not-an-xlsx", "utf8");
await fs.writeFile(
  path.join(workspace, "uploads", "multi-owner.csv"),
  "campaignId,owner\nA,team-1\nB,team-2\nC,team-1\n",
  "utf8"
);
await fs.writeFile(path.join(externalRoot, "outside.csv"), "id,value\noutside,1\n", "utf8");
const linkedDirectory = path.join(workspace, "uploads", "linked-outside");
await fs.symlink(externalRoot, linkedDirectory, process.platform === "win32" ? "junction" : "dir");

const tool = new AgentTool({
  workspace,
  runtimeDependencies: [{ type: "python-runtime", bin: pythonBin }],
  tools: [
    "spreadsheet_inspect",
    "spreadsheet_compute",
    "spreadsheet_validate",
    "visualization_create_chart",
    "visualization_create_dashboard"
  ]
});
const defaultTool = new AgentTool({
  workspace,
  runtimeDependencies: [{ type: "python-runtime", bin: pythonBin }]
});

try {
  assert.equal(defaultTool.definitions.some((item) => item.function?.name.startsWith("spreadsheet_")), false);
  assert.deepEqual(
    tool.definitions.map((item) => item.function?.name).sort(),
    [
      "spreadsheet_inspect",
      "spreadsheet_compute",
      "spreadsheet_validate",
      "tool_result_read",
      "tool_result_search",
      "visualization_create_chart",
      "visualization_create_dashboard"
    ].sort()
  );
  const inspectDefinition = tool.definitions.find((item) => item.function?.name === "spreadsheet_inspect");
  const computeDefinition = tool.definitions.find((item) => item.function?.name === "spreadsheet_compute");
  const validateDefinition = tool.definitions.find((item) => item.function?.name === "spreadsheet_validate");
  assert.equal(inspectDefinition.function.parameters.properties.sources.maxItems, 100);
  assert.deepEqual(inspectDefinition.function.parameters.required, ["sources"]);
  assert.equal(inspectDefinition.function.parameters.properties.path, undefined);
  assert.equal(computeDefinition.function.parameters.properties.sourceDecisions.maxItems, 100);
  assert.match(computeDefinition.function.parameters.properties.sourceDecisions.description, /needs_review/);
  assert.match(computeDefinition.function.parameters.properties.sourceDecisions.items.properties.sourceId.description, /不要填写 path/);
  assert.deepEqual(computeDefinition.function.parameters.properties.queries.items.required, ["id"]);
  assert.equal(computeDefinition.function.parameters.properties.queries.items.properties.columns.minItems, 1);
  assert.equal(computeDefinition.function.parameters.properties.queries.items.properties.measures.minItems, 1);
  assert.equal(
    validateDefinition.function.parameters.properties.checks.items.oneOf.some(
      (schema) => schema.properties.type.enum.includes("source_coverage")
    ),
    true
  );
  const numericCompareSchema = validateDefinition.function.parameters.properties.checks.items.oneOf.find(
    (schema) => schema.properties.type.enum.includes("numeric_compare")
  );
  assert.equal(numericCompareSchema.required.includes("left"), true);
  assert.equal(numericCompareSchema.properties.left.oneOf.length, 3);

  const inspected = await tool.execute("spreadsheet_inspect", { path: "uploads/advertising.xlsx" }, { workspace });
  assert.equal(inspected.status, "completed", inspected.content);
  const inspection = JSON.parse(inspected.content);
  assert.equal(inspection.inspectionStatus, "needs_selection");
  assert.equal(inspection.sheets.some((sheet) => sheet.name === "Hidden" && sheet.state === "hidden"), true);
  const campaignTable = findTable(inspection, "CampaignData");
  const partialTable = findTable(inspection, "PartialData");
  const keywordTable = findTable(inspection, "KeywordData");
  const formulaTable = findTable(inspection, "FormulaData");
  const mappingTable = findTable(inspection, "MappingData");
  const ownerTable = findTable(inspection, "OwnerData");
  const nullMappingTable = findTable(inspection, "NullMappingData");
  const totalsTable = findTable(inspection, "TotalsData");
  const emptyRowsTable = findTable(inspection, "EmptyRowsData");
  const zeroMetricsTable = findTable(inspection, "ZeroMetricsData");
  const mergedTable = inspection.tables.find((item) => item.sheet === "Merged");
  assert.ok(mergedTable, "未找到合并表头候选区域");
  assert.equal(mergedTable.structureAmbiguous, true);
  const mergedBlocked = await tool.execute("spreadsheet_compute", {
    analysisId: inspection.analysisId,
    queries: [{ id: "merged-ambiguous", tableId: mergedTable.tableId, columns: [mergedTable.columns[0].name] }]
  }, { workspace });
  assert.equal(mergedBlocked.status, "blocked", mergedBlocked.content);
  assert.equal(mergedBlocked.error.code, "spreadsheet_table_ambiguous");

  const sourcePathAliasComputed = await tool.execute("spreadsheet_compute", {
    analysisId: inspection.analysisId,
    sourceDecisions: [{ sourceId: "uploads/advertising.xlsx", action: "include" }],
    queries: [{
      id: "source-path-alias-preview",
      tableId: campaignTable.tableId,
      columns: ["campaignId"],
      limit: 8
    }]
  }, { workspace });
  assert.equal(sourcePathAliasComputed.status, "completed", sourcePathAliasComputed.content);
  const sourcePathAliasResult = JSON.parse(sourcePathAliasComputed.content).results[0];
  assert.equal(sourcePathAliasResult.preview.length, 8);
  assert.equal(sourcePathAliasResult.lineage.sourceIds.length, 1);
  assert.match(sourcePathAliasResult.lineage.sourceIds[0], /^source-/);

  const multiInspected = await tool.execute("spreadsheet_inspect", {
    sources: [
      { path: "uploads/multi-july.xlsx" },
      { path: "uploads/multi-july-copy.xlsx" },
      { path: "uploads/multi-august.xlsx" },
      { path: "uploads/multi-owner.csv" },
      { path: "uploads/corrupt.xlsx" }
    ]
  }, { workspace });
  assert.equal(multiInspected.status, "completed", multiInspected.content);
  const multiInspection = JSON.parse(multiInspected.content);
  assert.equal(multiInspection.inspectionStatus, "needs_review");
  assert.equal(multiInspection.sources.length, 5);
  assert.equal(multiInspection.failedSources.some((item) => item.path.endsWith("corrupt.xlsx")), true);
  assert.equal(multiInspection.duplicateGroups.some((item) => item.type === "identical_file"), true);
  assert.equal(multiInspection.overlapCandidates.length > 0, true);
  const julySource = multiInspection.sources.find((item) => item.path.endsWith("multi-july.xlsx"));
  const julyCopySource = multiInspection.sources.find((item) => item.path.endsWith("multi-july-copy.xlsx"));
  const augustSource = multiInspection.sources.find((item) => item.path.endsWith("multi-august.xlsx"));
  const ownerSource = multiInspection.sources.find((item) => item.path.endsWith("multi-owner.csv"));
  const corruptSource = multiInspection.sources.find((item) => item.path.endsWith("corrupt.xlsx"));
  const julyTable = multiInspection.tables.find((item) => item.sourceId === julySource.sourceId);
  const augustTable = multiInspection.tables.find((item) => item.sourceId === augustSource.sourceId);
  const multiOwnerTable = multiInspection.tables.find((item) => item.sourceId === ownerSource.sourceId);
  assert.ok(julyTable && augustTable && multiOwnerTable);

  const sourceDecisions = [
    { sourceId: julySource.sourceId, action: "include" },
    { sourceId: augustSource.sourceId, action: "include" },
    { sourceId: ownerSource.sourceId, action: "include" },
    { sourceId: julyCopySource.sourceId, action: "exclude", reasonCode: "exact_duplicate", reason: "与七月报表哈希相同" },
    { sourceId: corruptSource.sourceId, action: "exclude", reasonCode: "corrupt_source", reason: "工作簿损坏，无法读取" }
  ];
  const multiComputed = await tool.execute("spreadsheet_compute", {
    analysisId: multiInspection.analysisId,
    sourceDecisions,
    queries: [{
      id: "multi-source-owner-totals",
      from: {
        type: "union",
        tables: [
          {
            tableId: julyTable.tableId,
            columnMap: { date: "date", campaignId: "campaignId", spend: "spend", sales: "sales" }
          },
          {
            tableId: augustTable.tableId,
            columnMap: { "日期": "date", "广告活动": "campaignId", "花费": "spend", "销售额": "sales" }
          }
        ]
      },
      joins: [{
        tableId: multiOwnerTable.tableId,
        type: "left",
        leftColumns: ["campaignId"],
        rightColumns: ["campaignId"],
        cardinality: "many_to_one",
        prefix: "owner"
      }],
      groupBy: ["owner.owner"],
      measures: [
        { id: "spend", operation: "sum", column: "spend" },
        { id: "sales", operation: "sum", column: "sales" }
      ],
      sort: [{ field: "owner.owner", direction: "asc" }]
    }]
  }, { workspace });
  assert.equal(multiComputed.status, "completed", multiComputed.content);
  const multiCalculation = JSON.parse(multiComputed.content);
  const multiResult = findResult(multiCalculation, "multi-source-owner-totals");
  assert.deepEqual(multiResult.preview, [
    { "owner.owner": "team-1", spend: "30.30", sales: "300" },
    { "owner.owner": "team-2", spend: "20.2", sales: "200" }
  ]);
  assert.equal(multiResult.lineage.sourceIds.length, 3);
  assert.equal(multiResult.lineage.tables.length, 3);

  const multiCoverage = await tool.execute("spreadsheet_validate", {
    analysisId: multiInspection.analysisId,
    resultIds: [multiResult.resultId],
    checks: [{
      id: "all-sources-accounted",
      type: "source_coverage",
      resultIds: [multiResult.resultId],
      requireAllSourcesAccountedFor: true
    }]
  }, { workspace });
  assert.equal(multiCoverage.status, "completed", multiCoverage.content);
  assert.equal(JSON.parse(multiCoverage.content).validationStatus, "passed");

  const unionMismatch = await tool.execute("spreadsheet_compute", {
    analysisId: multiInspection.analysisId,
    queries: [{
      id: "union-schema-mismatch",
      from: {
        type: "union",
        tables: [{ tableId: julyTable.tableId }, { tableId: multiOwnerTable.tableId }]
      },
      measures: [{ id: "rows", operation: "count" }]
    }]
  }, { workspace });
  assert.equal(unionMismatch.status, "blocked");
  assert.equal(unionMismatch.error.code, "spreadsheet_union_schema_mismatch");

  const duplicateSourcePath = await tool.execute("spreadsheet_inspect", {
    sources: [{ path: "uploads/multi-july.xlsx" }, { path: "uploads/multi-july.xlsx" }]
  }, { workspace });
  assert.equal(duplicateSourcePath.status, "blocked");
  assert.equal(duplicateSourcePath.error.code, "spreadsheet_sources_invalid");

  await fs.appendFile(path.join(workspace, "uploads", "multi-owner.csv"), "D,team-3\n", "utf8");
  const multiChanged = await tool.execute("spreadsheet_validate", {
    analysisId: multiInspection.analysisId,
    resultIds: [multiResult.resultId],
    checks: [{ id: "changed-sources", type: "source_coverage" }]
  }, { workspace });
  assert.equal(multiChanged.status, "blocked");
  assert.equal(multiChanged.error.code, "spreadsheet_source_changed");
  assert.equal(formulaTable.formulaColumns.includes("formulaTotal"), true);
  assert.equal(formulaTable.columns.find((column) => column.name === "formulaTotal")?.formulaStatus, "formula_backed");

  const xlsm = await tool.execute("spreadsheet_inspect", { path: "uploads/advertising.xlsm", sheets: ["Campaign"] }, { workspace });
  assert.equal(xlsm.status, "completed", xlsm.content);
  const staleFormula = await tool.execute("spreadsheet_inspect", { path: "uploads/stale-formula.xlsx", sheets: ["Formula"] }, { workspace });
  assert.equal(staleFormula.status, "completed", staleFormula.content);
  assert.equal(JSON.parse(staleFormula.content).tables[0].columns.find((column) => column.name === "formulaTotal")?.formulaStatus, "cached_unverified");
  const tsv = await tool.execute("spreadsheet_inspect", { path: "uploads/simple.tsv" }, { workspace });
  assert.equal(tsv.status, "completed", tsv.content);
  const largeInspect = await tool.execute("spreadsheet_inspect", { path: "uploads/large.csv" }, { workspace });
  assert.equal(largeInspect.status, "completed", largeInspect.content);
  const largeAnalysis = JSON.parse(largeInspect.content);
  const largeTable = largeAnalysis.tables[0];
  const largeUnbounded = await tool.execute("spreadsheet_compute", {
    analysisId: largeAnalysis.analysisId,
    queries: [{ id: "large-unbounded", tableId: largeTable.tableId, columns: ["id", "value"] }]
  }, { workspace });
  assert.equal(largeUnbounded.status, "blocked", largeUnbounded.content);
  assert.equal(largeUnbounded.error.code, "spreadsheet_result_too_large");
  const largeLimited = await tool.execute("spreadsheet_compute", {
    analysisId: largeAnalysis.analysisId,
    queries: [{ id: "large-limited", tableId: largeTable.tableId, columns: ["id", "value"], limit: 10 }]
  }, { workspace });
  assert.equal(largeLimited.status, "completed", largeLimited.content);
  const limitedResult = JSON.parse(largeLimited.content).results[0];
  assert.equal(limitedResult.truncated, true);
  assert.equal(limitedResult.returnedRows, 10);
  const limitedValidation = await tool.execute("spreadsheet_validate", {
    analysisId: largeAnalysis.analysisId,
    resultIds: [limitedResult.resultId],
    checks: [{
      id: "large-completeness",
      type: "column_quality",
      target: { resultId: limitedResult.resultId },
      minimumRows: 100_001,
      columns: [{ name: "id", required: true }]
    }]
  }, { workspace });
  assert.equal(limitedValidation.status, "blocked", limitedValidation.content);
  assert.equal(limitedValidation.error.code, "spreadsheet_result_truncated");
  const corrupt = await tool.execute("spreadsheet_inspect", { path: "uploads/corrupt.xlsx" }, { workspace });
  assert.equal(corrupt.status, "blocked", corrupt.content);
  assert.equal(corrupt.error.code, "spreadsheet_file_invalid");
  const emptyWorkbook = await tool.execute("spreadsheet_inspect", { path: "uploads/empty-workbook.xlsx" }, { workspace });
  assert.equal(emptyWorkbook.status, "blocked", emptyWorkbook.content);
  assert.equal(emptyWorkbook.error.code, "spreadsheet_file_invalid");
  const unsafeArchive = await tool.execute("spreadsheet_inspect", { path: "uploads/unsafe-archive.xlsx" }, { workspace });
  assert.equal(unsafeArchive.status, "blocked", unsafeArchive.content);
  assert.equal(unsafeArchive.error.code, "spreadsheet_archive_unsafe");
  const sparseDimensions = await tool.execute("spreadsheet_inspect", { path: "uploads/sparse-dimensions.xlsx" }, { workspace });
  assert.equal(sparseDimensions.status, "blocked", sparseDimensions.content);
  assert.equal(sparseDimensions.error.code, "spreadsheet_scan_too_large");
  const symlinkEscape = await tool.execute("spreadsheet_inspect", { path: "uploads/linked-outside/outside.csv" }, { workspace });
  assert.equal(symlinkEscape.status, "blocked", symlinkEscape.content);
  assert.equal(symlinkEscape.error.code, "spreadsheet_path_escape");

  const computed = await tool.execute("spreadsheet_compute", {
    analysisId: inspection.analysisId,
    queries: [
      {
        id: "campaign-total",
        tableId: campaignTable.tableId,
        measures: [
          { id: "spend", operation: "sum", column: "spend" },
          { id: "sales", operation: "sum", column: "sales" },
          { id: "clicks", operation: "sum", column: "clicks" },
          { id: "orders", operation: "sum", column: "orders" }
        ],
        derivedMetrics: [{ id: "acos", operation: "divide", left: "spend", right: "sales", zeroPolicy: "not_computable", scale: 6 }]
      },
      { id: "campaign-ids", tableId: campaignTable.tableId, columns: ["campaignId"] },
      { id: "partial-total", tableId: partialTable.tableId, measures: [{ id: "spend", operation: "sum", column: "spend" }] },
      { id: "keyword-values", tableId: keywordTable.tableId, columns: ["keyword"] },
      {
        id: "campaign-by-id",
        tableId: campaignTable.tableId,
        groupBy: ["campaignId"],
        measures: [{ id: "spend", operation: "sum", column: "spend" }],
        sort: [{ field: "campaignId", direction: "asc" }]
      }
    ]
  }, { workspace });
  assert.equal(computed.status, "completed", computed.content);
  const calculation = JSON.parse(computed.content);
  const totalResult = findResult(calculation, "campaign-total");
  const partialResult = findResult(calculation, "partial-total");
  const campaignIds = findResult(calculation, "campaign-ids");
  const keywordValues = findResult(calculation, "keyword-values");
  const campaignById = findResult(calculation, "campaign-by-id");
  assert.equal(totalResult.preview[0].spend, "39541.62");
  assert.equal(totalResult.preview[0].sales, "218490");
  assert.equal(totalResult.preview[0].clicks, "80600");
  assert.equal(totalResult.preview[0].orders, "8464");

  const validation = await tool.execute("spreadsheet_validate", {
    analysisId: inspection.analysisId,
    resultIds: [totalResult.resultId, partialResult.resultId, campaignIds.resultId, keywordValues.resultId],
    checks: [
      {
        id: "spend-reconciliation",
        type: "numeric_compare",
        left: { resultId: totalResult.resultId, rowIndex: 0, field: "spend" },
        operator: "eq",
        right: { resultId: partialResult.resultId, rowIndex: 0, field: "spend" },
        absoluteTolerance: "0.01"
      },
      {
        id: "campaign-reference-integrity",
        type: "set_relation",
        left: { values: ["campaign-9", "campaign-10", "campaign-17"] },
        relation: "subset",
        right: { resultId: campaignIds.resultId, field: "campaignId" }
      },
      {
        id: "budget-feasibility",
        type: "numeric_compare",
        left: { operation: "multiply", operands: [{ value: "2000" }, { value: "0.49" }] },
        operator: "lte",
        right: { operation: "multiply", operands: [{ value: "14" }, { value: "14" }] }
      },
      {
        id: "keyword-shape",
        type: "column_quality",
        target: { resultId: keywordValues.resultId },
        columns: [{ name: "keyword", required: true, notNull: true, forbiddenPattern: "^B0[A-Z0-9]{8}$" }]
      }
    ]
  }, { workspace });
  assert.equal(validation.status, "failed", validation.content);
  const failedValidation = JSON.parse(validation.content);
  assert.equal(failedValidation.validationStatus, "failed");
  assert.equal(failedValidation.counts.requiredFailed, 4);
  const spendCheck = failedValidation.checks.find((check) => check.id === "spend-reconciliation");
  assert.equal(spendCheck.absoluteDifference, "9934.49");
  assert.match(spendCheck.relativeDifference, /^0\.251/);

  const boundedChecks = Array.from({ length: 25 }, (_, index) => ({
    id: `bounded-${index + 1}`,
    type: "numeric_compare",
    left: { value: "1" },
    operator: "eq",
    right: { value: index === 24 ? "2" : "1" }
  }));
  const boundedValidation = await tool.execute("spreadsheet_validate", {
    analysisId: inspection.analysisId,
    resultIds: [totalResult.resultId],
    checks: boundedChecks
  }, { workspace });
  assert.equal(boundedValidation.status, "failed", boundedValidation.content);
  const boundedSummary = JSON.parse(boundedValidation.content);
  assert.equal(boundedSummary.counts.total, 25);
  assert.equal(boundedSummary.checks.length, 20);
  assert.equal(boundedSummary.checks[0].id, "bounded-25");
  assert.equal(boundedSummary.checksTruncated, true);
  const boundedReport = JSON.parse(await fs.readFile(path.join(workspace, ...boundedSummary.reportPath.split("/")), "utf8"));
  assert.equal(boundedReport.checks.length, 25);
  assert.equal(boundedReport.checks.at(-1).id, "bounded-25");

  const passed = await tool.execute("spreadsheet_validate", {
    analysisId: inspection.analysisId,
    resultIds: [totalResult.resultId],
    checks: [{
      id: "authoritative-spend",
      type: "numeric_compare",
      left: { resultId: totalResult.resultId, field: "spend" },
      operator: "eq",
      right: { value: "39541.62" },
      absoluteTolerance: "0.01"
    }]
  }, { workspace });
  assert.equal(passed.status, "completed", passed.content);
  assert.equal(JSON.parse(passed.content).validationStatus, "passed");

  const formulaBlocked = await tool.execute("spreadsheet_compute", {
    analysisId: inspection.analysisId,
    queries: [{ id: "formula-cache", tableId: formulaTable.tableId, measures: [{ id: "total", operation: "sum", column: "formulaTotal" }] }]
  }, { workspace });
  assert.equal(formulaBlocked.status, "blocked", formulaBlocked.content);
  assert.equal(formulaBlocked.error.code, "spreadsheet_formula_not_authoritative");

  const emptyInvalidMeasure = await tool.execute("spreadsheet_compute", {
    analysisId: inspection.analysisId,
    queries: [{
      id: "empty-invalid-measure",
      tableId: campaignTable.tableId,
      filters: [{ column: "campaignId", operator: "eq", value: "missing" }],
      groupBy: ["campaignId"],
      measures: [{ id: "spend", operation: "median", column: "spend" }]
    }]
  }, { workspace });
  assert.equal(emptyInvalidMeasure.status, "blocked", emptyInvalidMeasure.content);
  assert.equal(emptyInvalidMeasure.error.code, "spreadsheet_measure_invalid");

  const emptyInvalidDerived = await tool.execute("spreadsheet_compute", {
    analysisId: inspection.analysisId,
    queries: [{
      id: "empty-invalid-derived",
      tableId: campaignTable.tableId,
      filters: [{ column: "campaignId", operator: "eq", value: "missing" }],
      groupBy: ["campaignId"],
      measures: [{ id: "spend", operation: "sum", column: "spend" }],
      derivedMetrics: [{ id: "ratio", operation: "divide", left: "spend", right: "missingMetric" }]
    }]
  }, { workspace });
  assert.equal(emptyInvalidDerived.status, "blocked", emptyInvalidDerived.content);
  assert.equal(emptyInvalidDerived.error.code, "spreadsheet_derived_invalid");

  const badJoin = await tool.execute("spreadsheet_compute", {
    analysisId: inspection.analysisId,
    queries: [{
      id: "duplicating-join",
      tableId: campaignTable.tableId,
      joins: [{ tableId: mappingTable.tableId, leftColumns: ["campaignId"], rightColumns: ["campaignId"], cardinality: "many_to_one" }],
      columns: ["campaignId"]
    }]
  }, { workspace });
  assert.equal(badJoin.status, "failed", badJoin.content);
  assert.equal(badJoin.error.code, "spreadsheet_join_cardinality_failed");

  const validJoin = await tool.execute("spreadsheet_compute", {
    analysisId: inspection.analysisId,
    queries: [{
      id: "owner-join",
      tableId: campaignTable.tableId,
      joins: [{
        tableId: ownerTable.tableId,
        leftColumns: ["campaignId"],
        rightColumns: ["campaignId"],
        cardinality: "many_to_one",
        prefix: "owner"
      }],
      columns: ["campaignId", "owner.owner"]
    }]
  }, { workspace });
  assert.equal(validJoin.status, "completed", validJoin.content);
  const validJoinResult = JSON.parse(validJoin.content).results[0];
  assert.equal(validJoinResult.rowCount, 8);
  assert.deepEqual(validJoinResult.preview.slice(0, 3), [
    { campaignId: "campaign-1", "owner.owner": "Alice" },
    { campaignId: "campaign-2", "owner.owner": "Bob" },
    { campaignId: "campaign-3", "owner.owner": null }
  ]);
  assert.equal(validJoinResult.lineage.tables.length, 2);
  assert.equal(validJoinResult.lineage.filteredRowCount, 8);

  const coverage = await tool.execute("spreadsheet_validate", {
    analysisId: inspection.analysisId,
    resultIds: [validJoinResult.resultId],
    checks: [{
      id: "owner-coverage",
      type: "column_quality",
      target: { resultId: validJoinResult.resultId },
      columns: [{ name: "owner.owner", minCoverage: 0.5 }]
    }]
  }, { workspace });
  assert.equal(coverage.status, "failed", coverage.content);
  assert.equal(JSON.parse(coverage.content).checks[0].violations[0].rule, "minCoverage");

  const joinedFormulaBlocked = await tool.execute("spreadsheet_compute", {
    analysisId: inspection.analysisId,
    queries: [{
      id: "joined-formula",
      tableId: campaignTable.tableId,
      joins: [{
        tableId: ownerTable.tableId,
        leftColumns: ["campaignId"],
        rightColumns: ["campaignId"],
        cardinality: "many_to_one",
        prefix: "owner"
      }],
      columns: ["campaignId", "owner.formulaScore"]
    }]
  }, { workspace });
  assert.equal(joinedFormulaBlocked.status, "blocked", joinedFormulaBlocked.content);
  assert.equal(joinedFormulaBlocked.error.code, "spreadsheet_formula_not_authoritative");

  const formulaJoinKeyBlocked = await tool.execute("spreadsheet_compute", {
    analysisId: inspection.analysisId,
    queries: [{
      id: "formula-join-key",
      tableId: campaignTable.tableId,
      joins: [
        {
          tableId: ownerTable.tableId,
          leftColumns: ["campaignId"],
          rightColumns: ["campaignId"],
          cardinality: "many_to_one",
          prefix: "owner"
        },
        {
          tableId: mappingTable.tableId,
          leftColumns: ["owner.formulaScore"],
          rightColumns: ["campaignId"],
          cardinality: "many_to_one",
          prefix: "mapping"
        }
      ],
      columns: ["campaignId"]
    }]
  }, { workspace });
  assert.equal(formulaJoinKeyBlocked.status, "blocked", formulaJoinKeyBlocked.content);
  assert.equal(formulaJoinKeyBlocked.error.code, "spreadsheet_formula_not_authoritative");

  const nullJoinBlocked = await tool.execute("spreadsheet_compute", {
    analysisId: inspection.analysisId,
    queries: [{
      id: "null-join",
      tableId: campaignTable.tableId,
      joins: [{
        tableId: nullMappingTable.tableId,
        leftColumns: ["campaignId"],
        rightColumns: ["campaignId"],
        cardinality: "many_to_one"
      }],
      columns: ["campaignId"]
    }]
  }, { workspace });
  assert.equal(nullJoinBlocked.status, "failed", nullJoinBlocked.content);
  assert.equal(nullJoinBlocked.error.code, "spreadsheet_join_key_null");

  const invalidSort = await tool.execute("spreadsheet_compute", {
    analysisId: inspection.analysisId,
    queries: [{
      id: "invalid-sort",
      tableId: campaignTable.tableId,
      columns: ["campaignId"],
      sort: [{ field: "missingField" }]
    }]
  }, { workspace });
  assert.equal(invalidSort.status, "blocked", invalidSort.content);
  assert.equal(invalidSort.error.code, "spreadsheet_column_not_found");

  assert.equal(totalsTable.summaryRows[0].label, "Total");
  const totalsAmbiguous = await tool.execute("spreadsheet_compute", {
    analysisId: inspection.analysisId,
    queries: [{
      id: "totals-ambiguous",
      tableId: totalsTable.tableId,
      measures: [{ id: "spend", operation: "sum", column: "spend" }]
    }]
  }, { workspace });
  assert.equal(totalsAmbiguous.status, "blocked", totalsAmbiguous.content);
  assert.equal(totalsAmbiguous.error.code, "spreadsheet_summary_rows_ambiguous");
  const totalsExcluded = await tool.execute("spreadsheet_compute", {
    analysisId: inspection.analysisId,
    queries: [{
      id: "totals-excluded",
      tableId: totalsTable.tableId,
      summaryRowPolicy: "exclude",
      measures: [{ id: "spend", operation: "sum", column: "spend" }]
    }]
  }, { workspace });
  assert.equal(JSON.parse(totalsExcluded.content).results[0].preview[0].spend, "30");

  const emptyRowFailed = await tool.execute("spreadsheet_compute", {
    analysisId: inspection.analysisId,
    queries: [{
      id: "empty-row",
      tableId: emptyRowsTable.tableId,
      measures: [{ id: "spend", operation: "sum", column: "spend" }]
    }]
  }, { workspace });
  assert.equal(emptyRowFailed.status, "failed", emptyRowFailed.content);
  assert.equal(emptyRowFailed.error.code, "spreadsheet_null_value");

  const zeroDenominator = await tool.execute("spreadsheet_compute", {
    analysisId: inspection.analysisId,
    queries: [{
      id: "zero-denominator",
      tableId: zeroMetricsTable.tableId,
      measures: [
        { id: "spend", operation: "sum", column: "spend" },
        { id: "sales", operation: "sum", column: "sales" }
      ],
      derivedMetrics: [{ id: "acos", operation: "divide", left: "spend", right: "sales" }]
    }]
  }, { workspace });
  assert.equal(zeroDenominator.status, "completed", zeroDenominator.content);
  const zeroResult = JSON.parse(zeroDenominator.content).results[0];
  assert.equal(zeroResult.preview[0].acos, null);
  assert.equal(zeroResult.notComputable[0].reason, "zero_denominator");
  assert.equal(zeroResult.notComputableCount, 1);
  assert.equal(zeroResult.notComputableTruncated, false);

  const manyZeroInspect = await tool.execute("spreadsheet_inspect", { path: "uploads/many-zero-denominators.csv" }, { workspace });
  const manyZeroAnalysis = JSON.parse(manyZeroInspect.content);
  const manyZeroComputed = await tool.execute("spreadsheet_compute", {
    analysisId: manyZeroAnalysis.analysisId,
    queries: [{
      id: "many-zero-denominators",
      tableId: manyZeroAnalysis.tables[0].tableId,
      groupBy: ["id"],
      measures: [
        { id: "spend", operation: "sum", column: "spend" },
        { id: "sales", operation: "sum", column: "sales" }
      ],
      derivedMetrics: [{ id: "acos", operation: "divide", left: "spend", right: "sales" }]
    }]
  }, { workspace });
  assert.equal(manyZeroComputed.status, "completed", manyZeroComputed.content);
  const manyZeroResult = JSON.parse(manyZeroComputed.content).results[0];
  assert.equal(manyZeroResult.notComputableCount, 150);
  assert.equal(manyZeroResult.notComputable.length, 5);
  assert.equal(manyZeroResult.notComputableTruncated, true);
  assert.equal(manyZeroResult.notComputableSamplesTruncated, true);
  const manyZeroManifestPath = path.join(workspace, ...manyZeroResult.manifestPath.split("/"));
  const manyZeroManifest = JSON.parse(await fs.readFile(manyZeroManifestPath, "utf8"));
  const manyZeroDataPath = path.resolve(path.dirname(manyZeroManifestPath), "..", manyZeroManifest.dataFile);
  const manyZeroData = JSON.parse(await fs.readFile(manyZeroDataPath, "utf8"));
  assert.equal(manyZeroData.notComputable.length, 100);
  assert.equal(manyZeroData.notComputableCount, 150);

  const ambiguousInspect = await tool.execute("spreadsheet_inspect", { path: "uploads/ambiguous.csv" }, { workspace });
  const ambiguousAnalysis = JSON.parse(ambiguousInspect.content);
  const ambiguousTable = ambiguousAnalysis.tables[0];
  const ambiguousFailed = await tool.execute("spreadsheet_compute", {
    analysisId: ambiguousAnalysis.analysisId,
    queries: [{ id: "ambiguous-sum", tableId: ambiguousTable.tableId, measures: [{ id: "spend", operation: "sum", column: "spend" }] }]
  }, { workspace });
  assert.equal(ambiguousFailed.status, "failed", ambiguousFailed.content);
  assert.equal(ambiguousFailed.error.code, "spreadsheet_numeric_format_ambiguous");
  const conflictingSeparators = await tool.execute("spreadsheet_compute", {
    analysisId: ambiguousAnalysis.analysisId,
    queries: [{
      id: "conflicting-separators",
      tableId: ambiguousTable.tableId,
      columnParsers: [{ column: "spend", type: "decimal", decimalSeparator: ",", thousandsSeparator: "," }],
      measures: [{ id: "spend", operation: "sum", column: "spend" }]
    }]
  }, { workspace });
  assert.equal(conflictingSeparators.status, "blocked", conflictingSeparators.content);
  assert.equal(conflictingSeparators.error.code, "spreadsheet_parser_invalid");
  const ambiguousParsed = await tool.execute("spreadsheet_compute", {
    analysisId: ambiguousAnalysis.analysisId,
    queries: [{
      id: "parsed-sum",
      tableId: ambiguousTable.tableId,
      columnParsers: [{ column: "spend", type: "decimal", decimalSeparator: ".", thousandsSeparator: "," }],
      measures: [{ id: "spend", operation: "sum", column: "spend" }]
    }]
  }, { workspace });
  assert.equal(JSON.parse(ambiguousParsed.content).results[0].preview[0].spend, "1234.56");

  const unusedParser = await tool.execute("spreadsheet_compute", {
    analysisId: ambiguousAnalysis.analysisId,
    queries: [{
      id: "unused-parser",
      tableId: ambiguousTable.tableId,
      columnParsers: [{ tableId: campaignTable.tableId, column: "spend", type: "decimal" }],
      columns: ["id"]
    }]
  }, { workspace });
  assert.equal(unusedParser.status, "blocked", unusedParser.content);
  assert.equal(unusedParser.error.code, "spreadsheet_parser_invalid");

  const numericOrderInspect = await tool.execute("spreadsheet_inspect", { path: "uploads/numeric-order.csv" }, { workspace });
  const numericOrderAnalysis = JSON.parse(numericOrderInspect.content);
  const numericOrder = await tool.execute("spreadsheet_compute", {
    analysisId: numericOrderAnalysis.analysisId,
    queries: [{
      id: "numeric-order",
      tableId: numericOrderAnalysis.tables[0].tableId,
      measures: [
        { id: "minimum", operation: "min", column: "value" },
        { id: "maximum", operation: "max", column: "value" }
      ]
    }]
  }, { workspace });
  const numericOrderResult = JSON.parse(numericOrder.content).results[0];
  assert.deepEqual(numericOrderResult.preview[0], { minimum: "2", maximum: "10" });

  const chart = await tool.execute("visualization_create_chart", {
    title: "Campaign 花费",
    dataRef: campaignById.dataRef,
    spec: {
      mark: "bar",
      encoding: {
        x: { field: "campaignId", type: "nominal" },
        y: { field: "spend", type: "quantitative" }
      }
    }
  }, { workspace });
  assert.equal(chart.status, "completed", chart.content);
  assert.equal(chart.artifacts[0].lineage[0].resultId, campaignById.resultId);

  const dashboard = await tool.execute("visualization_create_dashboard", {
    title: "可信广告看板",
    kpis: [{ label: "总花费", valueRef: { ...totalResult.dataRef, field: "spend", rowIndex: 0 }, tone: "neutral" }],
    panels: [
      {
        id: "campaign-spend",
        kind: "chart",
        title: "Campaign 花费",
        dataRef: campaignById.dataRef,
        spec: {
          mark: "bar",
          encoding: {
            x: { field: "campaignId", type: "nominal" },
            y: { field: "spend", type: "quantitative" }
          }
        }
      },
      { id: "campaign-table", kind: "table", title: "Campaign 明细", dataRef: campaignById.dataRef }
    ]
  }, { workspace });
  assert.equal(dashboard.status, "completed", dashboard.content);
  assert.equal(dashboard.artifacts[0].data.kpis[0].value, "39541.62");
  assert.equal(dashboard.artifacts[0].lineage.length, 2);

  const changedInspect = await tool.execute("spreadsheet_inspect", { path: "uploads/simple.tsv" }, { workspace });
  const changedAnalysis = JSON.parse(changedInspect.content);
  const simpleComputed = await tool.execute("spreadsheet_compute", {
    analysisId: changedAnalysis.analysisId,
    queries: [{
      id: "simple-total",
      tableId: changedAnalysis.tables[0].tableId,
      measures: [{ id: "value", operation: "sum", column: "value" }]
    }]
  }, { workspace });
  const simpleResult = JSON.parse(simpleComputed.content).results[0];
  const mixedAnalysisDashboard = await tool.execute("visualization_create_dashboard", {
    title: "混合分析看板",
    kpis: [{ label: "总花费", valueRef: { ...totalResult.dataRef, field: "spend" } }],
    panels: [{
      id: "different-analysis",
      kind: "table",
      title: "其他分析",
      dataRef: simpleResult.dataRef
    }]
  }, { workspace });
  assert.equal(mixedAnalysisDashboard.status, "failed", mixedAnalysisDashboard.content);
  assert.match(mixedAnalysisDashboard.content, /不能混用多个 analysisId/);

  await fs.appendFile(path.join(workspace, "uploads", "simple.tsv"), "c\t3\n", "utf8");
  const changed = await tool.execute("spreadsheet_compute", {
    analysisId: changedAnalysis.analysisId,
    queries: [{ id: "changed", tableId: changedAnalysis.tables[0].tableId, measures: [{ id: "value", operation: "sum", column: "value" }] }]
  }, { workspace });
  assert.equal(changed.status, "blocked", changed.content);
  assert.equal(changed.error.code, "spreadsheet_source_changed");

  const resultManifestPath = path.join(workspace, ...campaignById.manifestPath.split("/"));
  const resultManifest = JSON.parse(await fs.readFile(resultManifestPath, "utf8"));
  const resultDataPath = path.resolve(path.dirname(resultManifestPath), "..", resultManifest.dataFile);
  await fs.appendFile(resultDataPath, " ", "utf8");
  const tamperedChart = await tool.execute("visualization_create_chart", {
    title: "已篡改结果",
    dataRef: campaignById.dataRef,
    spec: {
      mark: "bar",
      encoding: {
        x: { field: "campaignId", type: "nominal" },
        y: { field: "spend", type: "quantitative" }
      }
    }
  }, { workspace });
  assert.equal(tamperedChart.status, "failed", tamperedChart.content);
  assert.equal(tamperedChart.error.code, "spreadsheet_result_hash_mismatch");

  const escaped = await tool.execute("spreadsheet_inspect", { path: path.join(workspace, "..", "outside.xlsx") }, { workspace });
  assert.equal(escaped.status, "blocked");

  console.log("[smoke-spreadsheets] ok", workspace);
} finally {
  await defaultTool.dispose();
  await tool.dispose();
  await fs.rm(workspace, { recursive: true, force: true });
  await fs.rm(externalRoot, { recursive: true, force: true });
}

function findTable(inspection, declaredName) {
  const table = inspection.tables.find((item) => item.declaredName === declaredName);
  assert.ok(table, `未找到表格 ${declaredName}`);
  return table;
}

function findResult(calculation, queryId) {
  const result = calculation.results.find((item) => item.queryId === queryId);
  assert.ok(result, `未找到结果 ${queryId}`);
  return result;
}
