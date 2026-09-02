/**
 * npm 的 files 白名单包含整个 src/main，显式列入的目录不会再被 .npmignore
 * 可靠排除。发布前只清理 Python 语法检查生成的缓存，避免把本机字节码打入 SDK。
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
for (const relativePath of ["src/main/__pycache__", "src/scripts/__pycache__"]) {
  const target = path.join(repoRoot, ...relativePath.split("/"));
  const relative = path.relative(repoRoot, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`拒绝清理仓库之外的路径: ${target}`);
  }
  await fs.rm(target, { recursive: true, force: true });
}
