/**
 * Publish the built agent-tool artifact to OSS and write descriptor.oss.json.
 *
 * This is the credentialed release path used by GitHub Actions. It preserves
 * the local descriptor contract while replacing the file URL with an OSS URL.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createArtifactFileName,
  createOssConfigFromEnv,
  createOssObjectKey,
  createPublishedBrickDescriptor,
  publishFileToOss,
  validateArtifactDescriptor
} from "@xuanzhen-tech/agent-release-foundation";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const distDir = path.join(repoRoot, "dist");
const envPath = path.join(repoRoot, ".env");
const localDescriptorPath = path.join(distDir, "descriptor.local.json");
const buildMetadataPath = path.join(distDir, "build-artifact.json");
const ossDescriptorPath = path.join(distDir, "descriptor.oss.json");
const ossObjectsPath = path.join(distDir, "oss-objects.json");
const OSS_OBJECT_PREFIX = process.env.OSS_OBJECT_PREFIX || "bricks";
const BRICK_NAMESPACE = process.env.BRICK_NAMESPACE || "tool";
const ARTIFACT_CONTENT_TYPE = "application/zip";

await loadDotEnvIfPresent(envPath);

console.log("[publish-artifact] 1/6 read build outputs");
const localDescriptor = JSON.parse(await fs.readFile(localDescriptorPath, "utf8"));
const buildMetadata = JSON.parse(await fs.readFile(buildMetadataPath, "utf8"));

console.log("[publish-artifact] 2/6 read OSS config from environment");
const ossConfig = createOssConfigFromEnv(process.env);

console.log("[publish-artifact] 3/6 create OSS object key");
const artifactFileName = createArtifactFileName(localDescriptor);
const objectKey = createOssObjectKey({
  prefix: OSS_OBJECT_PREFIX,
  namespace: BRICK_NAMESPACE,
  brickId: localDescriptor.id,
  version: localDescriptor.version,
  fileName: artifactFileName
});

console.log("[publish-artifact] 4/6 upload artifact to OSS");
const upload = await publishFileToOss({
  config: ossConfig,
  filePath: buildMetadata.artifactPath,
  objectKey,
  contentType: ARTIFACT_CONTENT_TYPE
});

console.log("[publish-artifact] 5/6 create descriptor.oss.json");
const publishedDescriptor = createPublishedBrickDescriptor({
  descriptor: localDescriptor,
  ossUpload: upload
});
const output = {
  ...publishedDescriptor,
  metadata: {
    ...publishedDescriptor.metadata,
    objectKey,
    publishedBy: "agent-tool-brick"
  }
};

const validation = validateArtifactDescriptor(output);
if (!validation.ok) {
  throw new Error(`Invalid OSS descriptor: ${validation.errors.join("; ")}`);
}

await fs.writeFile(ossDescriptorPath, `${JSON.stringify(output, null, 2)}\n`);
await fs.writeFile(ossObjectsPath, `${JSON.stringify({ objects: [objectKey] }, null, 2)}\n`);

console.log("[publish-artifact] 6/6 done");
console.log("[publish-artifact] descriptor", ossDescriptorPath);
console.log("[publish-artifact] objectKey", objectKey);
console.log("[publish-artifact] url", output.url);

async function loadDotEnvIfPresent(filePath) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex === -1) continue;
      const key = trimmed.slice(0, separatorIndex).trim();
      const value = trimmed.slice(separatorIndex + 1).trim();
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
