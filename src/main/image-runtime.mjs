/**
 * 【文件说明】
 * 本文件实现通用图片呈递工具。
 *
 * AgentTool 只读取当前 workspace 内的图片并生成受控 artifact。它不调用视觉
 * provider，也不把图片转成文字描述；当前 Agent 模型是否能原生看图由 AgentCli
 * 根据 Gateway 的模型能力目录决定。
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MIME_BY_EXTENSION = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"]
]);

export function isImagePresentAvailable() {
  return { available: true, detail: "image_present 在本地校验并呈递 workspace 图片。" };
}

export async function executeImagePresent(call, config, signal) {
  throwIfAborted(signal);
  const input = normalizeImagePresentInput(call.arguments ?? {});
  const workspace = resolveWorkspace(call);
  const image = await readWorkspaceImage({ workspace, requestedPath: input.path });
  throwIfAborted(signal);

  const artifact = createImagePresentArtifact({ image });

  return {
    status: "completed",
    content: [
      "图片已呈递给用户。",
      `图片：${image.workspacePath}`,
      "如果当前模型支持原生视觉输入，AgentCli 会仅在紧随的下一次模型请求中附上该图片；本工具不会生成图片文字描述。"
    ].join("\n"),
    details: {
      imagePresent: {
        path: image.workspacePath,
        mimeType: image.mimeType,
        bytes: image.bytes,
        contentHash: image.contentHash
      }
    },
    artifacts: [artifact]
  };
}

function normalizeImagePresentInput(input) {
  if (!isRecord(input)) throw invalidInput("image_present 参数必须是对象。");
  const imagePath = normalizeNonEmptyText(input.path);
  if (!imagePath) throw invalidInput("image_present 需要 path。");
  return {
    path: imagePath
  };
}

function resolveWorkspace(call) {
  const workspace = call?.workspace?.root;
  if (typeof workspace !== "string" || !workspace.trim()) {
    throw invalidInput("image_present 需要调用方提供绝对 workspace 路径。");
  }
  return path.resolve(workspace);
}

async function readWorkspaceImage({ workspace, requestedPath }) {
  const absolutePath = resolveInsideWorkspace(workspace, requestedPath);
  const extension = path.extname(absolutePath).toLowerCase();
  const mimeType = MIME_BY_EXTENSION.get(extension);
  if (!mimeType) {
    throw invalidInput("image_present 只支持 PNG、JPEG 和 WebP 图片。");
  }
  const buffer = await fs.readFile(absolutePath).catch((error) => {
    throw invalidInput(`无法读取图片文件：${formatError(error)}`);
  });
  if (!buffer.byteLength) throw invalidInput("图片文件为空。");
  if (buffer.byteLength > MAX_IMAGE_BYTES) throw invalidInput("图片超过 10MB，无法呈递。");
  const workspacePath = toWorkspacePath(workspace, absolutePath);
  return {
    absolutePath,
    workspacePath,
    mimeType,
    buffer,
    bytes: buffer.byteLength,
    contentHash: crypto.createHash("sha256").update(buffer).digest("hex")
  };
}

// 图片必须来自当前 workspace；绝对路径也要经过同一边界校验，避免模型读取任意本机文件。
function resolveInsideWorkspace(workspace, requestedPath) {
  const raw = String(requestedPath ?? "").trim();
  if (!raw || raw.includes("\0")) throw invalidInput("图片路径无效。");
  const absolutePath = path.isAbsolute(raw)
    ? path.resolve(raw)
    : path.resolve(workspace, raw);
  const relative = path.relative(workspace, absolutePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw invalidInput("图片路径必须位于当前 workspace 内。");
  }
  return absolutePath;
}

function createImagePresentArtifact({ image }) {
  const id = `image-present-${image.contentHash.slice(0, 12)}`;
  return {
    schemaVersion: "agent-output.v1",
    kind: "image",
    renderer: "image-present",
    id,
    title: `图片呈递：${path.basename(image.workspacePath)}`,
    files: [{
      path: image.workspacePath,
      mimeType: image.mimeType,
      bytes: image.bytes
    }],
    data: {
      schemaVersion: "agent-image-present.v2",
      path: image.workspacePath,
      mimeType: image.mimeType,
      bytes: image.bytes,
      contentHash: image.contentHash
    }
  };
}

function toWorkspacePath(workspace, absolutePath) {
  return path.relative(workspace, absolutePath).replaceAll(path.sep, "/");
}

function normalizeNonEmptyText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function invalidInput(message) {
  const error = new Error(message);
  error.code = "invalid_image_present_input";
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new Error(String(signal.reason ?? "图片呈递任务已取消。"));
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}
