# 表格 Agent A/B 基线

基线日期：2026-09-04
候选版本：`@xuanzhen-tech/agent-tool-brick@0.17.0`

## 最终全量结果

使用同一个真实模型 `gpt-5.6-sol`，对 6 类真实生成的 XLSX 场景分别运行 `run_shell` 和专属表格工具，共 12 次 Agent turn：

| 路线 | 通过率 | 平均得分 | 平均输入 token | 平均 messages 字符 | 平均 Tool Result 字符 | 平均耗时 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `run_shell` | 100% | 100 | 14,363 | 37,690 | 15,071 | 19.7s |
| 表格工具 | 100% | 100 | 20,672 | 31,472 | 8,069 | 27.8s |

表格工具路线的 6 个案例都使用了 `spreadsheet_inspect`、`spreadsheet_compute`、`spreadsheet_validate`，没有回退 `run_shell`。相较 shell 路线：

- Tool Result 字符量减少约 46.5%。
- messages 字符量减少约 16.5%。
- 输入 token 增加约 43.9%，主要来自三个声明式工具 schema 在每次模型请求中重复携带。
- 耗时增加约 41.0%，换取 Decimal 计算、来源血缘、联接基数检查和正式质量门。

这组结果不能证明专属工具在每个简单任务上更快或更省 token；它证明当前合同能稳定完成复杂表格任务，并将计算、来源和校验证据持久化为可审计结果。

原始报告位于本地忽略目录：

```text
evals/spreadsheets/results/2026-09-04T09-13-27-491Z/report.json
```

## DeepSeek 合同回归

使用 `deepseek-v4-flash` 验证较弱模型对 schema 的使用：

- 多文件异构合并：100 分，5 次模型请求，4 次工具调用，无工具失败。
- 本地化数字：100 分，4 次模型请求，严格完成 `inspect → compute → validate`，无工具失败，耗时约 9.7 秒。

评测直接促成了以下修复：

- 模型可见 `spreadsheet_inspect` 只保留 `sources`，避免同时填写旧 `path` 与新 `sources`。
- 单来源误把 path 写入 `sourceId` 时安全归一化，持久化仍使用规范 source ID。
- 联接字段明确使用 `<prefix>.<column>`。
- 四类 validate check 拆成互斥 schema，数值表达式形态不再靠模型猜测。
- `columns`、`measures`、`derivedMetrics` 禁止空数组，并说明派生指标只作用于聚合结果。
- 小型结果最多返回 10 行且总计不超过 60 个预览单元格，避免四个分组只返回前三个。

## 复现

```powershell
npm run eval:spreadsheets:ab -- --all --model=gpt-5.6-sol
```

评测会产生真实模型调用。报告目录被 Git 和 npm package 排除，合成工作簿由脚本临时生成并在运行结束后清理。
