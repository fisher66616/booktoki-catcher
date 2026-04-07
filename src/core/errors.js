export class DownloadError extends Error {
  constructor(message, code = "DOWNLOAD_ERROR", cause = null) {
    super(message);
    this.name = "DownloadError";
    this.code = code;
    this.cause = cause;
  }
}

export class ValidationError extends DownloadError {
  constructor(message, cause = null) {
    super(message, "VALIDATION_ERROR", cause);
    this.name = "ValidationError";
  }
}

export class OutputError extends DownloadError {
  constructor(message, cause = null) {
    super(message, "OUTPUT_ERROR", cause);
    this.name = "OutputError";
  }
}

export class CloudflareError extends DownloadError {
  constructor(message, cause = null) {
    super(message, "CLOUDFLARE_ERROR", cause);
    this.name = "CloudflareError";
  }
}

export class CancelledError extends DownloadError {
  constructor(message = "下载已取消", cause = null) {
    super(message, "CANCELLED", cause);
    this.name = "CancelledError";
  }
}

export class BlockedError extends DownloadError {
  constructor(message = "检测到疑似验证页或封禁，已停止后续抓取", cause = null) {
    super(message, "SUSPECTED_BLOCK", cause);
    this.name = "BlockedError";
  }
}
