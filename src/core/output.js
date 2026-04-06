import fs from "node:fs";
import path from "node:path";

import { OutputError, ValidationError } from "./errors.js";

const INVALID_SEGMENT_PATTERN = /[<>:"/\\|?*\x00-\x1F]/g;

export function sanitizePathSegment(value, fallback = "unnamed") {
  const sanitized = String(value ?? "")
    .replace(INVALID_SEGMENT_PATTERN, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.+$/g, "");

  return sanitized || fallback;
}

export function ensureWritableDirectory(directoryPath) {
  try {
    fs.mkdirSync(directoryPath, { recursive: true });
    fs.accessSync(directoryPath, fs.constants.W_OK);
  } catch (error) {
    throw new OutputError(`输出目录不可写: ${directoryPath}`, error);
  }
}

export function resolveContentRoot({
  outputMode,
  outputRoot,
  site,
  contentTitle,
}) {
  if (!outputRoot) {
    throw new ValidationError("缺少输出目录");
  }

  const safeTitle = sanitizePathSegment(contentTitle, "未命名作品");

  if (outputMode === "legacy-site-root") {
    return path.join(outputRoot, site.outputFolderName, safeTitle);
  }

  if (outputMode === "title-root") {
    return path.join(outputRoot, safeTitle);
  }

  throw new ValidationError(`不支持的输出模式: ${outputMode}`);
}

export function saveTextFileIfMissing(filePath, content) {
  if (fs.existsSync(filePath)) {
    return false;
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
  return true;
}

export function saveBinaryFileIfMissing(filePath, buffer) {
  if (fs.existsSync(filePath)) {
    return false;
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buffer);
  return true;
}
