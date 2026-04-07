import fs from "node:fs";
import path from "node:path";

import { connect } from "puppeteer-real-browser";

import {
  CancelledError,
  CloudflareError,
  DownloadError,
  ValidationError,
} from "./errors.js";
import {
  ensureWritableDirectory,
  resolveContentRoot,
  sanitizePathSegment,
  saveBinaryFileIfMissing,
  saveTextFileIfMissing,
} from "./output.js";
import { detectSite, getProtocolDomain } from "./sites.js";

const STATUS = {
  IDLE: "idle",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
  PARTIAL: "partial",
};

const OUTPUT_MODES = new Set(["legacy-site-root", "title-root"]);

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parseIndex(rawValue, fallback, fieldLabel) {
  if (rawValue === undefined || rawValue === null || rawValue === "") {
    return fallback;
  }

  const parsedValue = Number.parseInt(rawValue, 10);
  if (Number.isNaN(parsedValue) || parsedValue < 0) {
    throw new ValidationError(`${fieldLabel} 必须是大于等于 0 的整数`);
  }

  return parsedValue;
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new CancelledError();
  }
}

function createLogger(onLog) {
  return (message, level = "info") => {
    if (typeof onLog === "function") {
      onLog({
        timestamp: new Date().toISOString(),
        level,
        message,
      });
    }
  };
}

function emitStatus(onStatus, status, message) {
  if (typeof onStatus === "function") {
    onStatus({
      status,
      message,
      timestamp: new Date().toISOString(),
    });
  }
}

function normalizeError(error) {
  if (error instanceof DownloadError) {
    return error;
  }

  return new DownloadError(error?.message ?? "未知下载错误", "UNEXPECTED_ERROR", error);
}

async function waitForSiteReady(page, site, signal, log) {
  const timeoutMs = 120000;
  const startTime = Date.now();
  let lastLoggedAt = 0;

  while (true) {
    throwIfAborted(signal);

    const pageTitle = await page.title().catch(() => "");
    if (pageTitle.includes(site.titleToken)) {
      return;
    }

    if (Date.now() - startTime > timeoutMs) {
      throw new CloudflareError(`等待 ${site.label} 页面通过验证超时`);
    }

    if (Date.now() - lastLoggedAt > 5000) {
      log("正在等待站点页面可访问，必要时请在辅助浏览器窗口完成验证。");
      lastLoggedAt = Date.now();
    }

    await sleep(500);
  }
}

async function collectChapterLinks(page, request, signal, log) {
  const chapterLinks = [];
  let contentTitle = "";
  let safetyCounter = 0;

  while (true) {
    throwIfAborted(signal);
    safetyCounter += 1;

    if (safetyCounter > 500) {
      throw new DownloadError("分页遍历异常，疑似陷入循环", "PAGINATION_LOOP");
    }

    await page.waitForSelector(request.site.listSelector, { timeout: 40000 });
    await sleep(800);

    const pageData = await page.evaluate(({ listSelector, contentTitleSelector }) => {
      const items = Array.from(document.querySelector(listSelector)?.querySelectorAll("li") ?? [])
        .map((item) => {
          const num = item.querySelector(".wr-num")?.innerText?.trim();
          const anchor = item.querySelector("a");

          if (!num || !anchor) {
            return null;
          }

          return {
            num: num.padStart(4, "0"),
            fileName: anchor.innerHTML.replace(/<span[\s\S]*?\/span>/g, "").trim(),
            src: anchor.href,
          };
        })
        .filter(Boolean);

      const rawTitle =
        document.querySelector(contentTitleSelector)?.innerText?.trim() ||
        document.title ||
        "未命名作品";

      return {
        items,
        contentTitle: rawTitle,
      };
    }, {
      listSelector: request.site.listSelector,
      contentTitleSelector: request.site.contentTitleSelector,
    });

    chapterLinks.push(...pageData.items);
    if (pageData.contentTitle) {
      contentTitle = pageData.contentTitle;
    }

    const nextPageHandle = await page.$(request.site.paginationSelector);
    if (!nextPageHandle) {
      break;
    }

    log(`已收集 ${chapterLinks.length} 个章节，继续读取下一页目录。`);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded" }),
      nextPageHandle.click(),
    ]);
  }

  const filteredChapters = chapterLinks
    .reverse()
    .filter((chapter) => {
      const chapterIndex = Number.parseInt(chapter.num, 10);
      return chapterIndex >= request.startIndex && chapterIndex <= request.lastIndex;
    });

  if (!filteredChapters.length) {
    throw new DownloadError("没有找到符合范围的章节", "EMPTY_CHAPTERS");
  }

  return {
    contentTitle,
    chapters: filteredChapters,
  };
}

