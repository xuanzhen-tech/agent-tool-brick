# 表格计算与数据闭环

本文说明产品如何组合 AgentTool 的确定性表格能力，以及 Agent 在正式数据报告中必须遵守的边界。

## 产品接入

产品只负责注入 workspace、Python runtime 和工具白名单，不负责解析表格、计算公式或做对账：

```js
const agentTool = new AgentTool({
  workspace,
  runtimeDependencies,
  tools: [
    "spreadsheet_inspect",
    "spreadsheet_compute",
    "spreadsheet_validate",
    "visualization_create_chart",
    "visualization_create_dashboard"
  ]
});
```

`runtimeDependencies` 中的 `python-runtime` 需要包含 `openpyxl`。这三个工具默认隐藏；未被产品选择或未注入 Python runtime 时，不会进入模型 schema。

## 标准链路

1. `spreadsheet_inspect` 读取 workspace 内一个或多个 XLSX、XLSM、CSV 或 TSV，返回来源集合快照、`analysisId` 和候选 `tableId`。
2. Agent 明确选择 `tableId` 后调用 `spreadsheet_compute`。筛选、联接、聚合和派生指标都使用受控声明，不能提交 Python、SQL 或 Excel 公式。
3. `spreadsheet_compute` 返回 `resultId` 和 `agent-spreadsheet.data-ref.v1`。完整 JSON、CSV、查询合同与字段血缘保存在 `temp/spreadsheets/<analysisId>/`。
4. 正式交付前调用 `spreadsheet_validate`，检查字段覆盖、唯一性、金额恒等式、预算可行性和集合关系。
5. 图表、表格和 KPI 通过 `dataRef`、`valueRef` 或 `changeRef` 读取相同分析下的 canonical result，不重新复制或心算数字。

源文件在 inspect 后发生变化时，旧 `analysisId` 会失效。公式列只会标记为 `formula_backed` 或 `cached_unverified`，不能作为正式金额输入；应从基础字段重新计算。

## 解压与多文件分析

ZIP 不属于表格工具输入。Agent 先使用 `run_shell` 将用户上传的压缩包解压到本次任务的 `temp/` 目录，列出实际表格文件，再一次提交给检查工具：

```js
await agentTool.execute("spreadsheet_inspect", {
  sources: [
    { path: "temp/advertising/raw/campaign.xlsx", sheets: ["Campaign"] },
    { path: "temp/advertising/raw/search-term.xlsx" },
    { path: "temp/advertising/raw/product.csv" }
  ]
}, { workspace });
```

模型工具合同统一使用 `sources`，单文件也传一个元素，避免模型同时填写互斥字段。直接 SDK/HTTP 调用继续兼容旧 `{ path, sheets }`。多来源共享同一个 `analysisId`；每个文件具有独立 `sourceId`、哈希、检查状态和表格清单。检查结果会报告损坏来源、完全重复文件、相同内容表格和日期重叠候选。只要仍有可用表格，普通坏文件会形成 `needs_review`，不会被静默忽略；路径逃逸等安全问题仍阻断整次调用。

同类表格使用显式 union：

```js
await agentTool.execute("spreadsheet_compute", {
  analysisId,
  sourceDecisions: [
    { sourceId: "source-a", action: "include" },
    {
      sourceId: "source-copy",
      action: "exclude",
      reasonCode: "exact_duplicate",
      reason: "与 source-a 的文件哈希相同"
    }
  ],
  queries: [{
    id: "all-campaigns",
    from: {
      type: "union",
      tables: [
        {
          tableId: "table-cn",
          columnMap: { "广告活动": "campaignId", "花费": "spend" }
        },
        {
          tableId: "table-en",
          columnMap: { "Campaign": "campaignId", "Spend": "spend" }
        }
      ]
    },
    groupBy: ["campaignId"],
    measures: [{ id: "spend", operation: "sum", column: "spend" }]
  }]
}, { workspace });
```

union 不自动猜字段、不自动补空列、不自动去重。提供 `columnMap` 时只保留映射字段；各表映射后的字段和类型必须一致。不同粒度表继续使用 `joins`，并必须声明联接基数。联接右表的非键字段统一命名为 `<prefix>.<column>`；例如 `prefix: "owners"` 后，分组字段应写 `owners.owner`。

正式交付增加来源覆盖检查：

```js
{
  id: "source-coverage",
  type: "source_coverage",
  resultIds: [resultId],
  requireAllSourcesAccountedFor: true
}
```

它确认所有来源均已被结果使用或显式排除，并检查损坏来源、重复表和日期重叠是否仍未解决。校验按当前交付使用的 `resultIds` 计算；与当前结论无关的数据问题不必阻断其他结果，但覆盖范围必须写清。

