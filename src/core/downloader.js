import fs from "node:fs";
import path from "node:path";

import { connect } from "puppeteer-real-browser";

import {
  BlockedError,
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
import { createPageStability, resolvePageStabilityConfig } from "./page-stability.js";
import { buildPerformanceMetrics, createReport, persistReport } from "./report.js";
import {
  createScheduler,
  DEFAULT_SCHEDULER_PRESET,
  resolveSchedulerConfig,
} from "./scheduler.js";
import {
  buildManifestOverview,
  CHAPTER_STATUS,
  countManifestStats,
  createManifest,
  findChapterByKey,
  getNextTailChapter,
  getQueuedChapters,
  loadManifest,
  loadManifestOverview,
  persistManifest,
  prepareManifestForResumeMissing,
  prepareManifestForResumeTail,
  RESUME_DISPOSITION,
  resolveSessionPaths,
} from "./session-manifest.js";
import { detectSite, getProtocolDomain, getSiteDefinitionByKey } from "./sites.js";

const STATUS = {
  IDLE: "idle",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
  PARTIAL: "partial",
  BLOCKED: "blocked",
};

const PHASE = {
  STARTUP_VERIFICATION: "startup-verification",
  READING_DIRECTORY: "reading-directory",
  DOWNLOADING: "downloading",
  RUNTIME_BLOCKED: "runtime-blocked",
  STARTUP_VERIFICATION_TIMEOUT: "startup-verification-timeout",
};

const FAILURE_STAGE = {
  STARTUP_VERIFICATION_TIMEOUT: "startup-verification-timeout",
  RUNTIME_BLOCKED: "runtime-blocked",
};

const RESUME_DISPOSITION_MESSAGES = {
  [RESUME_DISPOSITION.STARTED]: "已开始恢复任务",
  [RESUME_DISPOSITION.ALREADY_AT_TAIL]: "主线已完成，可改用补漏章节",
  [RESUME_DISPOSITION.ALREADY_COMPLETE]: "已无可继续章节",
};

const OUTPUT_MODES = new Set(["legacy-site-root", "title-root"]);
const BLOCK_HINTS = [
  "just a moment",
  "checking",
  "verifying",
  "please wait",
  "잠시만",
  "사람인지 확인",
  "cloudflare",
  "attention required",
  "access denied",
];
const RUNTIME_EXCEPTION_HINTS = ["challenge", "forbidden", "blocked"];
const STARTUP_WAIT_LOG_INTERVAL_MS = 5000;
const TRANSIENT_NAVIGATION_ERROR_HINTS = [
  "Execution context was destroyed",
  "Cannot find context with specified id",
  "Most likely the page has been closed",
  "Frame was detached",
  "Navigating frame was detached",
];

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

function emitStatus(onStatus, status, message, extra = {}) {
  if (typeof onStatus === "function") {
    onStatus({
      status,
      message,
      ...extra,
      timestamp: new Date().toISOString(),
    });
  }
}

function emitProgress(onProgress, payload) {
  if (typeof onProgress === "function") {
    onProgress({
      ...payload,
      timestamp: new Date().toISOString(),
    });
  }
}

function toDurationMs(startedAt, endedAt) {
  if (!startedAt || !endedAt) {
    return null;
  }

  const start = new Date(startedAt).getTime();
  const end = new Date(endedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return null;
  }

  return end - start;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) {
    return "未统计";
  }

  if (ms < 1000) {
    return `${ms}ms`;
  }

  if (ms < 60000) {
    return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}秒`;
  }

  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return `${minutes}分${seconds}秒`;
}

function formatSpeed(chaptersPerMinute) {
  if (!Number.isFinite(chaptersPerMinute)) {
    return "未统计";
  }

  return `${chaptersPerMinute.toFixed(2)} 章/分钟`;
}

function normalizeError(error) {
  if (error instanceof DownloadError) {
    return error;
  }

  return new DownloadError(error?.message ?? "未知下载错误", "UNEXPECTED_ERROR", error);
}

function isTransientNavigationError(error) {
  const message = String(error?.message ?? "");
  return TRANSIENT_NAVIGATION_ERROR_HINTS.some((hint) => message.includes(hint));
}

function buildProgressPayload(
  manifest,
  currentStatus,
  paths,
  {
    phase = null,
    blockedReason = null,
    failureStage = null,
    failureReason = null,
    resumeDisposition = RESUME_DISPOSITION.STARTED,
  } = {},
) {
  const counts = countManifestStats(manifest);
  const overview = buildManifestOverview(manifest);

  return {
    novelTitle: manifest.novelTitle,
    totalChapters: counts.total,
    successCount: counts.success,
    failedCount: counts.failed,
    blockedCount: counts.blocked,
    missingCount: counts.missing,
    currentStatus,
    phase,
    failureStage,
    failureReason,
    resumeDisposition,
    blockedReason: blockedReason ?? manifest.blockedReason ?? null,
    latestSuccessOrder: overview.latestSuccessOrder,
    latestSuccessChapterKey: overview.latestSuccessChapterKey,
    latestSuccessLabel: overview.latestSuccessLabel,
    nextForwardOrder: overview.nextForwardOrder,
    nextForwardChapterKey: overview.nextForwardChapterKey,
    nextForwardLabel: overview.nextForwardLabel,
    missingChapterKeys: overview.missingChapterKeys,
    runKind: overview.runKind,
    lastRunMode: overview.lastRunMode,
    sessionDirectory: paths?.sessionDirectory ?? null,
    manifestPath: paths?.manifestPath ?? null,
    reportPath: paths?.reportPath ?? null,
  };
}

function persistManifestAndProgress(
  paths,
  manifest,
  request,
  currentStatus,
  runtimeMeta = {},
) {
  persistManifest(paths, manifest);
  emitProgress(
    request.onProgress,
    buildProgressPayload(manifest, currentStatus, paths, runtimeMeta),
  );
}

async function readPageSnapshot(page, selectors = []) {
  const uniqueSelectors = [...new Set(selectors.filter(Boolean))];
  const [title, snapshot] = await Promise.all([
    page.title().catch(() => ""),
    page.evaluate((selectorList) => {
      const selectorMatches = Object.fromEntries(
        selectorList.map((selector) => [selector, Boolean(document.querySelector(selector))]),
      );

      return {
        bodyText: document.body?.innerText?.slice(0, 4000) ?? "",
        html: document.documentElement?.outerHTML?.slice(0, 4000) ?? "",
        selectorMatches,
      };
    }, uniqueSelectors),
  ]);

  return {
    title,
    ...snapshot,
  };
}

function combinedSnapshotText(snapshot) {
  return `${snapshot.title}\n${snapshot.bodyText}\n${snapshot.html}`.toLowerCase();
}

function matchesBlockKeyword(snapshot) {
  const combined = combinedSnapshotText(snapshot);
  return BLOCK_HINTS.find((keyword) => combined.includes(keyword)) ?? null;
}

function hasAnySelector(snapshot, selectors = []) {
  return selectors.some((selector) => snapshot.selectorMatches?.[selector] === true);
}

function hasSiteSignal(snapshot, site) {
  return `${snapshot.title}\n${snapshot.bodyText}`.includes(site.titleToken);
}

function matchRuntimeBlockReason(snapshot, site, selectors = []) {
  const matchedKeyword = matchesBlockKeyword(snapshot);
  if (matchedKeyword) {
    return `页面包含疑似验证/封禁提示: ${matchedKeyword}`;
  }

  const combined = combinedSnapshotText(snapshot);
  if (
    selectors.length > 0 &&
    hasAnySelector(snapshot, selectors) === false &&
    hasSiteSignal(snapshot, site) === false &&
    RUNTIME_EXCEPTION_HINTS.some((keyword) => combined.includes(keyword))
  ) {
    return "章节选择器缺失，且页面明显不是正常章节页";
  }

  return null;
}

async function detectRuntimeBlockReason(page, site, selectors = []) {
  const snapshot = await readPageSnapshot(page, selectors);
  return matchRuntimeBlockReason(snapshot, site, selectors);
}

function buildStartupIdentifier(request) {
  const url = new URL(request.url);
  const tail = sanitizePathSegment(
    url.pathname
      .split("/")
      .filter(Boolean)
      .slice(-2)
      .join("-"),
    "entry",
  );
  return `${request.site.key}-${tail}`;
}

function resolveStartupFailureOutputDirectory(request) {
  const identifier = buildStartupIdentifier(request);

  if (request.outputMode === "legacy-site-root") {
    return path.join(request.outputRoot, request.site.outputFolderName, "_startup", identifier);
  }

  return path.join(request.outputRoot, "_startup", identifier);
}

function createPreManifestFailureSession(request) {
  const outputDirectory = resolveStartupFailureOutputDirectory(request);
  const sessionPaths = resolveSessionPaths(outputDirectory);
  const manifest = createManifest({
    novelTitle: `_startup_${buildStartupIdentifier(request)}`,
    sourceUrl: request.url,
    sourceSite: request.site.key,
    schedulerPreset: request.schedulerPreset,
    schedulerConfig: request.schedulerConfig,
    chapters: [],
    runKind: request.mode === "resume-missing" ? "resume-missing" : "initial",
  });

  return {
    outputDirectory,
    sessionPaths,
    manifest,
  };
}

function buildStartupGate(request, firstQueuedChapter = null) {
  if (request.mode === "resume-tail" || request.mode === "resume-missing") {
    const chapterSelector =
      request.site.contentType === "text"
        ? request.site.chapterContentSelector
        : request.site.chapterImageSelector;

    return {
      targetUrl: firstQueuedChapter?.url ?? "",
      primarySelectors: [chapterSelector],
      secondarySelectors: [],
      readyPhase: PHASE.DOWNLOADING,
      readyMessage:
        request.mode === "resume-tail"
          ? "启动阶段验证通过，开始继续主线抓取"
          : "启动阶段验证通过，开始处理补抓章节",
    };
  }

  return {
    targetUrl: request.url,
    primarySelectors: [request.site.listSelector],
    secondarySelectors: [request.site.contentTitleSelector].filter(Boolean),
    readyPhase: PHASE.READING_DIRECTORY,
    readyMessage: "启动阶段验证通过，开始读取目录",
  };
}

function isStartupReady(snapshot, gate, site) {
  if (hasAnySelector(snapshot, gate.primarySelectors)) {
    return true;
  }

  if (gate.secondarySelectors.length > 0 && hasAnySelector(snapshot, gate.secondarySelectors)) {
    return hasSiteSignal(snapshot, site);
  }

  return false;
}

async function waitForStartupReadiness({
  page,
  request,
  pageStability,
  log,
  gate,
}) {
  const timeoutMs = pageStability.config.siteReadyTimeoutMs;
  const startTime = Date.now();
  let hasLoggedWaitIntro = false;
  let lastHeartbeatAt = 0;

  while (true) {
    throwIfAborted(request.signal);

    let snapshot;
    try {
      snapshot = await readPageSnapshot(page, [
        ...gate.primarySelectors,
        ...gate.secondarySelectors,
      ]);
    } catch (error) {
      if (isTransientNavigationError(error)) {
        log("启动阶段检测到页面切换，继续等待验证页稳定。", "warn");
        await pageStability.waitForSiteReadyPoll();
        continue;
      }

      throw error;
    }

    if (isStartupReady(snapshot, gate, request.site)) {
      return snapshot;
    }

    if (Date.now() - startTime > timeoutMs) {
      log("启动阶段验证超时", "error");
      throw new CloudflareError(`启动阶段验证超时: ${request.site.label}`);
    }

    if (!hasLoggedWaitIntro) {
      log("正在等待站点可访问，可在辅助浏览器中完成验证。", "warn");
      hasLoggedWaitIntro = true;
      lastHeartbeatAt = Date.now();
    } else if (Date.now() - lastHeartbeatAt >= STARTUP_WAIT_LOG_INTERVAL_MS) {
      log("启动阶段验证等待中...");
      lastHeartbeatAt = Date.now();
    }

    await pageStability.waitForSiteReadyPoll();
  }
}

function logRuntimeBlocked(log, reason) {
  log(`运行中检测到疑似验证/封禁，停止后续抓取: ${reason}`, "warn");
}

async function waitForRuntimeSelector(page, selectors, request, label) {
  const primarySelector = selectors[0];

  try {
    await page.waitForSelector(primarySelector, { timeout: 30000 });
  } catch (error) {
    const suspectedReason = await detectRuntimeBlockReason(page, request.site, selectors);
    if (suspectedReason && request.schedulerConfig.stopOnSuspectedBlock) {
      throw new BlockedError(suspectedReason, error);
    }

    throw new DownloadError(`${label} 缺少必要内容选择器`, "MISSING_SELECTOR", error);
  }
}

async function collectChapterLinks(page, request, pageStability, log) {
  const chapterLinks = [];
  let contentTitle = "";
  let safetyCounter = 0;

  while (true) {
    throwIfAborted(request.signal);
    safetyCounter += 1;

    if (safetyCounter > 500) {
      throw new DownloadError("分页遍历异常，疑似陷入循环", "PAGINATION_LOOP");
    }

    try {
      await page.waitForSelector(request.site.listSelector, { timeout: 40000 });
    } catch (error) {
      const suspectedReason = await detectRuntimeBlockReason(page, request.site, [
        request.site.listSelector,
      ]);
      if (suspectedReason && request.schedulerConfig.stopOnSuspectedBlock) {
        throw new BlockedError(suspectedReason, error);
      }

      throw new DownloadError("目录页缺少必要内容选择器", "MISSING_DIRECTORY_SELECTOR", error);
    }

    await pageStability.waitForListPageSettle();

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
      if (Number.isNaN(chapterIndex)) {
        return true;
      }
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

async function readBooktokiChapter(page, chapter, request, pageStability, outputDirectory, log) {
  await waitForRuntimeSelector(page, [request.site.chapterContentSelector], request, "小说章节");
  await pageStability.waitForChapterNavigationSettle();

  const chapterText = await page.evaluate((selector) => {
    return document.querySelector(selector)?.innerText ?? "";
  }, request.site.chapterContentSelector);

  const fileName = `${chapter.numberLabel} ${sanitizePathSegment(chapter.title, "未命名章节")}.txt`;
  const filePath = path.join(outputDirectory, fileName);
  const saved = saveTextFileIfMissing(filePath, chapterText);
  log(saved ? `已保存文本章节: ${fileName}` : `已跳过已存在章节: ${fileName}`);

  return {
    outputPath: filePath,
  };
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
        const candidate =
          img.getAttribute("data-src") ||
          img.getAttribute("data-original") ||
          img.getAttribute("src") ||
          img.outerHTML.match(/\/data[^"]+/)?.[0];

        if (!candidate) {
          return null;
        }

        const cleanPath = candidate.split("?")[0];
        const extension = cleanPath.match(/\.[a-zA-Z0-9]+$/)?.[0];

        if (!extension) {
          return null;
        }

        return {
          src: candidate,
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
    throw new DownloadError(`请求资源失败: HTTP ${response.status}`, "ASSET_FETCH_FAILED");
  }

  const buffer = await response.arrayBuffer();
  return Buffer.from(buffer);
}

async function readComicChapter(page, chapter, request, pageStability, outputDirectory, log) {
  await waitForRuntimeSelector(page, [request.site.chapterImageSelector], request, "漫画章节");
  await pageStability.waitForComicImageSettle();

  const imageTargets = await collectImageTargets(page, request.site);
  if (!imageTargets.length) {
    const suspectedReason = await detectRuntimeBlockReason(page, request.site, [
      request.site.chapterImageSelector,
    ]);
    if (suspectedReason && request.schedulerConfig.stopOnSuspectedBlock) {
      throw new BlockedError(suspectedReason);
    }

    throw new DownloadError("未找到可下载图片", "EMPTY_IMAGES");
  }

  log(`检测到 ${imageTargets.length} 张图片。`);

  const chapterFolderName = `${chapter.numberLabel} ${sanitizePathSegment(chapter.title, "未命名章节")}`;
  const chapterDirectory = path.join(outputDirectory, chapterFolderName);

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

  return {
    outputPath: chapterDirectory,
  };
}

async function downloadChapter(
  page,
  chapter,
  request,
  pageStability,
  outputDirectory,
  log,
  { reuseCurrentPage = false } = {},
) {
  if (!reuseCurrentPage) {
    await page.goto(chapter.url, { waitUntil: "domcontentloaded" });
  }
  await pageStability.waitForChapterNavigationSettle();

  const selectors =
    request.site.contentType === "text"
      ? [request.site.chapterContentSelector]
      : [request.site.chapterImageSelector];

  const suspectedReason = await detectRuntimeBlockReason(page, request.site, selectors);
  if (suspectedReason && request.schedulerConfig.stopOnSuspectedBlock) {
    throw new BlockedError(suspectedReason);
  }

  log(`开始处理 ${chapter.numberLabel} ${chapter.title}`);

  if (request.site.contentType === "text") {
    return readBooktokiChapter(page, chapter, request, pageStability, outputDirectory, log);
  }

  return readComicChapter(page, chapter, request, pageStability, outputDirectory, log);
}

function buildSummary({
  request,
  manifest,
  outputDirectory,
  sessionPaths,
  finalStatus,
  phase,
  failureStage,
  failureReason,
  blockedReason,
  report,
  resumeDisposition = RESUME_DISPOSITION.STARTED,
}) {
  const counts = countManifestStats(manifest);
  const overview = buildManifestOverview(manifest);
  return {
    site: request.site,
    contentTitle: manifest.novelTitle,
    outputDirectory,
    totalChapters: counts.total,
    completedChapters: counts.success,
    failedChapters: counts.failed + counts.blocked + counts.cancelled,
    failedCount: counts.failed,
    blockedCount: counts.blocked,
    failures: report?.missingChapters ?? [],
    finalStatus,
    phase,
    failureStage,
    failureReason,
    resumeDisposition,
    lastRunMode: overview.lastRunMode,
    manifestPath: sessionPaths?.manifestPath ?? null,
    reportPath: sessionPaths?.reportPath ?? null,
    sessionDirectory: sessionPaths?.sessionDirectory ?? null,
    blockedReason: blockedReason ?? manifest.blockedReason ?? null,
    missingCount: counts.missing,
    missingChapterKeys: [...overview.missingChapterKeys],
    latestSuccessOrder: overview.latestSuccessOrder,
    latestSuccessChapterKey: overview.latestSuccessChapterKey,
    latestSuccessLabel: overview.latestSuccessLabel,
    nextForwardOrder: overview.nextForwardOrder,
    nextForwardChapterKey: overview.nextForwardChapterKey,
    nextForwardLabel: overview.nextForwardLabel,
    totalDurationMs: report?.totalDurationMs ?? 0,
    averageChapterDurationMs: report?.averageChapterDurationMs ?? null,
    effectiveChaptersPerMinute: report?.effectiveChaptersPerMinute ?? null,
    firstChapterDurationMs: report?.firstChapterDurationMs ?? null,
    schedulerDelayTotalMs: report?.schedulerDelayTotalMs ?? 0,
    pageStabilityDelayTotalMs: report?.pageStabilityDelayTotalMs ?? 0,
    startupVerificationDurationMs: report?.startupVerificationDurationMs ?? null,
    runtimeBlockedAtChapter: report?.runtimeBlockedAtChapter ?? null,
    completedChapterCount: report?.completedChapterCount ?? counts.success,
    failedChapterCount: report?.failedChapterCount ?? (counts.failed + counts.blocked + counts.cancelled),
    missingChapterCount: report?.missingChapterCount ?? counts.missing,
  };
}

function getResumeDispositionMessage(resumeDisposition) {
  return RESUME_DISPOSITION_MESSAGES[resumeDisposition] ?? "恢复任务无需继续执行";
}

function logChapterPerformance({
  log,
  manifest,
  chapter,
  startedAt,
  scheduler,
  pageStability,
  startupVerificationDurationMs,
}) {
  const chapterDurationMs = toDurationMs(chapter.startedAt, chapter.finishedAt);
  const metrics = buildPerformanceMetrics({
    manifest,
    startedAt,
    endedAt: new Date().toISOString(),
    schedulerMetrics: scheduler?.getMetrics?.() ?? {},
    pageStabilityMetrics: pageStability?.getMetrics?.() ?? {},
    startupVerificationDurationMs,
  });

  const chapterStatusLabel =
    {
      [CHAPTER_STATUS.SUCCESS]: "成功",
      [CHAPTER_STATUS.FAILED]: "失败",
      [CHAPTER_STATUS.BLOCKED]: "阻断",
      [CHAPTER_STATUS.CANCELLED]: "取消",
    }[chapter.status] ?? chapter.status;

  log(
    `章节 ${chapter.numberLabel} ${chapter.title} 已${chapterStatusLabel}，本章耗时 ${formatDuration(chapterDurationMs)}（${chapterDurationMs ?? "未统计"}）。累计平均 ${formatDuration(metrics.averageChapterDurationMs)} / 章，当前有效速度 ${formatSpeed(metrics.effectiveChaptersPerMinute)}。`,
  );
}

async function executeManifestChapter({
  page,
  chapter,
  manifest,
  sessionPaths,
  request,
  outputDirectory,
  pageStability,
  scheduler,
  log,
  phase,
  reuseCurrentPage = false,
}) {
  let shouldReuseCurrentPage = reuseCurrentPage;

  while (true) {
    const now = new Date().toISOString();
    const runningChapter = findChapterByKey(manifest, chapter.chapterKey);
    runningChapter.attempts += 1;
    runningChapter.status = CHAPTER_STATUS.RUNNING;
    runningChapter.lastTriedAt = now;
    runningChapter.startedAt = runningChapter.startedAt ?? now;
    runningChapter.finishedAt = null;
    persistManifestAndProgress(sessionPaths, manifest, request, STATUS.RUNNING, {
      phase,
    });

    try {
      const result = await downloadChapter(
        page,
        runningChapter,
        request,
        pageStability,
        outputDirectory,
        log,
        { reuseCurrentPage: shouldReuseCurrentPage },
      );

      shouldReuseCurrentPage = false;
      runningChapter.status = CHAPTER_STATUS.SUCCESS;
      runningChapter.lastError = null;
      runningChapter.outputPath = result.outputPath;
      runningChapter.finishedAt = new Date().toISOString();
      persistManifestAndProgress(sessionPaths, manifest, request, STATUS.RUNNING, {
        phase,
      });

      return {
        outcome: CHAPTER_STATUS.SUCCESS,
        chapter: runningChapter,
      };
    } catch (error) {
      shouldReuseCurrentPage = false;

      if (request.signal?.aborted) {
        runningChapter.status = CHAPTER_STATUS.CANCELLED;
        runningChapter.lastError = "下载已取消";
        runningChapter.finishedAt = new Date().toISOString();
        persistManifestAndProgress(sessionPaths, manifest, request, STATUS.CANCELLED, {
          phase,
        });
        throw new CancelledError();
      }

      const normalizedError = normalizeError(error);

      if (normalizedError instanceof BlockedError) {
        runningChapter.status = CHAPTER_STATUS.BLOCKED;
        runningChapter.lastError = normalizedError.message;
        runningChapter.finishedAt = new Date().toISOString();
        manifest.blockedReason = normalizedError.message;
        persistManifestAndProgress(sessionPaths, manifest, request, STATUS.BLOCKED, {
          phase: PHASE.RUNTIME_BLOCKED,
          blockedReason: normalizedError.message,
          failureStage: FAILURE_STAGE.RUNTIME_BLOCKED,
          failureReason: normalizedError.message,
        });
        return {
          outcome: CHAPTER_STATUS.BLOCKED,
          chapter: runningChapter,
          error: normalizedError,
        };
      }

      if (normalizedError instanceof CancelledError) {
        runningChapter.status = CHAPTER_STATUS.CANCELLED;
        runningChapter.lastError = normalizedError.message;
        runningChapter.finishedAt = new Date().toISOString();
        persistManifestAndProgress(sessionPaths, manifest, request, STATUS.CANCELLED, {
          phase,
        });
        throw normalizedError;
      }

      runningChapter.status = CHAPTER_STATUS.FAILED;
      runningChapter.lastError = normalizedError.message;
      runningChapter.finishedAt = new Date().toISOString();
      persistManifestAndProgress(sessionPaths, manifest, request, STATUS.RUNNING, {
        phase,
      });

      if (scheduler.shouldRetryChapter(runningChapter)) {
        log(`章节失败，准备按策略重试: ${runningChapter.numberLabel} ${runningChapter.title}`, "warn");
        await scheduler.waitBeforeRetry(runningChapter);
        runningChapter.status = CHAPTER_STATUS.QUEUED;
        persistManifestAndProgress(sessionPaths, manifest, request, STATUS.RUNNING, {
          phase,
        });
        continue;
      }

      return {
        outcome: CHAPTER_STATUS.FAILED,
        chapter: runningChapter,
        error: normalizedError,
      };
    }
  }
}

function prepareInitialExecution(request, contentTitle, chapters) {
  const outputDirectory = resolveContentRoot({
    outputMode: request.outputMode,
    outputRoot: request.outputRoot,
    site: request.site,
    contentTitle,
  });
  const sessionPaths = resolveSessionPaths(outputDirectory);
  const manifest = createManifest({
    novelTitle: contentTitle,
    sourceUrl: request.url,
    sourceSite: request.site.key,
    schedulerPreset: request.schedulerPreset,
    schedulerConfig: request.schedulerConfig,
    chapters,
    runKind: "initial",
  });

  return {
    outputDirectory,
    sessionPaths,
    manifest,
  };
}

function resolveResumeRequestContext(request) {
  const manifest = loadManifest(request.resumeManifestPath);
  const site = getSiteDefinitionByKey(manifest.sourceSite) ?? detectSite(manifest.sourceUrl);
  if (!site) {
    throw new ValidationError("manifest 中的站点信息无效，无法继续恢复任务");
  }

  const outputDirectory = path.dirname(path.dirname(request.resumeManifestPath));
  const sessionPaths = resolveSessionPaths(outputDirectory);
  request.site = site;
  request.url = manifest.sourceUrl;
  request.protocolDomain = getProtocolDomain(site, manifest.sourceUrl);
  request.schedulerPreset = request.explicitSchedulerPreset ?? manifest.schedulerPreset ?? DEFAULT_SCHEDULER_PRESET;
  request.schedulerConfig = resolveSchedulerConfig(request.schedulerPreset).config;

  return {
    outputDirectory,
    sessionPaths,
    manifest,
  };
}

function prepareResumeTailExecution(request) {
  const execution = resolveResumeRequestContext(request);
  const { manifest } = prepareManifestForResumeTail(
    execution.manifest,
    request.schedulerPreset,
    request.schedulerConfig,
  );
  const resumeDisposition = manifest.nextForwardOrder === null
    ? countManifestStats(manifest).missing > 0
      ? RESUME_DISPOSITION.ALREADY_AT_TAIL
      : RESUME_DISPOSITION.ALREADY_COMPLETE
    : RESUME_DISPOSITION.STARTED;
  const nextForwardChapter = manifest.nextForwardChapterKey
    ? findChapterByKey(manifest, manifest.nextForwardChapterKey)
    : null;

  if (resumeDisposition === RESUME_DISPOSITION.STARTED) {
    if (!manifest.nextForwardChapterKey || !nextForwardChapter || !nextForwardChapter.url) {
      throw new ValidationError("manifest 中的 nextForward 章节无效，无法继续主线爬取");
    }
  }

  return {
    ...execution,
    manifest,
    resumeDisposition,
    startupChapter: nextForwardChapter,
  };
}

function prepareResumeMissingExecution(request) {
  const execution = resolveResumeRequestContext(request);
  const { manifest } = prepareManifestForResumeMissing(
    execution.manifest,
    request.schedulerPreset,
    request.schedulerConfig,
  );

  return {
    ...execution,
    manifest,
    resumeDisposition: RESUME_DISPOSITION.STARTED,
    startupChapter: getQueuedChapters(manifest)[0] ?? null,
  };
}

export function parseDownloadRequest(rawOptions = {}) {
  const explicitSchedulerPreset = String(rawOptions.schedulerPreset ?? "").trim() || null;
  if (explicitSchedulerPreset) {
    resolveSchedulerConfig(explicitSchedulerPreset);
  }

  const resumeTailManifestPath = String(rawOptions.resumeTailManifestPath ?? "").trim();
  const resumeMissingManifestPath = String(rawOptions.resumeMissingManifestPath ?? rawOptions.resumeManifestPath ?? "").trim();
  if (resumeTailManifestPath && resumeMissingManifestPath) {
    throw new ValidationError("不能同时使用 resume-tail 和 resume-missing");
  }

  const resumeManifestPath = resumeTailManifestPath || resumeMissingManifestPath;
  const outputMode = rawOptions.outputMode ?? "legacy-site-root";
  if (!OUTPUT_MODES.has(outputMode)) {
    throw new ValidationError(`不支持的输出模式: ${outputMode}`);
  }

  const request = {
    mode: resumeTailManifestPath
      ? "resume-tail"
      : resumeMissingManifestPath
        ? "resume-missing"
        : "initial",
    url: "",
    site: null,
    startIndex: parseIndex(rawOptions.startIndex, 0, "开始章节"),
    lastIndex: parseIndex(rawOptions.lastIndex, Number.MAX_SAFE_INTEGER, "结束章节"),
    outputRoot: String(rawOptions.outputRoot ?? process.cwd()).trim(),
    outputMode,
    protocolDomain: "",
    signal: rawOptions.signal,
    onLog: rawOptions.onLog,
    onStatus: rawOptions.onStatus,
    onProgress: rawOptions.onProgress,
    explicitSchedulerPreset,
    schedulerPreset: explicitSchedulerPreset ?? DEFAULT_SCHEDULER_PRESET,
    schedulerConfig: explicitSchedulerPreset
      ? resolveSchedulerConfig(explicitSchedulerPreset).config
      : resolveSchedulerConfig(DEFAULT_SCHEDULER_PRESET).config,
    pageStabilityConfig: resolvePageStabilityConfig(rawOptions.pageStabilityConfig),
    resumeTailManifestPath,
    resumeMissingManifestPath,
    resumeManifestPath,
  };

  if (request.lastIndex < request.startIndex) {
    throw new ValidationError("结束章节不能小于开始章节");
  }

  if (resumeManifestPath) {
    if (!fs.existsSync(resumeManifestPath)) {
      throw new ValidationError(`manifest 不存在: ${resumeManifestPath}`);
    }
    return request;
  }

  const url = String(rawOptions.url ?? "").trim();
  if (!url) {
    throw new ValidationError("请输入作品目录链接");
  }

  const site = detectSite(url);
  if (!site) {
    throw new ValidationError("链接无效。请输入 BookToki / NewToki / ManaToki 的作品目录页链接。");
  }

  if (!request.outputRoot) {
    throw new ValidationError("输出目录不能为空");
  }

  request.url = url;
  request.site = site;
  request.protocolDomain = getProtocolDomain(site, url);
  return request;
}

export async function downloadSeries(rawOptions = {}) {
  const request = parseDownloadRequest(rawOptions);
  const log = createLogger(request.onLog);
  const pageStability = createPageStability(request.pageStabilityConfig, {
    log,
    signal: request.signal,
  });

  let summary = {
    site: request.site,
    contentTitle: "",
    outputDirectory: "",
    totalChapters: 0,
    completedChapters: 0,
    failedChapters: 0,
    failures: [],
    finalStatus: STATUS.IDLE,
    phase: null,
    failureStage: null,
    failureReason: null,
    manifestPath: null,
    reportPath: null,
    sessionDirectory: null,
    blockedReason: null,
    resumeDisposition: RESUME_DISPOSITION.STARTED,
    latestSuccessOrder: null,
    latestSuccessChapterKey: null,
    latestSuccessLabel: "无",
    nextForwardOrder: null,
    nextForwardChapterKey: null,
    nextForwardLabel: "无",
    missingChapterKeys: [],
    blockedCount: 0,
    failedCount: 0,
    lastRunMode: request.mode,
    missingCount: 0,
  };

  let browser;
  let page;
  let manifest = null;
  let sessionPaths = null;
  let outputDirectory = "";
  let report = null;
  let pendingError = null;
  let phase = PHASE.STARTUP_VERIFICATION;
  let failureStage = null;
  let failureReason = null;
  let preloadedChapterKey = null;
  let resumeStartupChapter = null;
  let scheduler = null;
  let startupVerificationStartedAt = null;
  let startupVerificationDurationMs = null;
  let runtimeBlockedAtChapter = null;
  let shouldLaunchBrowser = true;
  const startedAt = new Date().toISOString();

  const abortListener = async () => {
    log("收到取消请求，正在关闭浏览器。", "warn");
    await browser?.close().catch(() => {});
  };

  if (request.signal) {
    request.signal.addEventListener("abort", abortListener, { once: true });
  }

  try {
    if (request.mode === "initial") {
      ensureWritableDirectory(request.outputRoot);
    }

    if (request.mode === "resume-tail" || request.mode === "resume-missing") {
      const resumeExecution =
        request.mode === "resume-tail"
          ? prepareResumeTailExecution(request)
          : prepareResumeMissingExecution(request);

      outputDirectory = resumeExecution.outputDirectory;
      sessionPaths = resumeExecution.sessionPaths;
      manifest = resumeExecution.manifest;
      resumeStartupChapter = resumeExecution.startupChapter;
      summary.contentTitle = manifest.novelTitle;
      summary.site = request.site;
      summary.outputDirectory = outputDirectory;
      summary.manifestPath = sessionPaths.manifestPath;
      summary.reportPath = sessionPaths.reportPath;
      summary.sessionDirectory = sessionPaths.sessionDirectory;
      summary.totalChapters = manifest.chapters.length;
      summary.resumeDisposition = resumeExecution.resumeDisposition;

      if (resumeExecution.resumeDisposition !== RESUME_DISPOSITION.STARTED) {
        const resumeMessage = getResumeDispositionMessage(resumeExecution.resumeDisposition);
        manifest.lastStopReason = resumeMessage;
        persistManifestAndProgress(sessionPaths, manifest, request, STATUS.COMPLETED, {
          resumeDisposition: resumeExecution.resumeDisposition,
        });
        emitStatus(request.onStatus, STATUS.COMPLETED, resumeMessage, {
          resumeDisposition: resumeExecution.resumeDisposition,
        });
        summary.finalStatus = STATUS.COMPLETED;
        summary.resumeDisposition = resumeExecution.resumeDisposition;
        report = createReport({
          manifest,
          finalStatus: STATUS.COMPLETED,
          resumeDisposition: resumeExecution.resumeDisposition,
          startedAt,
          endedAt: new Date().toISOString(),
          schedulerMetrics: {},
          pageStabilityMetrics: pageStability.getMetrics(),
        });
        persistReport(sessionPaths.reportPath, report);
        summary = buildSummary({
          request,
          manifest,
          outputDirectory,
          sessionPaths,
          finalStatus: STATUS.COMPLETED,
          phase: null,
          failureStage: null,
          failureReason: null,
          blockedReason: null,
          report,
          resumeDisposition: resumeExecution.resumeDisposition,
        });
        shouldLaunchBrowser = false;
      }
    }

    if (shouldLaunchBrowser) {
      emitStatus(request.onStatus, STATUS.RUNNING, "正在启动浏览器", {
        phase,
      });

      ({ browser, page } = await connect({
        headless: false,
        args: [],
        customConfig: {},
        turnstile: true,
        connectOption: { defaultViewport: null },
        disableXvfb: false,
      }));

      log("浏览器已启动。");

      scheduler = createScheduler(request.schedulerConfig, {
        log,
        signal: request.signal,
      });

      if (request.mode === "resume-tail" || request.mode === "resume-missing") {
        persistManifestAndProgress(sessionPaths, manifest, request, STATUS.RUNNING, {
          phase,
          resumeDisposition: summary.resumeDisposition,
        });

        if (resumeStartupChapter) {
          const startupGate = buildStartupGate(request, resumeStartupChapter);
          startupVerificationStartedAt = new Date().toISOString();
          emitStatus(request.onStatus, STATUS.RUNNING, "正在等待站点可访问，可在辅助浏览器中完成验证", {
            phase,
            resumeDisposition: summary.resumeDisposition,
          });
          await page.goto(startupGate.targetUrl, { waitUntil: "domcontentloaded" });
          await waitForStartupReadiness({
            page,
            request,
            pageStability,
            log,
            gate: startupGate,
          });
          startupVerificationDurationMs = toDurationMs(
            startupVerificationStartedAt,
            new Date().toISOString(),
          );
          scheduler.resetFailureWindow();
          phase = startupGate.readyPhase;
          preloadedChapterKey = resumeStartupChapter.chapterKey;
          log(startupGate.readyMessage);
          emitStatus(request.onStatus, STATUS.RUNNING, startupGate.readyMessage, {
            phase,
            resumeDisposition: summary.resumeDisposition,
          });
          persistManifestAndProgress(sessionPaths, manifest, request, STATUS.RUNNING, {
            phase,
            resumeDisposition: summary.resumeDisposition,
          });
        } else {
          phase = PHASE.DOWNLOADING;
        }
      } else {
        const startupGate = buildStartupGate(request);
        startupVerificationStartedAt = new Date().toISOString();
        emitStatus(request.onStatus, STATUS.RUNNING, "正在等待站点可访问，可在辅助浏览器中完成验证", {
          phase,
        });
        await page.goto(startupGate.targetUrl, { waitUntil: "domcontentloaded" });
        await waitForStartupReadiness({
          page,
          request,
          pageStability,
          log,
          gate: startupGate,
        });
        startupVerificationDurationMs = toDurationMs(
          startupVerificationStartedAt,
          new Date().toISOString(),
        );
        scheduler.resetFailureWindow();
        phase = startupGate.readyPhase;
        log(startupGate.readyMessage);
        emitStatus(request.onStatus, STATUS.RUNNING, startupGate.readyMessage, {
          phase,
        });
      }
    }
    if (shouldLaunchBrowser && request.mode === "initial") {
      const { contentTitle, chapters } = await collectChapterLinks(page, request, pageStability, log);
      const safeTitle = sanitizePathSegment(contentTitle, "未命名作品");
      const initialExecution = prepareInitialExecution(request, safeTitle, chapters);
      outputDirectory = initialExecution.outputDirectory;
      sessionPaths = initialExecution.sessionPaths;
      manifest = initialExecution.manifest;
      summary.contentTitle = safeTitle;
      summary.site = request.site;
      summary.outputDirectory = outputDirectory;
      summary.manifestPath = sessionPaths.manifestPath;
      summary.reportPath = sessionPaths.reportPath;
      summary.sessionDirectory = sessionPaths.sessionDirectory;
      summary.totalChapters = manifest.chapters.length;
      persistManifestAndProgress(sessionPaths, manifest, request, STATUS.RUNNING, {
        phase,
      });
    }

    if (shouldLaunchBrowser && manifest) {
      ensureWritableDirectory(outputDirectory);
      log(`输出目录: ${outputDirectory}`);
      log(`本次计划下载 ${manifest.chapters.length} 个章节。`);
      phase = PHASE.DOWNLOADING;
      emitStatus(request.onStatus, STATUS.RUNNING, "开始下载章节", {
        phase,
      });
      persistManifestAndProgress(sessionPaths, manifest, request, STATUS.RUNNING, {
        phase,
      });
    }

    while (shouldLaunchBrowser && manifest) {
      throwIfAborted(request.signal);
      const nextChapter =
        request.mode === "resume-tail"
          ? getNextTailChapter(manifest)
          : getQueuedChapters(manifest)[0];
      if (!nextChapter) {
        break;
      }

      const result = await executeManifestChapter({
        page,
        chapter: nextChapter,
        manifest,
        sessionPaths,
        request,
        outputDirectory,
        pageStability,
        scheduler,
        log,
        phase,
        reuseCurrentPage: nextChapter.chapterKey === preloadedChapterKey,
      });

      preloadedChapterKey = null;

      if (result.outcome === CHAPTER_STATUS.BLOCKED) {
        phase = PHASE.RUNTIME_BLOCKED;
        failureStage = FAILURE_STAGE.RUNTIME_BLOCKED;
        failureReason = result.error.message;
        runtimeBlockedAtChapter = {
          chapterKey: result.chapter.chapterKey,
          index: result.chapter.index,
          title: result.chapter.title,
        };
        summary.blockedReason = manifest.blockedReason;
        summary.finalStatus = STATUS.BLOCKED;
        logChapterPerformance({
          log,
          manifest,
          chapter: result.chapter,
          startedAt,
          scheduler,
          pageStability,
          startupVerificationDurationMs,
        });
        logRuntimeBlocked(log, manifest.blockedReason ?? result.error.message);
        emitStatus(request.onStatus, STATUS.BLOCKED, manifest.blockedReason ?? "疑似验证页或封禁", {
          phase,
          failureStage,
        });
        break;
      }

      logChapterPerformance({
        log,
        manifest,
        chapter: result.chapter,
        startedAt,
        scheduler,
        pageStability,
        startupVerificationDurationMs,
      });

      if (result.outcome === CHAPTER_STATUS.FAILED) {
        log(
          `章节失败: ${result.chapter.numberLabel} ${result.chapter.title} - ${result.error.message}`,
          "error",
        );
      }

      const hasMoreQueued = getQueuedChapters(manifest).length > 0;
      const schedulerDecision = await scheduler.afterChapter({
        outcome: result.outcome === CHAPTER_STATUS.SUCCESS ? "success" : "failed",
        hasMoreQueued,
      });

      if (schedulerDecision.shouldStop) {
        const currentChapter = findChapterByKey(manifest, result.chapter.chapterKey);
        if (currentChapter && currentChapter.status === CHAPTER_STATUS.FAILED) {
          currentChapter.status = CHAPTER_STATUS.BLOCKED;
          currentChapter.lastError = currentChapter.lastError
            ? `${currentChapter.lastError} | ${schedulerDecision.blockedReason}`
            : schedulerDecision.blockedReason;
          currentChapter.finishedAt = new Date().toISOString();
        }
        manifest.blockedReason = schedulerDecision.blockedReason;
        phase = PHASE.RUNTIME_BLOCKED;
        failureStage = FAILURE_STAGE.RUNTIME_BLOCKED;
        failureReason = schedulerDecision.blockedReason;
        runtimeBlockedAtChapter = {
          chapterKey: result.chapter.chapterKey,
          index: result.chapter.index,
          title: result.chapter.title,
        };
        persistManifestAndProgress(sessionPaths, manifest, request, STATUS.BLOCKED, {
          phase,
          blockedReason: schedulerDecision.blockedReason,
          failureStage,
          failureReason,
        });
        summary.blockedReason = schedulerDecision.blockedReason;
        summary.finalStatus = STATUS.BLOCKED;
        logRuntimeBlocked(log, schedulerDecision.blockedReason);
        emitStatus(request.onStatus, STATUS.BLOCKED, schedulerDecision.blockedReason, {
          phase,
          failureStage,
        });
        break;
      }
    }

    if (shouldLaunchBrowser && manifest && summary.finalStatus !== STATUS.BLOCKED) {
      const stats = countManifestStats(manifest);
      if (stats.failed + stats.blocked + stats.cancelled > 0 && stats.success > 0) {
        summary.finalStatus = STATUS.PARTIAL;
        emitStatus(request.onStatus, STATUS.PARTIAL, "部分章节下载失败", {
          phase,
        });
      } else if (stats.failed + stats.blocked + stats.cancelled > 0 && stats.success === 0) {
        summary.finalStatus = STATUS.FAILED;
        failureReason = failureReason ?? "下载失败";
        emitStatus(request.onStatus, STATUS.FAILED, "下载失败", {
          phase,
          failureStage,
        });
      } else {
        summary.finalStatus = STATUS.COMPLETED;
        emitStatus(request.onStatus, STATUS.COMPLETED, "下载完成", {
          phase,
        });
      }
    }
  } catch (error) {
    const normalizedError = normalizeError(error);

    if (normalizedError instanceof CancelledError) {
      summary.finalStatus = STATUS.CANCELLED;
      failureReason = normalizedError.message;
      emitStatus(request.onStatus, STATUS.CANCELLED, "下载已取消", {
        phase,
      });
      pendingError = normalizedError;
    } else if (phase === PHASE.STARTUP_VERIFICATION && normalizedError instanceof CloudflareError) {
      phase = PHASE.STARTUP_VERIFICATION_TIMEOUT;
      failureStage = FAILURE_STAGE.STARTUP_VERIFICATION_TIMEOUT;
      failureReason = normalizedError.message;
      startupVerificationDurationMs =
        startupVerificationDurationMs ??
        toDurationMs(startupVerificationStartedAt, new Date().toISOString());
      summary.finalStatus = STATUS.FAILED;

      if (!manifest && request.mode === "initial") {
        const fallbackSession = createPreManifestFailureSession(request);
        outputDirectory = fallbackSession.outputDirectory;
        sessionPaths = fallbackSession.sessionPaths;
        manifest = fallbackSession.manifest;
        persistManifestAndProgress(sessionPaths, manifest, request, STATUS.FAILED, {
          phase,
          failureStage,
          failureReason,
        });
      } else if (manifest && sessionPaths) {
        persistManifestAndProgress(sessionPaths, manifest, request, STATUS.FAILED, {
          phase,
          failureStage,
          failureReason,
        });
      }

      emitStatus(request.onStatus, STATUS.FAILED, normalizedError.message, {
        phase,
        failureStage,
      });
    } else if (normalizedError instanceof BlockedError) {
      phase = PHASE.RUNTIME_BLOCKED;
      failureStage = FAILURE_STAGE.RUNTIME_BLOCKED;
      failureReason = normalizedError.message;
      summary.finalStatus = STATUS.BLOCKED;
      summary.blockedReason = normalizedError.message;

      if (manifest && sessionPaths) {
        manifest.blockedReason = normalizedError.message;
        persistManifestAndProgress(sessionPaths, manifest, request, STATUS.BLOCKED, {
          phase,
          blockedReason: normalizedError.message,
          failureStage,
          failureReason,
        });
      }

      logRuntimeBlocked(log, normalizedError.message);
      emitStatus(request.onStatus, STATUS.BLOCKED, normalizedError.message, {
        phase,
        failureStage,
      });
    } else if (manifest) {
      summary.finalStatus = STATUS.FAILED;
      failureReason = normalizedError.message;
      log(normalizedError.message, "error");
      emitStatus(request.onStatus, STATUS.FAILED, normalizedError.message, {
        phase,
        failureStage,
      });
    } else {
      summary.finalStatus = STATUS.FAILED;
      failureReason = normalizedError.message;
      log(normalizedError.message, "error");
      emitStatus(request.onStatus, STATUS.FAILED, normalizedError.message, {
        phase,
        failureStage,
      });
      pendingError = normalizedError;
    }
  } finally {
    request.signal?.removeEventListener("abort", abortListener);
    await browser?.close().catch(() => {});

    if (manifest && sessionPaths) {
      if (summary.resumeDisposition === RESUME_DISPOSITION.ALREADY_AT_TAIL) {
        manifest.lastStopReason = getResumeDispositionMessage(RESUME_DISPOSITION.ALREADY_AT_TAIL);
      } else if (summary.resumeDisposition === RESUME_DISPOSITION.ALREADY_COMPLETE) {
        manifest.lastStopReason = getResumeDispositionMessage(RESUME_DISPOSITION.ALREADY_COMPLETE);
      } else if (summary.finalStatus === STATUS.COMPLETED) {
        manifest.lastStopReason = null;
      } else if (summary.finalStatus === STATUS.BLOCKED) {
        manifest.lastStopReason = summary.blockedReason ?? failureReason ?? manifest.blockedReason;
      } else if (summary.finalStatus === STATUS.CANCELLED) {
        manifest.lastStopReason = failureReason ?? "下载已取消";
      } else if (summary.finalStatus === STATUS.PARTIAL) {
        manifest.lastStopReason = failureReason ?? "部分章节下载失败";
      } else if (summary.finalStatus === STATUS.FAILED) {
        manifest.lastStopReason = failureReason ?? "下载失败";
      }

      persistManifest(sessionPaths, manifest);
      report = createReport({
        manifest,
        finalStatus: summary.finalStatus,
        phase,
        failureStage,
        failureReason,
        blockedReason: summary.blockedReason ?? manifest.blockedReason,
        resumeDisposition: summary.resumeDisposition,
        startedAt,
        endedAt: new Date().toISOString(),
        schedulerMetrics: scheduler?.getMetrics?.() ?? {},
        pageStabilityMetrics: pageStability.getMetrics(),
        startupVerificationDurationMs,
        runtimeBlockedAtChapter,
      });
      persistReport(sessionPaths.reportPath, report);
      summary = buildSummary({
        request,
        manifest,
        outputDirectory,
        sessionPaths,
        finalStatus: summary.finalStatus,
        phase,
        failureStage,
        failureReason,
        blockedReason: summary.blockedReason,
        report,
        resumeDisposition: summary.resumeDisposition,
      });
      emitProgress(
        request.onProgress,
        buildProgressPayload(manifest, summary.finalStatus, sessionPaths, {
          phase,
          blockedReason: summary.blockedReason,
          failureStage,
          failureReason,
          resumeDisposition: summary.resumeDisposition,
        }),
      );
    }
  }

  if (pendingError) {
    pendingError.summary = summary;
    throw pendingError;
  }

  return summary;
}

export { FAILURE_STAGE, PHASE, STATUS };
