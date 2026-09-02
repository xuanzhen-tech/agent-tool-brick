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

1. `spreadsheet_inspect` 读取 workspace 内的 XLSX、XLSM、CSV 或 TSV，返回源文件 SHA-256、`analysisId` 和候选 `tableId`。
2. Agent 明确选择 `tableId` 后调用 `spreadsheet_compute`。筛选、联接、聚合和派生指标都使用受控声明，不能提交 Python、SQL 或 Excel 公式。
3. `spreadsheet_compute` 返回 `resultId` 和 `agent-spreadsheet.data-ref.v1`。完整 JSON、CSV、查询合同与字段血缘保存在 `temp/spreadsheets/<analysisId>/`。
4. 正式交付前调用 `spreadsheet_validate`，检查字段覆盖、唯一性、金额恒等式、预算可行性和集合关系。
5. 图表、表格和 KPI 通过 `dataRef`、`valueRef` 或 `changeRef` 读取相同分析下的 canonical result，不重新复制或心算数字。

源文件在 inspect 后发生变化时，旧 `analysisId` 会失效。公式列只会标记为 `formula_backed` 或 `cached_unverified`，不能作为正式金额输入；应从基础字段重新计算。

## 结果状态

- `spreadsheet_inspect` 返回 `ready` 或 `needs_selection`；没有可计算区域时返回 `blocked`。
- `spreadsheet_compute` 成功后返回摘要、预览、`resultId` 和 `dataRef`。完整结果不会直接塞入模型上下文。
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
- 路径逃逸、符号链接逃逸、损坏工作簿、异常解压体积和来源哈希变化会被拒绝。
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
