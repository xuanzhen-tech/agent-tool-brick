/**
 * agent-tool 模块共享的轻量环境变量解析工具。
 *
 * 把 trim、boolean 和数字 fallback 逻辑集中在这里，可以避免启动配置、
 * 工具定义和运行时 adapter 里反复实现同一套转换。
 */

export function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

export function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  return fallback;
}

export function stringField(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function numberField(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
