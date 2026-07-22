# Tool Provider 对接合同

`AgentTool` 是模型工具面的唯一聚合者。图表、看板、演示文稿等复杂能力不需要
进入 `AgentCli`，而是以 Provider 注入到 `AgentTool`：

```js
const presentation = new AgentPresentation({ workspace, runtimeDependencies });

const agentTool = new AgentTool({
  workspace,
  runtimeDependencies,
  toolProviders: [presentation],
  tools: [
    "run_shell",
    "visualization_create_chart",
    "visualization_create_dashboard",
    "presentation_create",
    "presentation_status"
  ]
});
```

## 最小 Provider 形状

```js
{
  id: "stable-provider-id",
  toolDescriptors: [
    {
      name: "provider_tool",
      schema: {
        type: "function",
        function: { name: "provider_tool", description: "...", parameters: {} }
      },
      defaultVisible: false,
      timeoutMs: 120000,
      cancelable: true
    }
  ],
  getToolAvailability(name) {
    return { available: true };
  },
  async execute(name, args, context) {}
}
```

Provider 只能声明自己的工具名称，不能覆盖 `run_shell`、`skill_find` 等内置名称；
构造时发现重名会直接失败。`tools` 未传时，`AgentTool` 保持历史默认工具集合，新增
预制工具与 Provider 工具不会意外暴露。显式传入 `tools` 后，它成为严格名称白名单。

## 通用产物

Provider 生成用户可交付文件时，返回 `agent-output.v1` artifact：

```js
{
  status: "completed",
  artifacts: [{
    schemaVersion: "agent-output.v1",
    kind: "presentation",
    renderer: "presentation-review",
    id: "presentation-...",
    title: "季度复盘",
    files: [
      { path: "outputs/presentations/.../deck.pptx", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" }
    ],
    data: {}
  }]
}
```

`AgentCli` 会把该 artifact 提升为 `agent_output` 事件。完整 renderer 数据面向 GUI、
thread transcript 和 trace；模型下一轮只收到文件摘要，避免大对象反复进入上下文。

## 内置可视化工具

`visualization_create_chart` 和 `visualization_create_dashboard` 是内置但默认不展示的
预制工具。前者接受受控的 Vega-Lite 声明与内联数据，真实生成 `.vl.json`、SVG、PNG
和 manifest；后者接受 KPI、洞察、图表/表格/文本面板，真实生成 `dashboard.json`、
`dashboard.html`、图表文件和 manifest。两者只写入当前 workspace 的
`outputs/visualizations/`，不执行模型提供的 HTML 或 JavaScript。
