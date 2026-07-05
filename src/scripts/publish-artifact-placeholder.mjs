/**
 * 创建不上传 OSS 的占位发布 descriptor。
 *
 * 本地 release 检查用这个脚本验证与真实 OSS 发布一致的 descriptor 形状，
 * 同时避免开发环境需要凭据。
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createArtifactFileName,
  createPublishedBrickDescriptor,
  validateArtifactDescriptor
} from "@xuanzhen-tech/agent-release-foundation";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const distDir = path.join(repoRoot, "dist");
const localDescriptorPath = path.join(distDir, "descriptor.local.json");
const placeholderDescriptorPath = path.join(distDir, "descriptor.oss.placeholder.json");
const placeholderPublicBaseUrl = "https://oss.example.invalid";
const PLACEHOLDER_NAMESPACE = "tool";

console.log("[publish-artifact-placeholder] 1/5 read local descriptor");
const localDescriptor = JSON.parse(await fs.readFile(localDescriptorPath, "utf8"));

console.log("[publish-artifact-placeholder] 2/5 calculate placeholder OSS object key");
const artifactFileName = createArtifactFileName(localDescriptor);
const objectKey = [
  "bricks",
  PLACEHOLDER_NAMESPACE,
  localDescriptor.id,
  localDescriptor.version,
  artifactFileName
].join("/");

const ossUploadPlaceholder = {
  objectKey,
  url: `${placeholderPublicBaseUrl}/${objectKey}`,
  size: localDescriptor.size,
  sha256: localDescriptor.sha256,
  status: "placeholder-only"
};

console.log("[publish-artifact-placeholder] 3/5 create published descriptor placeholder");
const publishedDescriptor = createPublishedBrickDescriptor({
  descriptor: localDescriptor,
  ossUpload: ossUploadPlaceholder
});
const output = {
  ...publishedDescriptor,
  metadata: {
    ...publishedDescriptor.metadata,
    ossPlaceholder: true,
    objectKey,
    note: "This file only shows the expected OSS descriptor shape. It is not a real upload result."
  }
};

console.log("[publish-artifact-placeholder] 4/5 validate placeholder descriptor");
const validation = validateArtifactDescriptor(output);
if (!validation.ok) {
  throw new Error(`Invalid placeholder descriptor: ${validation.errors.join("; ")}`);
}

await fs.writeFile(placeholderDescriptorPath, `${JSON.stringify(output, null, 2)}\n`);

console.log("[publish-artifact-placeholder] 5/5 done");
console.log("[publish-artifact-placeholder] descriptor", placeholderDescriptorPath);
console.log("[publish-artifact-placeholder] objectKey", objectKey);
console.log("[publish-artifact-placeholder] url", output.url);
