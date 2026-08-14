/**
 * Skill 删除工具的受控适配层。
 *
 * 本模块只允许模型删除当前 AgentSkill 索引中真实可见的 Skill，并把实际删除
 * 委托给 AgentSkill.remove()。它不接收文件路径，也不直接操作受管目录。
 */

/**
 * 校验删除意图并委托当前 AgentSkill 删除已登记 Skill。
 */
export async function executeSkillRemove(skillRuntime, call, signal) {
  assertNotAborted(signal);
  if (typeof skillRuntime?.remove !== "function") {
    throw new Error("Injected AgentSkill runtime does not support remove().");
  }

  const input = normalizeRemoveInput(call?.arguments);
  const context = createSkillContext(call, signal);
  if (typeof skillRuntime.refresh === "function") {
    await skillRuntime.refresh(context);
  }
  assertNotAborted(signal);

  const target = findIndexedSkill(skillRuntime.definitions, input.skill);
  if (!target) {
    throw new Error(`skill_remove can only remove a currently indexed skill: ${input.skill}`);
  }

  const result = await skillRuntime.remove(target.name ?? target.id, {
    signal,
    reason: input.reason
  });

  return {
    removed: result?.removed === true,
    skillId: target.id ?? target.name,
    skillName: target.name ?? target.id,
    installationRemoved: Boolean(result?.installation),
    selectionScope: "current_agent_skill_instance",
    guidance: "Skill 已从当前 AgentSkill 受管目录和当前实例选择中移除。若产品配置仍显式选择同名预制 Skill，下次创建 AgentSkill 时可能重新安装；产品需要同步更新自己的 Skill 白名单。"
  };
}

function normalizeRemoveInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("skill_remove arguments must be an object.");
  }
  const skill = requireString(value.skill, "skill_remove skill");
  if (value.confirm !== true) {
    throw new Error("skill_remove requires confirm=true after the user explicitly requests deletion.");
  }
  return {
    skill,
    reason: optionalSingleLine(value.reason, "skill_remove reason")
  };
}

function findIndexedSkill(definitions, requested) {
  if (!Array.isArray(definitions)) return undefined;
  const normalized = requested.toLowerCase();
  return definitions.find((skill) => (
    String(skill?.id ?? "").toLowerCase() === normalized
    || String(skill?.name ?? "").toLowerCase() === normalized
  ));
}

function createSkillContext(call, signal) {
  return {
    workspace: call?.workspace?.root ?? call?.workspace,
    signal
  };
}

function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required.`);
  }
  return value.trim();
}

function optionalSingleLine(value, label) {
  if (value === undefined) return undefined;
  const normalized = requireString(value, label);
  if (/\r|\n/u.test(normalized)) throw new Error(`${label} must be a single line.`);
  return normalized;
}

function assertNotAborted(signal) {
  if (signal?.aborted) throw signal.reason ?? new Error("skill_remove was interrupted.");
}
