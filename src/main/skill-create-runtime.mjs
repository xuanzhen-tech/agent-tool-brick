/**
 * 【文件职责】
 * 把模型提交的 Skill 定义组装成临时、完整且受控的 Skill 包，并交给注入的
 * AgentSkill 执行最终校验、冲突处理、事务安装和索引刷新。
 *
 * 【职责边界】
 * 本模块不猜测 AgentSkill 的安装目录，也不修改产品的 Skill 白名单。产品若
 * 包装了 AgentSkill.install()，本工具会自然进入同一安装事务。临时目录始终
 * 位于系统临时区，调用结束后删除。
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const MAX_SKILL_NAME_CHARS = 64;
const MAX_FILES = 100;
const ALLOWED_RESOURCE_ROOTS = new Set(["references", "scripts", "assets"]);

/**
 * 创建 Skill 包并调用 AgentSkill.install()。只有安装器返回成功后，结果才会
 * 暴露真实 canonical name 和受管安装路径。
 */
export async function executeSkillCreate(skillRuntime, call, signal) {
  assertNotAborted(signal);
  if (typeof skillRuntime?.install !== "function") {
    throw new Error("Injected AgentSkill runtime does not support install().");
  }

  const input = normalizeCreateInput(call.arguments ?? {});
  const workspace = await resolveWorkspace(call.workspace?.root);
  const stagingRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-tool-skill-create-"));
  try {
    await fs.writeFile(path.join(stagingRoot, "SKILL.md"), buildSkillMarkdown(input), "utf8");
    for (const file of input.files) {
      assertNotAborted(signal);
      await materializeResource({ file, stagingRoot, workspace });
    }

    assertNotAborted(signal);
    const installed = await skillRuntime.install(stagingRoot, { conflict: input.conflict });
    const mutationStatus = installed?.status;
    return {
      // unchanged 表示已有内容已经满足请求，不能把“无需写入”误报成本次新建。
      created: installed?.installed === true || mutationStatus === "installed" || mutationStatus === "replaced",
      requestedName: input.name,
      conflict: input.conflict,
      // skillsPath 是 AgentSkill 的公开配置快照。返回真实值只用于让模型解释
      // 当前安装位置；所有写入仍必须继续走 install()，不得据此改用 shell。
      managedSkillsPath: normalizeManagedSkillsPath(skillRuntime.config?.skillsPath),
      installation: installed,
      guidance: mutationStatus === "conflict"
        ? "同名 Skill 已存在，未写入。检查差异并获得用户明确授权后，才可使用 conflict=replace。"
        : mutationStatus === "unchanged"
          ? "相同 Skill 已经安装，本次没有重复写入。可使用 skill_find 和 skill_activate 继续核验。"
          : "Skill 已通过 AgentSkill 校验并安装。下一步使用 skill_find 确认可见，再用 skill_activate 验证完整说明。"
    };
  } finally {
    await fs.rm(stagingRoot, { recursive: true, force: true });
  }
}

function normalizeCreateInput(value) {
  const name = requireString(value.name, "skill_create name").toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > MAX_SKILL_NAME_CHARS) {
    throw new Error(`skill_create name must use lowercase letters, digits, and hyphens, up to ${MAX_SKILL_NAME_CHARS} characters.`);
  }
  const description = requireSingleLine(value.description, "skill_create description");
  const instructions = requireString(value.instructions, "skill_create instructions");
  const version = optionalString(value.version) ?? "0.1.0";
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error("skill_create version must use x.y.z.");
  }
  const files = value.files === undefined ? [] : value.files;
  if (!Array.isArray(files) || files.length > MAX_FILES) {
    throw new Error(`skill_create files must be an array with at most ${MAX_FILES} items.`);
  }
  const normalizedFiles = files.map((file, index) => normalizeResourceFile(file, index));
  if (new Set(normalizedFiles.map((file) => file.path.toLowerCase())).size !== normalizedFiles.length) {
    throw new Error("skill_create files must not contain duplicate paths.");
  }
  const conflict = value.conflict === undefined ? "check" : value.conflict;
  if (!new Set(["check", "replace"]).has(conflict)) {
    throw new Error("skill_create conflict must be check or replace.");
  }
  return {
    name,
    description,
    instructions,
    version,
    capabilities: normalizeStringList(value.capabilities, "capabilities"),
    requiredTools: normalizeStringList(value.requiredTools, "requiredTools"),
    optionalTools: normalizeStringList(value.optionalTools, "optionalTools"),
    files: normalizedFiles,
    conflict
  };
}

