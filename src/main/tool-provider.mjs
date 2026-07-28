/**
 * AgentTool 外部 Provider 合同。
 *
 * Provider 可以继续提供静态 toolDescriptors，也可以提供同步
 * getToolDescriptors()。动态描述会在每次模型 schema 读取和工具执行前重新解析，
 * 使 MCP 注册、启停和删除无需重建 AgentTool 或 AgentCli。
 */

export function normalizeToolProviders(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError("toolProviders 必须是数组。");

  const providers = [];
  const providerIds = new Set();
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

    const dynamic = typeof candidate.getToolDescriptors === "function";
    const descriptors = dynamic
      ? normalizeOptionalStaticDescriptors(candidate, id)
      : normalizeToolDescriptors(candidate.toolDescriptors ?? candidate.tools ?? candidate.definitions, id);
    providerIds.add(id);
    providers.push({ id, provider: candidate, descriptors, dynamic });
  }
  return providers;
}

/**
 * 同步读取一个 Provider 的当前工具描述。
 *
 * AgentTool.definitions 是同步 getter，因此动态 Provider 不允许返回 Promise；
 * 需要远端目录的 Provider 应在 initialize/register 阶段预先更新内存状态。
 */
export function getProviderToolDescriptors(providerEntry) {
  if (!providerEntry?.dynamic) return providerEntry?.descriptors ?? [];
  const value = providerEntry.provider.getToolDescriptors();
  if (value && typeof value.then === "function") {
    throw new TypeError(`Tool Provider ${providerEntry.id} 的 getToolDescriptors() 不能返回 Promise。`);
  }
  return normalizeToolDescriptors(value, providerEntry.id);
}

/**
 * 解析全部 Provider 的当前描述并检查跨 Provider、内置工具重名。
 */
export function resolveProviderToolDescriptors(providerEntries, input = {}) {
  const reservedNames = input.reservedNames ?? new Set();
  const names = new Set();
  const resolved = [];
  for (const providerEntry of providerEntries ?? []) {
    const descriptors = getProviderToolDescriptors(providerEntry);
    for (const descriptor of descriptors) {
      if (reservedNames.has(descriptor.name)) {
        throw new Error(`Tool Provider ${providerEntry.id} 不能覆盖内置工具: ${descriptor.name}`);
      }
      if (names.has(descriptor.name)) {
        throw new Error(`多个 Tool Provider 声明了同名工具: ${descriptor.name}`);
      }
      names.add(descriptor.name);
      resolved.push({ providerEntry, descriptor });
    }
  }
  return resolved;
}

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

export function getProviderToolAvailability(providerEntry, descriptor) {
  const check = providerEntry?.provider?.getToolAvailability;
  if (typeof check !== "function") return { available: true };
  const result = check.call(providerEntry.provider, descriptor.name);
  if (result && typeof result.then === "function") {
    throw new TypeError(`Tool Provider ${providerEntry.id} 的 getToolAvailability() 不能返回 Promise。`);
  }
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
  if (value instanceof Set) return normalizeSelectedTools([...value]);
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

function normalizeOptionalStaticDescriptors(candidate, providerId) {
  const own = Object.getOwnPropertyDescriptor(candidate, "toolDescriptors");
  if (!own || !Object.hasOwn(own, "value") || own.value === undefined) return [];
  return normalizeToolDescriptors(own.value, providerId);
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
