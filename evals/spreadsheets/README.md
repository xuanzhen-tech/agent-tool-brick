# 表格 Agent A/B 评测集

该评测集比较同一个模型在两条路径下处理同一批工作簿的表现：

- `shell`：只向模型暴露 `run_shell`，由模型自行编写 Python/PowerShell 脚本读取和计算。
- `spreadsheet`：只暴露 `spreadsheet_inspect`、`spreadsheet_compute`、`spreadsheet_validate`，禁止回退 `run_shell`。

评测不是为了证明专属工具必然更好，而是回答三个可验证问题：

1. 数字、来源覆盖和对账结论是否更准确；
2. 工具结果和后续模型上下文是否更小、更稳定；
3. 模型是否真正采用专属工具，还是因合同不清晰而放弃使用。

## 数据集

`scripts/create-spreadsheet-eval-fixtures.py` 每次生成全新的合成工作簿，不提交二进制文件：

| Case | 难度 | 主要风险 |
| --- | --- | --- |
| `clean-single-table` | 简单 | 单表金额聚合、净额计算 |
| `multi-sheet-reconciliation` | 中等 | 明细与汇总不一致、公式缓存不可作为真值 |
| `multi-file-localized-union` | 困难 | 多文件、中文字段映射、重复文件、损坏文件、跨文件联接 |
| `join-cardinality-trap` | 困难 | 映射表键重复导致金额被联接放大 |
| `localized-number-format` | 中等 | `1.234,56` 等本地化数字需要显式解析 |
| `large-workbook-aggregation` | 压力 | 40,000 行 XLSX 聚合及上下文控制 |

所有答案都由 fixture manifest 提供确定性断言，不使用另一个模型主观评分。

## 运行

运行三个代表性 case：

```powershell
npm run eval:spreadsheets:ab -- --cases=clean-single-table,multi-file-localized-union,join-cardinality-trap
```

运行完整集合或指定模型：

```powershell
npm run eval:spreadsheets:ab -- --all --model=gpt-5.6-sol
```

常用参数：

- `--arm=shell|spreadsheet|both`，默认 `both`。
- `--repetitions=2`，同一 case 重复次数，默认 1。
- `--timeout-ms=600000`，单次 Agent turn 上限。
- `--model=<id>`，默认读取 `AGENT_TOOL_SPREADSHEET_EVAL_MODEL`，否则使用 `gpt-5.6-sol`。

结果写入被 Git 忽略的 `evals/spreadsheets/results/<timestamp>/report.json`。

当前版本的人工确认基线见 [BASELINE.md](./BASELINE.md)。

## 指标口径

- `score`：fixture 中数值和结论断言的确定性得分；工具路线合规占 10 分。
- `promptTokensTotal`：该任务所有 LLM 请求实际消耗的输入 token 之和。
- `promptTokensMax`：单次请求的最大输入 token，可观察上下文峰值。
- `messageCharsTotal` / `toolSchemaCharsTotal`：CLI 发送给 Gateway 的 messages 和 tools schema 字符量。
- `toolResultCharsTotal`：AgentCli 对外 `tool_end.result` 的累计字符量。
- `toolCalls`、`modelRequests`、`durationMs`：调用复杂度和耗时。

比较时应同时看准确率与上下文成本。专属工具如果得分没有提高、频繁失败或模型回退 shell，就不能仅凭工具已实现宣称优化成立。
