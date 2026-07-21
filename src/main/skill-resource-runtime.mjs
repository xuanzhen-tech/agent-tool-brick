/**
 * skill 资源的模型工具适配层。
 *
 * AgentSkill 负责证明 references/assets 的来源安全，本模块负责把它们转换成
 * `skill_resource` 的两种模型操作：读取 reference，或将 asset 物化到固定的
 * workspace 临时目录。模型不能指定目标路径，避免把 skill 资源写到任意位置。
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const ASSET_ROOT_SEGMENTS = ["temp", "skill-assets"];
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/;

/**
 * 执行 skill_resource 的具体动作。
 *
 * 该函数只接受 AgentSkill 的公开方法，不读取 index 文件，也不回退到 shell。
 * read_reference 的全文由 AgentCli 识别为专门上下文；copy_asset 的副本始终
 * 落在 `<workspace>/temp/skill-assets/<skill>/<hash>/`，没有可配置目标路径。
 */
export async function executeSkillResource(skillRuntime, argumentsValue = {}, context = {}) {
  const action = readRequiredString(argumentsValue.action, "skill resource action");
  const skill = readRequiredString(
    argumentsValue.skill ?? argumentsValue.name ?? argumentsValue.id,
    "skill"
  );
  const resourcePath = readRequiredString(argumentsValue.path, "skill resource path");

  if (action === "read_reference") {
    const result = await skillRuntime.readReference(skill, resourcePath, context);
    return {
      action,
      ...result
    };
  }

  if (action === "copy_asset") {
    rejectCallerControlledDestination(argumentsValue);
    const resolved = await skillRuntime.resolveAsset(skill, resourcePath, context);
    const asset = resolved?.asset;
    if (!asset || typeof asset !== "object" || Array.isArray(asset)) {
      throw new Error("AgentSkill returned an invalid asset descriptor.");
    }
    const materialized = await materializeSkillAsset({
      asset,
      workspace: context.workspace
    });
    return {
      action,
      ...resolved,
      ...materialized
    };
  }

  throw new Error(`Unsupported skill resource action: ${action}`);
}

async function materializeSkillAsset({ asset, workspace }) {
  const workspaceRoot = await resolveWorkspaceRoot(workspace);
  const skillName = normalizeSkillName(asset.skillName ?? asset.skillId);
  const contentHash = normalizeContentHash(asset.contentHash);
  const fileName = normalizeFileName(asset.fileName ?? path.basename(String(asset.path ?? "")));
  const sourcePath = path.resolve(readRequiredString(asset.absolutePath, "skill asset source path"));
  const targetPath = path.resolve(workspaceRoot, ...ASSET_ROOT_SEGMENTS, skillName, contentHash, fileName);
  assertInside(workspaceRoot, targetPath, "Skill asset target escapes workspace.");

  const sourceStat = await fs.lstat(sourcePath);
  if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) throw new Error(`Skill asset source is not a regular file: ${asset.path ?? sourcePath}`);
  if (Number.isInteger(asset.bytes) && sourceStat.size !== asset.bytes) {
    throw new Error(`Skill asset size changed before materialization: ${asset.path ?? sourcePath}`);
  }
  const sourceHash = await sha256File(sourcePath);
  if (sourceHash !== contentHash) {
    throw new Error(`Skill asset content changed before materialization: ${asset.path ?? sourcePath}`);
  }

  try {
    const targetStat = await fs.lstat(targetPath);
    if (targetStat.isSymbolicLink() || !targetStat.isFile()) throw new Error(`Skill asset target is not a regular file: ${targetPath}`);
    const targetHash = await sha256File(targetPath);
    if (targetHash !== contentHash) {
      throw new Error(`Skill asset target conflicts with a different file: ${toWorkspacePath(workspaceRoot, targetPath)}`);
    }
    return createMaterializedAssetResult({
      workspaceRoot,
      targetPath,
      asset,
      copied: false,
      reused: true
    });
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }

  await ensureSafeTargetDirectory(workspaceRoot, path.dirname(targetPath));
  const temporaryPath = `${targetPath}.tmp-${crypto.randomUUID()}`;
  try {
    await fs.copyFile(sourcePath, temporaryPath);
    const copiedHash = await sha256File(temporaryPath);
    if (copiedHash !== contentHash) {
      throw new Error(`Copied skill asset hash does not match source: ${asset.path ?? sourcePath}`);
    }
    await fs.rename(temporaryPath, targetPath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }

  return createMaterializedAssetResult({
    workspaceRoot,
    targetPath,
    asset,
    copied: true,
    reused: false
  });
}

