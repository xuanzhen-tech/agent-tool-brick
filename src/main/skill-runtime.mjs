/**
 * Runtime adapter for model-callable skill tools.
 *
 * agent-tool does not own skill installation or indexing. This module only
 * consumes an agent-skill generated index file, exposes lightweight search, and
 * reads a selected SKILL.md for activation. The returned loadedSkill payload is
 * intentionally stateless; the orchestrator is responsible for persistence.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { numberField, stringField } from "./env.mjs";

const MAX_ACTIVATED_SKILL_BYTES = 256 * 1024;
const DEFAULT_FIND_LIMIT = 20;
const MAX_FIND_LIMIT = 100;

export async function isSkillIndexAvailable(skillIndexPath) {
  if (!skillIndexPath) {
    return {
      available: false,
      detail: "AGENT_TOOL_SKILL_INDEX is not configured."
    };
  }
  try {
    const index = await loadSkillIndex(skillIndexPath);
    return {
      available: true,
      detail: `${index.skills.length} skills indexed.`
    };
  } catch (error) {
    return {
      available: false,
      detail: formatError(error)
    };
  }
}

export async function executeSkillFind(call, config) {
  const index = await loadSkillIndex(config.skillIndexPath);
  const query = stringField(call.arguments?.query)?.toLowerCase();
  const capability = stringField(call.arguments?.capability);
  const requiredTool = stringField(call.arguments?.requiredTool);
  const includeDisabled = call.arguments?.includeDisabled === true;
  const limit = clampLimit(numberField(call.arguments?.limit));

  const skills = index.skills
    .filter((skill) => includeDisabled || skill.enabled !== false)
    .filter((skill) => !query || matchesQuery(skill, query))
    .filter((skill) => !capability || listIncludes(skill.capabilities, capability))
    .filter((skill) => !requiredTool || listIncludes([...toList(skill.requiredTools), ...toList(skill.optionalTools)], requiredTool))
    .slice(0, limit)
    .map(toSkillFindItem);

  return {
    status: "completed",
    content: JSON.stringify({ skills }, null, 2),
    details: {
      indexPath: config.skillIndexPath,
      query,
      capability,
      requiredTool,
      count: skills.length,
      skills
    }
  };
}

export async function executeSkillActivate(call, config) {
  const index = await loadSkillIndex(config.skillIndexPath);
  const requestedSkill = stringField(call.arguments?.skill);
  if (!requestedSkill) {
    return blockedResult("skill_required", "skill is required");
  }

  const skill = index.skills.find((candidate) => candidate.id === requestedSkill || candidate.name === requestedSkill);
  if (!skill) {
    return blockedResult("skill_not_found", `Unknown skill: ${requestedSkill}`);
  }
  if (skill.enabled === false) {
    return blockedResult("skill_disabled", skill.disabledReason || `Skill is disabled: ${skill.name}`);
  }

  const skillFilePath = await resolveIndexedSkillPath(skill);
  const stat = await fs.stat(skillFilePath);
  if (!stat.isFile()) {
    return blockedResult("skill_file_not_found", `Skill path is not a file: ${skillFilePath}`);
  }
  if (stat.size > MAX_ACTIVATED_SKILL_BYTES) {
    return blockedResult("skill_too_large", `SKILL.md exceeds ${MAX_ACTIVATED_SKILL_BYTES} bytes.`);
  }

  const content = await fs.readFile(skillFilePath, "utf8");
  const contentHash = sha256(content);
  const loadedSkill = {
    id: skill.id,
    name: skill.name,
    path: skillFilePath,
    content,
    contentHash,
    bytes: Buffer.byteLength(content, "utf8")
  };

  return {
    status: "completed",
    content: JSON.stringify({
      activated: true,
      skillName: skill.name,
      contentHash,
      loadedSkill
    }, null, 2),
    details: {
      activated: true,
      skillName: skill.name,
      contentHash,
      loadedSkill
    }
  };
}

async function loadSkillIndex(skillIndexPath) {
  if (!skillIndexPath) {
    throw new Error("AGENT_TOOL_SKILL_INDEX is not configured.");
  }
  const absolutePath = path.resolve(skillIndexPath);
  const index = JSON.parse(await fs.readFile(absolutePath, "utf8"));
  if (index.schemaVersion !== "agent-skill.index.v1") {
    throw new Error("Skill index schemaVersion must be agent-skill.index.v1.");
  }
  if (!Array.isArray(index.skills)) {
    throw new Error("Skill index skills must be an array.");
  }
  return {
    ...index,
    indexPath: absolutePath,
    skills: index.skills.map(normalizeSkillRecord)
  };
}

function normalizeSkillRecord(skill) {
  return {
    id: stringField(skill.id) ?? stringField(skill.name) ?? "",
    name: stringField(skill.name) ?? stringField(skill.id) ?? "",
    version: stringField(skill.version),
    description: stringField(skill.description) ?? "",
    path: stringField(skill.path) ?? "",
    source: stringField(skill.source) ?? "unknown",
    capabilities: toList(skill.capabilities),
    requiredTools: toList(skill.requiredTools),
    optionalTools: toList(skill.optionalTools),
    requiredEnv: toList(skill.requiredEnv),
    enabled: skill.enabled !== false,
    disabledReason: stringField(skill.disabledReason),
    contentHash: stringField(skill.contentHash),
    bytes: Number.isInteger(skill.bytes) ? skill.bytes : undefined
  };
}

async function resolveIndexedSkillPath(skill) {
  if (!skill.path) {
    throw new Error(`Skill ${skill.name} is missing path.`);
  }
  const skillFilePath = path.resolve(skill.path);
  if (path.basename(skillFilePath).toLowerCase() !== "skill.md") {
    throw new Error(`Skill ${skill.name} path must point to SKILL.md.`);
  }
  const realSkillFile = await fs.realpath(skillFilePath);
  const realSkillDir = await fs.realpath(path.dirname(skillFilePath));
  const relative = path.relative(realSkillDir, realSkillFile);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Skill ${skill.name} path escapes its skill directory.`);
  }
  return realSkillFile;
}

function matchesQuery(skill, query) {
  const haystack = [
    skill.id,
    skill.name,
    skill.description,
    ...toList(skill.capabilities),
    ...toList(skill.requiredTools),
    ...toList(skill.optionalTools)
  ].join("\n").toLowerCase();
  return haystack.includes(query);
}

function toSkillFindItem(skill) {
  return {
    id: skill.id,
    name: skill.name,
    version: skill.version,
    description: skill.description,
    location: skill.path,
    source: skill.source,
    capabilities: skill.capabilities,
    requiredTools: skill.requiredTools,
    optionalTools: skill.optionalTools,
    requiredEnv: skill.requiredEnv,
    enabled: skill.enabled,
    ...(skill.disabledReason ? { disabledReason: skill.disabledReason } : {})
  };
}

function blockedResult(code, message) {
  return {
    status: "blocked",
    content: message,
    details: {
      blocked: true,
      reasonCode: code,
      reason: message
    },
    error: {
      code,
      message
    }
  };
}

function clampLimit(value) {
  const limit = Number.isInteger(value) && value > 0 ? value : DEFAULT_FIND_LIMIT;
  return Math.max(1, Math.min(limit, MAX_FIND_LIMIT));
}

function listIncludes(list, value) {
  return toList(list).includes(value);
}

function toList(value) {
  return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : [];
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}
