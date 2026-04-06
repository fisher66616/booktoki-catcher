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
