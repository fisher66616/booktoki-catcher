import fs from "node:fs";
import path from "node:path";

import { countManifestStats } from "./session-manifest.js";

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tempPath, filePath);
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

function roundMetric(value, digits = 2) {
  if (!Number.isFinite(value)) {
    return null;
  }

  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function buildPerformanceMetrics({
  manifest,
  startedAt,
  endedAt,
  schedulerMetrics = {},
  pageStabilityMetrics = {},
  startupVerificationDurationMs = null,
  runtimeBlockedAtChapter = null,
}) {
  const counts = countManifestStats(manifest);
  const finishedChapters = manifest.chapters
    .filter((chapter) => chapter.startedAt && chapter.finishedAt)
    .map((chapter) => ({
      ...chapter,
      durationMs: toDurationMs(chapter.startedAt, chapter.finishedAt),
    }))
    .filter((chapter) => chapter.durationMs !== null)
    .sort((left, right) => left.order - right.order);

  const totalFinishedDurationMs = finishedChapters.reduce((sum, chapter) => sum + chapter.durationMs, 0);
  const totalDurationMs = toDurationMs(startedAt, endedAt) ?? 0;

  return {
    totalDurationMs,
    averageChapterDurationMs:
      finishedChapters.length > 0
        ? Math.round(totalFinishedDurationMs / finishedChapters.length)
        : null,
    effectiveChaptersPerMinute:
      totalDurationMs > 0 ? roundMetric((counts.success * 60000) / totalDurationMs) : null,
    firstChapterDurationMs: finishedChapters[0]?.durationMs ?? null,
    schedulerDelayTotalMs: schedulerMetrics.totalDelayMs ?? 0,
    pageStabilityDelayTotalMs: pageStabilityMetrics.totalDelayMs ?? 0,
    startupVerificationDurationMs,
    runtimeBlockedAtChapter,
    completedChapterCount: counts.success,
    failedChapterCount: counts.failed + counts.blocked + counts.cancelled,
    missingChapterCount: counts.missing,
  };
}

export function createReport({
  manifest,
  finalStatus,
  phase = null,
  failureStage = null,
  failureReason = null,
  blockedReason = null,
  resumeDisposition = "started",
  startedAt,
  endedAt,
  schedulerMetrics = {},
  pageStabilityMetrics = {},
  startupVerificationDurationMs = null,
  runtimeBlockedAtChapter = null,
}) {
  const counts = countManifestStats(manifest);
  const missingChapters = manifest.chapters
    .filter((chapter) => chapter.status !== "success")
    .map((chapter) => ({
      chapterKey: chapter.chapterKey,
      index: chapter.index,
      title: chapter.title,
      url: chapter.url,
      status: chapter.status,
      attempts: chapter.attempts,
      lastError: chapter.lastError,
    }));
  const performanceMetrics = buildPerformanceMetrics({
    manifest,
    startedAt,
    endedAt,
    schedulerMetrics,
    pageStabilityMetrics,
    startupVerificationDurationMs,
    runtimeBlockedAtChapter,
  });

  return {
    runKind: manifest.runKind,
    lastRunMode: manifest.lastRunMode ?? manifest.runKind,
    finalStatus,
    phase,
    resumeDisposition,
    totalChapters: counts.total,
    successCount: counts.success,
    failedCount: counts.failed,
    blockedCount: counts.blocked,
    missingCount: counts.missing,
    missingChapters,
    latestSuccessOrder: manifest.latestSuccessOrder,
    latestSuccessChapterKey: manifest.latestSuccessChapterKey,
    nextForwardOrder: manifest.nextForwardOrder,
    nextForwardChapterKey: manifest.nextForwardChapterKey,
    missingChapterKeys: [...manifest.missingChapterKeys],
    failureStage,
    failureReason,
    blockedReason,
    schedulerPreset: manifest.schedulerPreset,
    schedulerConfig: manifest.schedulerConfig,
    startedAt,
    endedAt,
    ...performanceMetrics,
  };
}

export function persistReport(reportPath, report) {
  writeJsonAtomic(reportPath, report);
  return report;
}