`numeric_compare` 的两侧只能是常量、结果单元格或一层安全算术表达式。例如：

```js
await agentTool.execute("spreadsheet_validate", {
  analysisId,
  resultIds: [totalsResultId],
  checks: [{
    id: "net-income-identity",
    type: "numeric_compare",
    operator: "eq",
    absoluteTolerance: "0.01",
    left: { resultId: totalsResultId, field: "netIncome", rowIndex: 0 },
    right: {
      operation: "subtract",
      operands: [
        { resultId: totalsResultId, field: "revenue", rowIndex: 0 },
        { resultId: totalsResultId, field: "refund", rowIndex: 0 }
      ]
    }
  }]
}, { workspace });
```

`checks` 直接或在 `operands` 内引用的每个 `resultId` 都必须出现在顶层 `resultIds` 白名单中。复杂派生指标应优先由 `spreadsheet_compute.derivedMetrics` 生成，再在校验中引用结果单元格，避免重复表达同一公式。

## 结果状态

- `spreadsheet_inspect` 返回 `ready`、`needs_selection` 或 `needs_review`；没有可计算区域时返回 `blocked`。
- `spreadsheet_compute` 成功后返回摘要、预览、`resultId` 和 `dataRef`。完整结果不会直接塞入模型上下文。
- 小型结果在不超过 60 个单元格的预算内最多预览 10 行，避免四到十个分组被无故切断；更大结果继续通过 canonical JSON/CSV 引用使用。
- 派生指标出现大量不可计算行时，模型结果只返回准确总数和有限样本；canonical result 中仍保留结果行与更完整的诊断样本。
- 未显式限制的行结果超过 10 万行时会阻断，要求先筛选或聚合；显式 `limit` 形成的受限结果可以用于预览或 Top N 图表，但不能作为完整质量门证据。
- `spreadsheet_validate` 返回 `passed`、`passed_with_warnings` 或 `failed`。配置或数据前置条件不足时，工具顶层返回 `blocked`。
- 校验项很多时，Tool Result 优先返回失败项并设置 `checksTruncated`；全部检查和证据以 `reportPath` 指向的 JSON 为准。
- 任一必需检查失败时，Agent 只能交付差异说明、可用范围和补数清单，不能继续输出正式经营策略。

## 可视化引用

图表的 `data` 与 `dataRef` 互斥：

```js
await agentTool.execute("visualization_create_chart", {
  title: "Campaign 花费",
  dataRef: {
    schemaVersion: "agent-spreadsheet.data-ref.v1",
    analysisId,
    resultId
  },
  spec: {
    mark: "bar",
    encoding: {
      x: { field: "campaignId", type: "nominal" },
      y: { field: "spend", type: "quantitative" }
    }
  }
}, { workspace });
```

看板的 chart/table 面板支持 `dataRef`，KPI 支持 `valueRef` 和 `changeRef`。同一看板不能混用多个 `analysisId`；每个 manifest 都会记录来源 result 和数据哈希。

## 数据与目录边界

- `uploads/` 中的输入只读。
- 分析 manifest、JSON、CSV 和校验报告只写入 `temp/spreadsheets/`。
- 正式图表和 BI 看板只写入 `outputs/visualizations/`。
- 路径逃逸、符号链接逃逸、工作簿内部异常压缩体积和来源哈希变化会被拒绝；通用 ZIP 解压仍由 `run_shell` 负责。
- 单次多来源检查最多 100 个文件、总大小最多 1GB；单个文件继续使用既有 100MB 安全上限。
- 金额与比率使用 `Decimal`；原始精度保存在结果中，展示舍入由派生指标显式声明。
- 分母为零、缺失字段和无法解析的数字返回不可计算或失败，不会静默补零。

## 本地验证

```powershell
$env:AGENT_TOOL_PYTHON_BIN="C:\path\to\python.exe"
npm run smoke:spreadsheets
npm run smoke:agent-cli-spreadsheet-integration
```

该 smoke 会创建真实 XLSX/XLSM/CSV/TSV，覆盖金额差异、集合越界、预算不成立、ASIN 误作关键词、公式列、联接基数、来源变化，以及 dataRef 图表和看板。

需要人工验证真实模型时运行 `npm run smoke:agent-cli-spreadsheet-real`。该脚本会连接当前
Gateway 并产生真实模型用量，不纳入自动发布流水线。

需要比较同一真实模型的 `run_shell` 与专属工具路线时，运行：

```powershell
npm run eval:spreadsheets:ab -- --all --model=gpt-5.6-sol
```

评测会生成不同难度的真实工作簿，记录准确率、模型请求数、输入 token、messages 字符量、Tool Result 字符量和耗时；结果保存在被 Git 忽略的 `evals/spreadsheets/results/`。
