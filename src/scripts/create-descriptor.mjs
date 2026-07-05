import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import {
  createArtifactDescriptor,
  createArtifactFileName,
  validateArtifactDescriptor
} from "@xuanzhen-tech/agent-release-foundation";

import { brickDefinition } from "../brick-definition.mjs";

const ARTIFACT_TYPE = "tool";
const TARGET_PLATFORM = "win32-x64";
const FILE_EXTENSION = ".zip";
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const distDir = path.join(repoRoot, "dist");
const buildMetadataPath = path.join(distDir, "build-artifact.json");
const descriptorPath = path.join(distDir, "descriptor.local.json");

console.log("[create-descriptor] 1/5 read build metadata");
const buildMetadata = JSON.parse(await fs.readFile(buildMetadataPath, "utf8"));

console.log("[create-descriptor] 2/5 create local descriptor");
const descriptor = createArtifactDescriptor({
  id: brickDefinition.id,
  type: ARTIFACT_TYPE,
  name: brickDefinition.name,
  version: brickDefinition.version,
  platform: TARGET_PLATFORM,
  url: pathToFileURL(buildMetadata.artifactPath).href,
  size: buildMetadata.size,
  sha256: buildMetadata.sha256,
  fileExtension: FILE_EXTENSION,
  slot: "tool:agent-tool",
  install: {
    strategy: "versioned-directory",
    command: "agent-tool serve"
  },
  metadata: {
    brickId: brickDefinition.id,
    brickKind: brickDefinition.kind,
    source: "agent-tool-brick",
    runtimeContract: "runtime-contract.json",
    toolManifestEndpoint: "/api/tools/manifest",
    toolCallEndpoint: "/api/tools/call",
    toolCancelEndpoint: "/api/tools/cancel"
  }
});

console.log("[create-descriptor] 3/5 validate descriptor");
const validation = validateArtifactDescriptor(descriptor);
if (!validation.ok) {
  throw new Error(`Invalid artifact descriptor: ${validation.errors.join("; ")}`);
}

console.log("[create-descriptor] 4/5 create standard file name");
const standardFileName = createArtifactFileName(descriptor);
const output = {
  ...descriptor,
  metadata: {
    ...descriptor.metadata,
    standardFileName
  }
};

await fs.writeFile(descriptorPath, `${JSON.stringify(output, null, 2)}\n`);

console.log("[create-descriptor] 5/5 done");
console.log("[create-descriptor] descriptor", descriptorPath);
console.log("[create-descriptor] id", output.id);
console.log("[create-descriptor] version", output.version);
console.log("[create-descriptor] url", output.url);
console.log("[create-descriptor] standardFileName", standardFileName);
