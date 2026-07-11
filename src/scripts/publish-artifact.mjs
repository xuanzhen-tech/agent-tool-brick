/**
 * 将构建出的 agent-tool artifact 发布到 OSS，并写入 descriptor.oss.json。
 *
 * 这是 GitHub Actions 使用的带凭据发布路径。它保留本地 descriptor 合同，
 * 同时把 file URL 替换为 OSS URL。
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
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

// agent-release-foundation@0.0.6 does not set object ACL during upload.
// The descriptor URL is consumed directly by launchers, so make it readable.
await setOssObjectAcl({ config: ossConfig, objectKey, acl: "public-read" });

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
    objectAcl: "public-read",
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

function setOssObjectAcl(input = {}) {
  const config = input.config;
  const objectKey = requireString(input.objectKey, "objectKey");
  const acl = requireString(input.acl, "acl");
  const encodedObjectKey = encodeObjectKey(objectKey);
  const resourcePath = `/${encodedObjectKey}?acl`;
  const date = new Date().toUTCString();
  const canonicalizedHeaders = `x-oss-object-acl:${acl}\n`;
  const canonicalResource = `/${config.bucket}/${encodedObjectKey}?acl`;
  const stringToSign = ["PUT", "", "", date, `${canonicalizedHeaders}${canonicalResource}`].join("\n");
  const signature = crypto
    .createHmac("sha1", config.accessKeySecret)
    .update(stringToSign)
    .digest("base64");

  const headers = {
    Date: date,
    Authorization: `OSS ${config.accessKeyId}:${signature}`,
    "Content-Length": 0,
    "x-oss-object-acl": acl
  };
  const client = config.protocol === "http:" ? http : https;

  return new Promise((resolve, reject) => {
    const request = client.request(
      {
        protocol: config.protocol,
        hostname: config.endpointHost,
        method: "PUT",
        path: resourcePath,
        headers
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if (response.statusCode >= 200 && response.statusCode < 300) {
            resolve({ statusCode: response.statusCode });
            return;
          }
          reject(new Error(`OSS PUT ACL ${objectKey} failed: ${response.statusCode} ${body.slice(0, 500)}`));
        });
      }
    );

    request.on("error", reject);
    request.end();
  });
}

function encodeObjectKey(objectKey) {
  return requireString(objectKey, "objectKey").replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/");
}

function requireString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}
