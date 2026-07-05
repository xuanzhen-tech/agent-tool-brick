/**
 * Public SDK surface for agent-tool.
 *
 * Host launchers and other bricks should import from this file only. The module
 * re-exports stable contracts for launch configuration, manifest validation,
 * and tool-result compression while keeping runtime internals private.
 */

export { brickDefinition } from "./brick-definition.mjs";
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
