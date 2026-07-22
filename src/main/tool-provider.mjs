/**
 * 【文件说明】
 * 本文件定义 AgentTool 聚合外部工具能力时使用的最小 Provider 合同。
 *
 * AgentTool 本身负责统一的模型 schema、工具选择、结果压缩和 HTTP transport；
 * 复杂能力 brick 只需作为 Provider 提供受控工具描述和 execute 方法。这样
 * AgentCli 始终只注入一个 AgentTool，不需要知道图表、PPT 等能力的内部实现。
 */

/**
 * 规范化外部 Tool Provider，并在构造阶段尽早发现会让模型工具合同不确定的错误。
 * 每个 provider 必须拥有稳定 id、toolDescriptors 和 execute(name, args, context)。
 */
export function normalizeToolProviders(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new TypeError("toolProviders 必须是数组。");
  }

  const providers = [];
  const providerIds = new Set();
  const toolNames = new Set();

  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new TypeError("toolProviders 中的每一项必须是对象。");
    }
    const id = String(candidate.id ?? candidate.definition?.id ?? "").trim();
    if (!id) throw new TypeError("Tool Provider 必须提供稳定 id。");
    if (providerIds.has(id)) throw new Error(`重复的 Tool Provider id: ${id}`);
    if (typeof candidate.execute !== "function") {
      throw new TypeError(`Tool Provider ${id} 必须提供 execute(name, args, context)。`);
    }

    const descriptors = normalizeToolDescriptors(candidate.toolDescriptors ?? candidate.tools ?? candidate.definitions, id);
    for (const descriptor of descriptors) {
      if (toolNames.has(descriptor.name)) {
        throw new Error(`多个 Tool Provider 声明了同名工具: ${descriptor.name}`);
      }
      toolNames.add(descriptor.name);
    }
    providerIds.add(id);
    providers.push({
      id,
      provider: candidate,
      descriptors
    });
  }

  return providers;
}

/**
 * 将 provider 的公开描述规范为 AgentTool manifest 可消费的结构。
 * 兼容只提供 OpenAI schema 的旧对象，但新 Provider 应提供完整 descriptor，
 * 以便声明权限、超时与取消能力。
 */
export function normalizeToolDescriptors(value, providerId = "provider") {
  if (!Array.isArray(value)) {
    throw new TypeError(`Tool Provider ${providerId} 的 toolDescriptors 必须是数组。`);
  }

  const names = new Set();
  return value.map((raw, index) => {
    const schema = raw?.schema ?? raw;
    const name = String(raw?.name ?? schema?.function?.name ?? "").trim();
    if (!name) throw new TypeError(`Tool Provider ${providerId} 的第 ${index + 1} 个工具缺少 name。`);
    if (!schema || typeof schema !== "object" || schema.type !== "function" || schema.function?.name !== name) {
      throw new TypeError(`Tool Provider ${providerId} 的工具 ${name} 必须提供 OpenAI-compatible function schema。`);
    }
    if (names.has(name)) throw new Error(`Tool Provider ${providerId} 重复声明工具: ${name}`);
    names.add(name);
    return {
      name,
      description: String(raw?.description ?? schema.function.description ?? "").trim(),
      schema,
      permissions: Array.isArray(raw?.permissions) ? [...raw.permissions] : [],
      timeoutMs: normalizePositiveInteger(raw?.timeoutMs, 120_000),
      cancelable: raw?.cancelable === true,
      defaultVisible: raw?.defaultVisible === true,
      providerId
    };
  });
}

/**
 * 当前 SDK 只允许同步可用性判断，确保 AgentTool.definitions 保持同步 getter。
 * Provider 可根据注入的 runtimeDependencies 返回 { available, reason }，避免把
 * 明知无法执行的工具暴露给模型。
 */
export function getProviderToolAvailability(providerEntry, descriptor) {
  const check = providerEntry?.provider?.getToolAvailability;
  if (typeof check !== "function") return { available: true };
  const result = check.call(providerEntry.provider, descriptor.name);
  if (result === false) return { available: false, reason: "provider_unavailable" };
  if (!result || typeof result !== "object") return { available: true };
  return {
    available: result.available !== false,
    reason: typeof result.reason === "string" ? result.reason : undefined
  };
}

export function isToolRequested(name, selectedTools, defaultVisible = true) {
  if (selectedTools === undefined) return defaultVisible;
  return selectedTools.has(name);
}

export function normalizeSelectedTools(value) {
  if (value === undefined) return undefined;
  // AgentTool 内部会把公开数组预先规范成 Set，再传给 registry；这里同时
  // 接受两种形态，避免同一份白名单在内部边界被重复解析而失效。
  if (value instanceof Set) {
    return normalizeSelectedTools([...value]);
  }
  if (!Array.isArray(value)) throw new TypeError("tools 必须是字符串数组。");
  const names = new Set();
  for (const item of value) {
    if (typeof item !== "string" || !item.trim()) {
      throw new TypeError("tools 中的每个工具名必须是非空字符串。");
    }
    names.add(item.trim());
  }
  return names;
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
