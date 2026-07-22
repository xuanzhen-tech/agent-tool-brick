/**
 * 【文件说明】
 * 本文件提供 agent-tool 的受控 Vega 渲染运行时。
 *
 * 可视化工具需要在本地把声明式 Vega-Lite spec 编译为 SVG/PNG。这里固定加载随
 * SDK 发布、且由官方源码标签构建后校验过哈希的静态 bundle，避免依赖安装环境中
 * 漂移的 Vega 包构建产物。它不接收模型输入，也不执行模型提供的脚本。
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const EXPECTED_VEGA_VERSION = "6.3.0";
const EXPECTED_VEGA_LITE_VERSION = "6.4.3";

// Vega-Lite 的 CommonJS 入口已经被限定为加载同目录、经过校验的 Vega bundle。
// 这样 runtime 不会从产品仓库或全局 node_modules 解析不确定的同名依赖。
const vega = require("./vendor/vega-6.3.0.cjs");
const vegaLite = require("./vendor/vega-lite-6.4.3.cjs");

/**
 * 返回版本锁定的 Vega/Vega-Lite 运行时。
 *
 * 版本断言让构建、artifact 解压或文件被意外替换时尽早失败，而不是悄悄生成错误
 * 图表。调用者只获得编译与渲染所需的运行时对象。
 */
export function getVegaRuntime() {
  if (vega.version !== EXPECTED_VEGA_VERSION) {
    throw new Error(`Vega 渲染运行时版本异常，期望 ${EXPECTED_VEGA_VERSION}，实际 ${String(vega.version)}。`);
  }
  if (vegaLite.version !== EXPECTED_VEGA_LITE_VERSION) {
    throw new Error(`Vega-Lite 渲染运行时版本异常，期望 ${EXPECTED_VEGA_LITE_VERSION}，实际 ${String(vegaLite.version)}。`);
  }
  return { vega, vegaLite };
}