function createMaterializedAssetResult({ workspaceRoot, targetPath, asset, copied, reused }) {
  return {
    copied,
    reused,
    workspacePath: toWorkspacePath(workspaceRoot, targetPath),
    asset: {
      skillId: asset.skillId,
      skillName: asset.skillName,
      path: asset.path,
      contentHash: asset.contentHash,
      bytes: asset.bytes
    }
  };
}

async function resolveWorkspaceRoot(value) {
  const workspace = readRequiredString(value, "workspace");
  const workspaceRoot = path.resolve(workspace);
  const stat = await fs.lstat(workspaceRoot);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`workspace must be a regular directory: ${workspaceRoot}`);
  }
  return await fs.realpath(workspaceRoot);
}

// 逐层创建并检查固定物化目录，拒绝任何预先存在的符号链接；否则字符串上
// 位于 workspace 内的 temp/skill-assets 仍可能在真实文件系统中逃逸出去。
async function ensureSafeTargetDirectory(workspaceRoot, targetDirectory) {
  assertInside(workspaceRoot, targetDirectory, "Skill asset target escapes workspace.");
  const relative = path.relative(workspaceRoot, targetDirectory);
  let current = workspaceRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      await fs.mkdir(current);
    } catch (error) {
      if (!error || typeof error !== "object" || error.code !== "EEXIST") throw error;
    }
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Skill asset directory is not a regular directory: ${current}`);
    }
    const realDirectory = await fs.realpath(current);
    assertInside(workspaceRoot, realDirectory, "Skill asset directory escapes workspace.");
  }
}

function rejectCallerControlledDestination(argumentsValue) {
  for (const key of ["destination", "destinationPath", "target", "targetPath", "outputPath"]) {
    if (argumentsValue[key] !== undefined) {
      throw new Error("copy_asset uses a fixed workspace temp/skill-assets destination; destination path is not supported.");
    }
  }
}

function normalizeSkillName(value) {
  const skillName = readRequiredString(value, "skill asset name").toLowerCase();
  if (!SKILL_NAME_PATTERN.test(skillName)) {
    throw new Error(`Invalid skill asset name: ${value}`);
  }
  return skillName;
}

function normalizeContentHash(value) {
  const contentHash = readRequiredString(value, "skill asset content hash").toLowerCase();
  if (!SHA256_PATTERN.test(contentHash)) {
    throw new Error("Skill asset content hash must be a sha256 value.");
  }
  return contentHash;
}

function normalizeFileName(value) {
  const fileName = readRequiredString(value, "skill asset file name");
  if (fileName === "." || fileName === ".." || path.basename(fileName) !== fileName) {
    throw new Error(`Invalid skill asset file name: ${value}`);
  }
  return fileName;
}

async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead <= 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

function readRequiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  return value.trim();
}

function assertInside(parentPath, childPath, message) {
  const relative = path.relative(parentPath, childPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(message);
}

function toWorkspacePath(workspaceRoot, targetPath) {
  const relative = path.relative(workspaceRoot, targetPath);
  assertInside(workspaceRoot, targetPath, "Skill asset target escapes workspace.");
  return relative.split(path.sep).join("/");
}

function isMissingPathError(error) {
  return error && typeof error === "object" && error.code === "ENOENT";
}