async function readBooktokiChapter(page, chapter, summary, log) {
  await page.waitForSelector(summary.site.chapterContentSelector, { timeout: 30000 });

  const chapterText = await page.evaluate((selector) => {
    return document.querySelector(selector)?.innerText ?? "";
  }, summary.site.chapterContentSelector);

  const fileName = `${chapter.num} ${sanitizePathSegment(chapter.fileName, "未命名章节")}.txt`;
  const filePath = path.join(summary.outputDirectory, fileName);

  const saved = saveTextFileIfMissing(filePath, chapterText);
  log(saved ? `已保存文本章节: ${fileName}` : `已跳过已存在章节: ${fileName}`);
}

async function collectImageTargets(page, site) {
  return page.evaluate(({ imageSelector }) => {
    return Array.from(document.querySelectorAll(imageSelector))
      .filter((img) => {
        const style = window.getComputedStyle(img);
        const rect = img.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      })
      .map((img) => {
        const rawPath = img.outerHTML.match(/\/data[^"]+/)?.[0];
        if (!rawPath) {
          return null;
        }

        const cleanPath = rawPath.split("?")[0];
        const extension = cleanPath.match(/\.[a-zA-Z0-9]+$/)?.[0];

        if (!extension) {
          return null;
        }

        return {
          src: rawPath,
          extension,
        };
      })
      .filter(Boolean);
  }, {
    imageSelector: site.chapterImageSelector,
  });
}

async function buildAssetRequestHeaders(page, url) {
  const [cookies, userAgent] = await Promise.all([
    page.cookies(url),
    page.evaluate(() => navigator.userAgent),
  ]);

  const headers = {
    Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
    Referer: page.url(),
    "User-Agent": userAgent,
  };

  if (cookies.length > 0) {
    headers.Cookie = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  }

  return headers;
}

async function fetchBinaryFromPage(page, url) {
  const response = await fetch(url, {
    headers: await buildAssetRequestHeaders(page, url),
  });

  if (!response.ok) {
    throw new Error(`请求资源失败: HTTP ${response.status}`);
  }

  const buffer = await response.arrayBuffer();
  return Buffer.from(buffer);
}

async function readComicChapter(page, chapter, summary, request, log) {
  await page.waitForSelector(summary.site.chapterImageSelector, { timeout: 30000 });
  await sleep(1000);

  const imageTargets = await collectImageTargets(page, summary.site);
  if (!imageTargets.length) {
    throw new DownloadError("未找到可下载图片", "EMPTY_IMAGES");
  }

  log(`检测到 ${imageTargets.length} 张图片。`);

  const chapterFolderName = `${chapter.num} ${sanitizePathSegment(chapter.fileName, "未命名章节")}`;
  const chapterDirectory = path.join(summary.outputDirectory, chapterFolderName);

  for (let index = 0; index < imageTargets.length; index += 1) {
    throwIfAborted(request.signal);

    const image = imageTargets[index];
    const imageUrl = new URL(image.src, request.protocolDomain).href;
    const fileName = `${chapterFolderName} image${String(index).padStart(4, "0")}${image.extension}`;
    const filePath = path.join(chapterDirectory, fileName);

    if (fs.existsSync(filePath)) {
      log(`已跳过已存在图片: ${fileName}`);
      continue;
    }

    const buffer = await fetchBinaryFromPage(page, imageUrl);
    saveBinaryFileIfMissing(filePath, buffer);
  }
}

async function downloadChapter(page, chapter, request, summary, log) {
  await page.goto(chapter.src, { waitUntil: "domcontentloaded" });
  await sleep(1500);

  log(`开始处理 ${chapter.num} ${chapter.fileName}`);

  if (request.site.contentType === "text") {
    await readBooktokiChapter(page, chapter, summary, log);
    return;
  }

  await readComicChapter(page, chapter, summary, request, log);
}

export function parseDownloadRequest(rawOptions = {}) {
  const url = String(rawOptions.url ?? "").trim();
  if (!url) {
    throw new ValidationError("请输入作品目录链接");
  }

  const site = detectSite(url);
  if (!site) {
    throw new ValidationError("链接无效。请输入 BookToki / NewToki / ManaToki 的作品目录页链接。");
  }

  const startIndex = parseIndex(rawOptions.startIndex, 0, "开始章节");
  const lastIndex = parseIndex(rawOptions.lastIndex, Number.MAX_SAFE_INTEGER, "结束章节");

  if (lastIndex < startIndex) {
    throw new ValidationError("结束章节不能小于开始章节");
  }

  const outputMode = rawOptions.outputMode ?? "legacy-site-root";
  if (!OUTPUT_MODES.has(outputMode)) {
    throw new ValidationError(`不支持的输出模式: ${outputMode}`);
  }

  const outputRoot = String(rawOptions.outputRoot ?? process.cwd()).trim();
  if (!outputRoot) {
    throw new ValidationError("输出目录不能为空");
  }

  return {
    url,
    site,
    startIndex,
    lastIndex,
    outputRoot,
    outputMode,
    protocolDomain: getProtocolDomain(site, url),
    signal: rawOptions.signal,
    onLog: rawOptions.onLog,
    onStatus: rawOptions.onStatus,
  };
}

export async function downloadSeries(rawOptions = {}) {
  const request = parseDownloadRequest(rawOptions);
  const log = createLogger(request.onLog);
  const summary = {
    site: request.site,
    contentTitle: "",
    outputDirectory: "",
    totalChapters: 0,
    completedChapters: 0,
    failedChapters: 0,
    failures: [],
    finalStatus: STATUS.IDLE,
  };

  let browser;
  let page;

  const abortListener = async () => {
    log("收到取消请求，正在关闭浏览器。", "warn");
    await browser?.close().catch(() => {});
  };

  if (request.signal) {
    request.signal.addEventListener("abort", abortListener, { once: true });
  }

  try {
    throwIfAborted(request.signal);
    ensureWritableDirectory(request.outputRoot);
    emitStatus(request.onStatus, STATUS.RUNNING, "正在启动浏览器");

    ({ browser, page } = await connect({
      headless: false,
      args: [],
      customConfig: {},
      turnstile: true,
      connectOption: { defaultViewport: null },
      disableXvfb: false,
    }));

    log("浏览器已启动。");
    log("如果出现验证页面，请在辅助浏览器窗口中完成验证。", "warn");

    await page.goto(request.url, { waitUntil: "domcontentloaded" });
    await waitForSiteReady(page, request.site, request.signal, log);

    const { contentTitle, chapters } = await collectChapterLinks(page, request, request.signal, log);

    summary.contentTitle = sanitizePathSegment(contentTitle, "未命名作品");
    summary.outputDirectory = resolveContentRoot({
      outputMode: request.outputMode,
      outputRoot: request.outputRoot,
      site: request.site,
      contentTitle: summary.contentTitle,
    });
    summary.totalChapters = chapters.length;

    ensureWritableDirectory(summary.outputDirectory);
    log(`输出目录: ${summary.outputDirectory}`);
    log(`本次计划下载 ${summary.totalChapters} 个章节。`);

    for (const chapter of chapters) {
      throwIfAborted(request.signal);

      try {
        await downloadChapter(page, chapter, request, summary, log);
        summary.completedChapters += 1;
      } catch (error) {
        const normalizedError = normalizeError(error);
        if (request.signal?.aborted) {
          throw new CancelledError();
        }
        if (normalizedError instanceof CancelledError) {
          throw normalizedError;
        }

        summary.failedChapters += 1;
        summary.failures.push({
          chapter: `${chapter.num} ${chapter.fileName}`,
          message: normalizedError.message,
          code: normalizedError.code,
        });
        log(`章节失败: ${chapter.num} ${chapter.fileName} - ${normalizedError.message}`, "error");
      }
    }

    if (summary.failedChapters > 0 && summary.completedChapters > 0) {
      summary.finalStatus = STATUS.PARTIAL;
      emitStatus(request.onStatus, STATUS.PARTIAL, "部分章节下载失败");
    } else if (summary.failedChapters > 0 && summary.completedChapters === 0) {
      summary.finalStatus = STATUS.FAILED;
      emitStatus(request.onStatus, STATUS.FAILED, "下载失败");
    } else {
      summary.finalStatus = STATUS.COMPLETED;
      emitStatus(request.onStatus, STATUS.COMPLETED, "下载完成");
    }

    return summary;
  } catch (error) {
    const normalizedError = normalizeError(error);

    if (normalizedError instanceof CancelledError) {
      summary.finalStatus = STATUS.CANCELLED;
      emitStatus(request.onStatus, STATUS.CANCELLED, "下载已取消");
    } else {
      summary.finalStatus = STATUS.FAILED;
      emitStatus(request.onStatus, STATUS.FAILED, normalizedError.message);
    }

    normalizedError.summary = summary;
    throw normalizedError;
  } finally {
    request.signal?.removeEventListener("abort", abortListener);
    await browser?.close().catch(() => {});
  }
}

export { STATUS };
