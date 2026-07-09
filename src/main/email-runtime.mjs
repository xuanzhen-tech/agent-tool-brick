/**
 * email_send 工具运行时。
 *
 * AgentTool 只负责校验模型参数、限制本地附件读取范围，然后把邮件发送请求
 * 转发到 server tool gateway。SMTP host/user/password 只存在服务器环境变量中。
 */

import fs from "node:fs/promises";
import path from "node:path";

import { stringField } from "./env.mjs";
import { isServerToolGatewayAvailable, postServerToolGatewayJson } from "./server-tool-gateway.mjs";

const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export function isEmailProviderAvailable(config) {
  const gateway = isServerToolGatewayAvailable(config);
  if (!gateway.available) return gateway;
  return {
    available: true,
    detail: `${gateway.detail}; server-side SMTP configuration is checked at call time.`
  };
}

export async function executeEmailSend(call, config, signal) {
  const validation = validateEmailArgs(call.arguments);
  if (validation) return blockedResult(validation.code, validation.message);

  try {
    const workspaceRoot = path.resolve(call.workspace?.root ?? config.workspaceRoot ?? process.cwd());
    const attachments = await resolveAttachments(call.arguments.attachments ?? [], workspaceRoot);
    const body = await postServerToolGatewayJson(config, "/api/tools/email/send", {
      to: call.arguments.to,
      cc: call.arguments.cc,
      bcc: call.arguments.bcc,
      subject: call.arguments.subject,
      text: call.arguments.text,
      html: call.arguments.html,
      attachments
    }, signal);
    const details = {
      ok: body.ok === true,
      messageId: typeof body.messageId === "string" ? body.messageId : "",
      accepted: Array.isArray(body.accepted) ? body.accepted : [],
      rejected: Array.isArray(body.rejected) ? body.rejected : [],
      attachmentCount: Number.isInteger(body.attachmentCount) ? body.attachmentCount : attachments.length
    };
    return {
      status: "completed",
      content: JSON.stringify(details, null, 2),
      details
    };
  } catch (error) {
    return failedResult(readErrorCode(error) ?? "email_send_failed", formatError(error));
  }
}

function validateEmailArgs(args = {}) {
  if (!normalizeAddressList(args.to).length) {
    return { code: "email_recipient_required", message: "email_send requires at least one to recipient." };
  }
  if (!stringField(args.subject)) {
    return { code: "email_subject_required", message: "email_send requires subject." };
  }
  if (!stringField(args.text) && !stringField(args.html)) {
    return { code: "email_body_required", message: "email_send requires text or html." };
  }
  return undefined;
}

async function resolveAttachments(inputs, workspaceRoot) {
  if (!Array.isArray(inputs) || inputs.length === 0) return [];
  if (inputs.length > MAX_ATTACHMENTS) throw createError("too_many_attachments", `email_send supports at most ${MAX_ATTACHMENTS} attachments.`);
  const attachments = [];
  let totalBytes = 0;
  for (const input of inputs) {
    const record = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    const rawPath = stringField(record.path);
    if (!rawPath) throw createError("invalid_attachment", "Attachment path is required.");
    const resolvedPath = resolveWorkspaceFile(rawPath, workspaceRoot);
    const stat = await fs.stat(resolvedPath).catch(() => undefined);
    if (!stat) throw createError("attachment_not_found", `Attachment not found: ${path.basename(rawPath)}`);
    if (!stat.isFile()) throw createError("invalid_attachment", `Attachment must be a file: ${path.basename(rawPath)}`);
    if (stat.size > MAX_ATTACHMENT_BYTES) throw createError("attachment_too_large", "Attachment exceeds the 10MB per-file limit.");
    totalBytes += stat.size;
    if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) throw createError("attachments_too_large", "Attachments exceed the 20MB total limit.");
    const content = await fs.readFile(resolvedPath);
    attachments.push({
      filename: stringField(record.filename) ?? path.basename(resolvedPath),
      contentBase64: content.toString("base64"),
      contentType: stringField(record.contentType)
    });
  }
  return attachments;
}

function resolveWorkspaceFile(inputPath, workspaceRoot) {
  const resolved = path.resolve(workspaceRoot, inputPath);
  const relative = path.relative(workspaceRoot, resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw createError("attachment_path_forbidden", `Attachment must be inside the workspace: ${path.basename(inputPath)}`);
  }
  return resolved;
}

function normalizeAddressList(value) {
  const items = Array.isArray(value) ? value : value ? [value] : [];
  return items.map((item) => String(item).trim()).filter(Boolean);
}

function blockedResult(code, message) {
  return {
    status: "blocked",
    content: message,
    details: { blocked: true, reasonCode: code, reason: message },
    error: { code, message }
  };
}

function failedResult(code, message) {
  return {
    status: "failed",
    content: message,
    details: { failed: true, reasonCode: code, reason: message },
    error: { code, message }
  };
}

function createError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function readErrorCode(error) {
  return typeof error?.code === "string" ? error.code : undefined;
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}
