import fs from "node:fs/promises";
import path from "node:path";

export function resolveWorkspaceRoot(input, fallback = process.cwd()) {
  return path.resolve(input || fallback);
}

export function resolveInsideWorkspace(workspaceRoot, requestedPath = ".") {
  const root = path.resolve(workspaceRoot);
  const target = path.resolve(root, requestedPath || ".");
  const relative = path.relative(root, target);
  if (relative === "") return { absolutePath: target, relativePath: "." };
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    const error = new Error(`Path escapes workspace: ${requestedPath}`);
    error.code = "workspace_path_denied";
    throw error;
  }
  return {
    absolutePath: target,
    relativePath: relative.split(path.sep).join("/")
  };
}

export async function assertDirectoryExists(directory) {
  const stat = await fs.stat(directory);
  if (!stat.isDirectory()) {
    throw new Error(`Workspace root is not a directory: ${directory}`);
  }
}

export function getWorkspaceRootFromCall(call, config) {
  return resolveWorkspaceRoot(call.workspace?.root, config.workspaceRoot || process.cwd());
}
