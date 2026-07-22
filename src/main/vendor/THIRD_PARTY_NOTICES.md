# 第三方运行时说明

本目录包含 `agent-tool` 可视化工具运行时所需的静态构建文件。它们只用于将受控的
Vega-Lite 声明式图表编译并渲染为本地 SVG/PNG；不会联网下载代码，也不会执行模型
提供的 JavaScript。

| 文件 | 上游版本 | 许可证 | 官方来源 |
| --- | --- | --- | --- |
| `vega-6.3.0.cjs` | Vega 6.3.0 | BSD-3-Clause | https://github.com/vega/vega/tree/v6.3.0 |
| `vega-lite-6.4.3.cjs` | Vega-Lite 6.4.3 | BSD-3-Clause | https://github.com/vega/vega-lite/tree/v6.4.3 |

文件哈希、源码标签和唯一的模块解析调整记录在 `vendor-manifest.json`。其中
`vega-lite-6.4.3.cjs` 仅将 CommonJS 对 `vega` 的包名引用改为同目录的受控文件引用，
没有修改上游渲染逻辑。
