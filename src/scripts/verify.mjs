/**
 * 验证 agent-tool 积木的本地构建产物。
 *
 * 这是 release:local 的最后一道护栏，用来校验积木元数据、包形状、
 * runtime artifact 完整性、descriptor 形状，以及明显的 secret 或无关
 * 运行时二进制泄露。
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  validateArtifactDescriptor,
  validateBrickDefinition
} from "@xuanzhen-tech/agent-release-foundation";

import { brickDefinition } from "../brick-definition.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const distDir = path.join(repoRoot, "dist");
const packageJsonPath = path.join(repoRoot, "package.json");
const buildMetadataPath = path.join(distDir, "build-artifact.json");
const runtimeDir = path.join(distDir, "runtime");

console.log("[verify] 1/5 validate brick definition");
const brickValidation = validateBrickDefinition(brickDefinition);
if (!brickValidation.ok) {
  throw new Error(`Invalid brick definition: ${brickValidation.errors.join("; ")}`);
}

console.log("[verify] 2/5 validate package metadata");
const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
const packageErrors = validatePackageJson(packageJson);
if (packageErrors.length > 0) {
  throw new Error(`Invalid package.json: ${packageErrors.join("; ")}`);
}

console.log("[verify] 3/5 validate runtime artifact if present");
await validateRuntimeArtifactIfPresent();

console.log("[verify] 4/5 validate descriptors if present");
await validateDescriptorIfPresent(path.join(distDir, "descriptor.local.json"));
await validateDescriptorIfPresent(path.join(distDir, "descriptor.oss.json"));
await validateDescriptorIfPresent(path.join(distDir, "descriptor.oss.placeholder.json"));

console.log("[verify] 5/5 done");
console.log("[verify] brick", brickDefinition.id);
console.log("[verify] version", brickDefinition.version);
console.log("[verify] package", packageJson.name);

function validatePackageJson(packageJson) {
  const errors = [];
  if (packageJson.name !== "@xuanzhen-tech/agent-tool-brick") errors.push("name must be @xuanzhen-tech/agent-tool-brick");
  if (packageJson.type !== "module") errors.push("type must be module");
  if (packageJson.exports !== "./src/index.mjs") errors.push("exports must point to ./src/index.mjs");
  if (packageJson.bin?.["agent-tool"] !== "./src/cli.mjs") errors.push("bin.agent-tool must point to ./src/cli.mjs");
  if (packageJson.publishConfig?.registry !== "https://npm.pkg.github.com") {
    errors.push("publishConfig.registry must be https://npm.pkg.github.com");
  }
  if (!packageJson.dependencies?.["@xuanzhen-tech/agent-release-foundation"]) {
    errors.push("baseLine dependency is required");
  }
  return errors;
}

async function validateDescriptorIfPresent(filePath) {
  let content;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      console.log("[verify] skip missing descriptor", filePath);
      return;
    }
    throw error;
  }

  const descriptor = JSON.parse(content);
  const validation = validateArtifactDescriptor(descriptor);
  if (!validation.ok) {
    throw new Error(`Invalid descriptor ${filePath}: ${validation.errors.join("; ")}`);
  }
  if ("sourceFile" in descriptor) {
    throw new Error(`Invalid descriptor ${filePath}: sourceFile must not be published`);
  }
  if (descriptor.type !== "tool") throw new Error(`Invalid descriptor ${filePath}: type must be tool`);
  if (descriptor.slot !== "tool:agent-tool") throw new Error(`Invalid descriptor ${filePath}: slot must be tool:agent-tool`);
  if ((filePath.endsWith("descriptor.oss.json") || filePath.endsWith("descriptor.oss.placeholder.json")) && String(descriptor.url).startsWith("file://")) {
    throw new Error(`Invalid descriptor ${filePath}: OSS descriptor must not use file:// URL`);
  }
  console.log("[verify] descriptor ok", filePath);
}

async function validateRuntimeArtifactIfPresent() {
  let metadata;
  try {
    metadata = JSON.parse(await fs.readFile(buildMetadataPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      console.log("[verify] skip missing runtime artifact metadata", buildMetadataPath);
      return;
    }
    throw error;
  }

  const artifactBuffer = await fs.readFile(metadata.artifactPath);
  const actualSha = crypto.createHash("sha256").update(artifactBuffer).digest("hex");
  if (actualSha !== metadata.sha256) {
    throw new Error("Runtime artifact sha256 does not match build metadata");
  }

  const runtimeFiles = Array.isArray(metadata.runtimeFiles) ? metadata.runtimeFiles : [];
  const requiredFiles = [
    "runtime-contract.json",
    "package.json",
    "brick-definition.snapshot.json",
    "src/cli.mjs",
    "src/main/server.mjs",
    "src/main/shell-runtime.mjs",
    "src/main/runtime-dependency-config.mjs",
    "src/main/search-runtime.mjs",
    "src/main/skill-runtime.mjs",
    "src/main/terminal-runtime.mjs",
    "src/main/tool-contract.mjs",
    "src/main/tool-result-compression.mjs",
    "src/main/web-runtime.mjs"
  ];
  for (const requiredFile of requiredFiles) {
    if (!runtimeFiles.includes(requiredFile)) {
      throw new Error(`Runtime artifact is missing ${requiredFile}`);
    }
  }

  for (const file of runtimeFiles) {
    const normalized = String(file).replaceAll("\\", "/").toLowerCase();
    if (
      normalized === ".env" ||
      normalized.startsWith(".env.") ||
      normalized.startsWith("apps/") ||
      normalized.startsWith("services/") ||
      normalized.startsWith("packages/") ||
      normalized.includes("desktop-gui") ||
      normalized.includes("desktop-shell") ||
      normalized.endsWith("node.exe") ||
      normalized.endsWith("python.exe") ||
      normalized.endsWith("rg.exe")
    ) {
      throw new Error(`Runtime artifact contains forbidden path: ${file}`);
    }
  }

  const runtimeContract = JSON.parse(await fs.readFile(path.join(runtimeDir, "runtime-contract.json"), "utf8"));
  if (runtimeContract.schemaVersion !== "agent-tool.runtime.v1") {
    throw new Error("runtime-contract.json schemaVersion must be agent-tool.runtime.v1");
  }
  if (runtimeContract.command !== "agent-tool") {
    throw new Error("runtime-contract.json command must be agent-tool");
  }
  if (!runtimeContract.runtimeDependencies?.required?.some((dependency) => dependency.type === "node-runtime")) {
    throw new Error("runtime-contract.json must declare node-runtime as required");
  }
  if (!runtimeContract.runtimeDependencies?.optional?.some((dependency) => dependency.slot === "tool:rg")) {
    throw new Error("runtime-contract.json must declare tool:rg as optional");
  }
  if (!runtimeContract.runtimeDependencies?.optional?.some((dependency) => dependency.type === "python-runtime")) {
    throw new Error("runtime-contract.json must declare python-runtime as optional");
  }
  if (!runtimeContract.runtimeDependencies?.optional?.some((dependency) => dependency.type === "node-package")) {
    throw new Error("runtime-contract.json must declare node-package as optional");
  }
  if (!runtimeContract.runtimeDependencies?.optional?.some((dependency) => dependency.type === "playwright-browsers")) {
    throw new Error("runtime-contract.json must declare playwright-browsers as optional");
  }

  await assertRuntimeFilesDoNotContainSecrets(runtimeFiles);
  console.log("[verify] runtime artifact ok", metadata.artifactFileName);
}

async function assertRuntimeFilesDoNotContainSecrets(runtimeFiles) {
  const secretPattern = /\b(?:sk|sk-ant|sk-or|ghp|github_pat|AKIA)[A-Za-z0-9_-]{20,}\b/;
  for (const file of runtimeFiles) {
    const filePath = path.join(runtimeDir, ...String(file).split("/"));
    let content;
    try {
      content = await fs.readFile(filePath, "utf8");
    } catch {
      continue;
    }
    if (secretPattern.test(content)) {
      throw new Error(`Runtime artifact file appears to contain a secret: ${file}`);
    }
  }
}