function normalizeResourceFile(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`skill_create files[${index}] must be an object.`);
  }
  const relativePath = normalizePackagePath(requireString(value.path, `skill_create files[${index}].path`));
  const root = relativePath.split("/")[0];
  if (!ALLOWED_RESOURCE_ROOTS.has(root)) {
    throw new Error(`skill_create files[${index}].path must be under references/, scripts/, or assets/.`);
  }
  const hasContent = typeof value.content === "string";
  const hasSource = typeof value.sourcePath === "string" && value.sourcePath.trim() !== "";
  if (hasContent === hasSource) {
    throw new Error(`skill_create files[${index}] must provide exactly one of content or sourcePath.`);
  }
  if (hasSource && root !== "assets") {
    throw new Error(`skill_create files[${index}].sourcePath is only supported for assets/.`);
  }
  return {
    path: relativePath,
    content: hasContent ? value.content : undefined,
    sourcePath: hasSource ? value.sourcePath.trim() : undefined
  };
}

async function materializeResource({ file, stagingRoot, workspace }) {
  const destination = path.resolve(stagingRoot, ...file.path.split("/"));
  assertInside(destination, stagingRoot, "skill package path");
  await fs.mkdir(path.dirname(destination), { recursive: true });
  if (file.content !== undefined) {
    await fs.writeFile(destination, file.content, "utf8");
    return;
  }

  if (!workspace) throw new Error("skill_create sourcePath requires a workspace.");
  if (path.isAbsolute(file.sourcePath)) {
    throw new Error("skill_create sourcePath must be workspace-relative.");
  }
  const source = path.resolve(workspace, file.sourcePath);
  assertInside(source, workspace, "skill_create sourcePath");
  const sourceLinkStat = await fs.lstat(source);
  if (sourceLinkStat.isSymbolicLink()) {
    throw new Error("skill_create sourcePath must not be a symbolic link.");
  }
  const sourceRealPath = await fs.realpath(source);
  const workspaceRealPath = await fs.realpath(workspace);
  assertInside(sourceRealPath, workspaceRealPath, "skill_create sourcePath");
  const stat = await fs.stat(sourceRealPath);
  if (!stat.isFile()) {
    throw new Error("skill_create sourcePath must reference a regular workspace file.");
  }
  await fs.copyFile(sourceRealPath, destination);
}

function buildSkillMarkdown(input) {
  const frontmatter = [
    "---",
    `name: ${input.name}`,
    `description: ${input.description}`,
    `version: ${input.version}`,
    formatListField("capabilities", input.capabilities),
    formatListField("requiredTools", input.requiredTools),
    formatListField("optionalTools", input.optionalTools),
    "---"
  ].filter(Boolean).join("\n");
  return `${frontmatter}\n\n${input.instructions.trim()}\n`;
}

function formatListField(name, values) {
  return values.length ? `${name}: [${values.join(", ")}]` : undefined;
}

async function resolveWorkspace(value) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const workspace = path.resolve(value);
  const stat = await fs.stat(workspace);
  if (!stat.isDirectory()) throw new Error("skill_create workspace must be a directory.");
  return workspace;
}

function normalizePackagePath(value) {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (path.posix.isAbsolute(normalized) || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("skill_create resource path must be a safe relative path.");
  }
  return normalized;
}

function normalizeStringList(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`skill_create ${label} must be an array.`);
  return [...new Set(value.map((item, index) => {
    const normalized = requireSingleLine(item, `skill_create ${label}[${index}]`);
    // AgentSkill 当前使用轻量 frontmatter 列表解析器，禁止会改变分项边界的字符。
    if (/[,\[\]]/u.test(normalized)) {
      throw new Error(`skill_create ${label}[${index}] must not contain commas or brackets.`);
    }
    return normalized;
  }))];
}

function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  return value.trim();
}

function requireSingleLine(value, label) {
  const normalized = requireString(value, label).replace(/\s+/gu, " ");
  if (normalized.includes("---")) throw new Error(`${label} contains unsupported frontmatter delimiter.`);
  return normalized;
}

function optionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeManagedSkillsPath(value) {
  return typeof value === "string" && value.trim() ? path.resolve(value) : undefined;
}

function assertInside(childPath, parentPath, label) {
  const relative = path.relative(parentPath, childPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes its allowed root.`);
  }
}

function assertNotAborted(signal) {
  if (signal?.aborted) throw signal.reason ?? new Error("skill_create was interrupted.");
}
