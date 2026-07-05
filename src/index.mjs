/**
 * agent-tool 的公开 SDK 出口。
 *
 * host launcher 和其它积木只应该从这个文件 import。本模块只重新导出
 * 启动配置、manifest 校验和工具结果压缩这些稳定合同，运行时内部实现
 * 保持私有。
 */

export { brickDefinition } from "./brick-definition.mjs";
export { AgentTool } from "./main/agent-tool.mjs";
export {
  createAgentToolLaunchConfig,
  createAgentToolRuntimeContract,
  validateAgentToolLaunchConfig
} from "./main/launch-config.mjs";
export {
  AGENT_TOOL_MANIFEST_SCHEMA_VERSION,
  createAgentToolManifest,
  validateAgentToolCall,
  validateAgentToolManifest,
  validateAgentToolResult
} from "./main/tool-contract.mjs";
export {
  TOOL_RESULT_COMPRESSION_MARKER,
  compressToolExecutionResult,
  isToolResultCompressionEnabled
} from "./main/tool-result-compression.mjs";
