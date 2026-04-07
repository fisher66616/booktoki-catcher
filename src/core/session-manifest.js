import fs from "node:fs";
import path from "node:path";

import { ensureWritableDirectory } from "./output.js";

export const SESSION_FILE_NAMES = {
  sessionDirectory: "_session",
  manifest: "manifest.json",
  report: "report.json",
  historyDirectory: "history",
};

export const CHAPTER_STATUS = {
  QUEUED: "queued",
  RUNNING: "running",
  SUCCESS: "success",
  FAILED: "failed",
  BLOCKED: "blocked",
  SKIPPED: "skipped",
  CANCELLED: "cancelled",
};

export const RUN_KIND = {
  INITIAL: "initial",
  RESUME_TAIL: "resume-tail",
  RESUME_MISSING: "resume-missing",
};

export const RESUME_DISPOSITION = {
  STARTED: "started",
  ALREADY_AT_TAIL: "already-at-tail",
  ALREADY_COMPLETE: "already-complete",
};

function writeJsonAtomic(filePath, value) {
  ensureWritableDirectory(path.dirname(filePath));
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tempPath, filePath);
}

export function normalizeChapterUrl(rawUrl) {
  const normalized = new URL(String(rawUrl)).href;
  return normalized.replace(/#.*$/, "");
}

export function buildChapterKey(rawUrl) {
  return normalizeChapterUrl(rawUrl);
}

export function resolveSessionPaths(outputDirectory) {
  const sessionDirectory = path.join(outputDirectory, SESSION_FILE_NAMES.sessionDirectory);
  return {
    sessionDirectory,
    manifestPath: path.join(sessionDirectory, SESSION_FILE_NAMES.manifest),
    reportPath: path.join(sessionDirectory, SESSION_FILE_NAMES.report),
    historyDirectory: path.join(sessionDirectory, SESSION_FILE_NAMES.historyDirectory),
  };
}

function toNumericIndex(rawIndex, order) {
  const parsed = Number.parseInt(String(rawIndex ?? ""), 10);
  return Number.isNaN(parsed) ? order : parsed;
}

function normalizeManifestChapter(chapter, fallbackOrder) {
  const order = toNumericIndex(chapter.order, fallbackOrder);
  const url = normalizeChapterUrl(chapter.url ?? chapter.src);

  return {
    chapterKey: chapter.chapterKey ?? buildChapterKey(url),
    index: toNumericIndex(chapter.index ?? chapter.num, order),
    order,
    title: String(chapter.title ?? chapter.fileName ?? `第 ${order} 章`),
    url,
    status: Object.values(CHAPTER_STATUS).includes(chapter.status)
      ? chapter.status
      : CHAPTER_STATUS.QUEUED,
    attempts: Number.parseInt(String(chapter.attempts ?? "0"), 10) || 0,
    lastError: chapter.lastError ?? null,
    lastTriedAt: chapter.lastTriedAt ?? null,
    outputPath: chapter.outputPath ?? null,
    startedAt: chapter.startedAt ?? null,
    finishedAt: chapter.finishedAt ?? null,
    numberLabel: String(chapter.numberLabel ?? chapter.num ?? chapter.index ?? order).padStart(4, "0"),
  };
}

function getChapterByOrder(manifest, order) {
  return manifest.chapters.find((chapter) => chapter.order === order) ?? null;
}

export function createManifestChapter(chapter, order) {
  return normalizeManifestChapter(
    {
      ...chapter,
      status: CHAPTER_STATUS.QUEUED,
      attempts: 0,
      lastError: null,
      lastTriedAt: null,
      outputPath: null,
      startedAt: null,
      finishedAt: null,
    },
    order,
  );
}

export function refreshManifestProgress(manifest) {
  manifest.chapters = (manifest.chapters ?? [])
    .map((chapter, index) => normalizeManifestChapter(chapter, index + 1))
    .sort((left, right) => left.order - right.order);

  const latestSuccessChapter = [...manifest.chapters]
    .filter((chapter) => chapter.status === CHAPTER_STATUS.SUCCESS)
    .sort((left, right) => right.order - left.order)[0] ?? null;
  const nextForwardChapter =
    latestSuccessChapter === null
      ? manifest.chapters.find((chapter) => chapter.status !== CHAPTER_STATUS.SUCCESS) ?? null
      : manifest.chapters.find((chapter) => chapter.order > latestSuccessChapter.order) ?? null;

  manifest.latestSuccessOrder = latestSuccessChapter?.order ?? null;
  manifest.latestSuccessChapterKey = latestSuccessChapter?.chapterKey ?? null;
  manifest.nextForwardOrder = nextForwardChapter?.order ?? null;
  manifest.nextForwardChapterKey = nextForwardChapter?.chapterKey ?? null;
  manifest.missingChapterKeys = manifest.chapters
    .filter((chapter) => chapter.status !== CHAPTER_STATUS.SUCCESS)
    .map((chapter) => chapter.chapterKey);
  manifest.updatedAt = new Date().toISOString();

  return manifest;
}

function normalizeInterruptedChapters(manifest) {
  for (const chapter of manifest.chapters) {
    if (chapter.status === CHAPTER_STATUS.RUNNING) {
      chapter.status = CHAPTER_STATUS.FAILED;
      chapter.lastError = chapter.lastError ?? "上次运行在处理中断";
      chapter.finishedAt = chapter.finishedAt ?? new Date().toISOString();
    }
  }

  return manifest;
}

export function createManifest({
  novelTitle,
  sourceUrl,
  sourceSite,
  schedulerPreset,
  schedulerConfig,
  chapters,
  runKind = "initial",
}) {
  const createdAt = new Date().toISOString();
  return refreshManifestProgress({
    novelTitle,
    sourceUrl: normalizeChapterUrl(sourceUrl),
    sourceSite,
    createdAt,
    updatedAt: createdAt,
    runKind,
    lastRunMode: runKind,
    schedulerPreset,
    schedulerConfig,
    blockedReason: null,
    lastStopReason: null,
    chapters: chapters.map((chapter, index) => createManifestChapter(chapter, index + 1)),
  });
}

export function loadManifest(manifestPath) {
  return refreshManifestProgress(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
}

export function persistManifest(paths, manifest) {
  refreshManifestProgress(manifest);
  writeJsonAtomic(paths.manifestPath, manifest);
  return manifest;
}

export function getQueuedChapters(manifest) {
  return manifest.chapters
    .filter((chapter) => chapter.status === CHAPTER_STATUS.QUEUED)
    .sort((left, right) => left.order - right.order);
}

export function findChapterByKey(manifest, chapterKey) {
  return manifest.chapters.find((chapter) => chapter.chapterKey === chapterKey) ?? null;
}

export function getNextTailChapter(manifest) {
  if (manifest.nextForwardOrder === null) {
    return null;
  }

  return getQueuedChapters(manifest).find((chapter) => chapter.order >= manifest.nextForwardOrder) ?? null;
}

export function updateChapter(manifest, chapterKey, patch) {
  const chapter = findChapterByKey(manifest, chapterKey);
  if (!chapter) {
    throw new Error(`chapterKey 不存在: ${chapterKey}`);
  }

  const nextPatch = typeof patch === "function" ? patch({ ...chapter }) : patch;
  Object.assign(chapter, nextPatch);
  manifest.updatedAt = new Date().toISOString();
  return chapter;
}

export function countManifestStats(manifest) {
  refreshManifestProgress(manifest);

  const counts = {
    total: manifest.chapters.length,
    queued: 0,
    running: 0,
    success: 0,
    failed: 0,
    blocked: 0,
    skipped: 0,
    cancelled: 0,
  };

  for (const chapter of manifest.chapters) {
    if (counts[chapter.status] !== undefined) {
      counts[chapter.status] += 1;
    }
  }

  counts.missing = manifest.missingChapterKeys.length;
  return counts;
}

function resetQueuedChapter(chapter) {
  chapter.status = CHAPTER_STATUS.QUEUED;
  chapter.startedAt = null;
  chapter.finishedAt = null;
}

function applyResumeMetadata(manifest, runKind, schedulerPreset, schedulerConfig) {
  manifest.runKind = runKind;
  manifest.lastRunMode = runKind;
  manifest.schedulerPreset = schedulerPreset;
  manifest.schedulerConfig = schedulerConfig;
  manifest.blockedReason = null;
  manifest.lastStopReason = null;
  manifest.updatedAt = new Date().toISOString();
}

export function prepareManifestForResumeTail(manifest, schedulerPreset, schedulerConfig) {
  normalizeInterruptedChapters(manifest);
  refreshManifestProgress(manifest);
  applyResumeMetadata(manifest, RUN_KIND.RESUME_TAIL, schedulerPreset, schedulerConfig);

  const counts = countManifestStats(manifest);
  if (manifest.nextForwardOrder === null) {
    return {
      manifest,
      resumeDisposition:
        counts.missing > 0
          ? RESUME_DISPOSITION.ALREADY_AT_TAIL
          : RESUME_DISPOSITION.ALREADY_COMPLETE,
    };
  }

  for (const chapter of manifest.chapters) {
    if (chapter.status === CHAPTER_STATUS.SUCCESS) {
      continue;
    }

    if (chapter.order >= manifest.nextForwardOrder) {
      resetQueuedChapter(chapter);
    }
  }

  refreshManifestProgress(manifest);
  return {
    manifest,
    resumeDisposition: RESUME_DISPOSITION.STARTED,
  };
}

export function prepareManifestForResumeMissing(manifest, schedulerPreset, schedulerConfig) {
  normalizeInterruptedChapters(manifest);
  refreshManifestProgress(manifest);
  applyResumeMetadata(manifest, RUN_KIND.RESUME_MISSING, schedulerPreset, schedulerConfig);

  for (const chapter of manifest.chapters) {
    if (chapter.status !== CHAPTER_STATUS.SUCCESS) {
      resetQueuedChapter(chapter);
    }
  }

  refreshManifestProgress(manifest);
  return {
    manifest,
    resumeDisposition: RESUME_DISPOSITION.STARTED,
  };
}

function buildChapterLabel(chapter) {
  if (!chapter) {
    return "无";
  }

  return `${chapter.numberLabel} ${chapter.title}`;
}

export function buildManifestOverview(manifest) {
  refreshManifestProgress(manifest);
  const counts = countManifestStats(manifest);
  const latestSuccessChapter = manifest.latestSuccessChapterKey
    ? findChapterByKey(manifest, manifest.latestSuccessChapterKey)
    : null;
  const nextForwardChapter =
    manifest.nextForwardChapterKey !== null
      ? findChapterByKey(manifest, manifest.nextForwardChapterKey)
      : getChapterByOrder(manifest, manifest.nextForwardOrder);

  return {
    novelTitle: manifest.novelTitle,
    runKind: manifest.runKind ?? RUN_KIND.INITIAL,
    lastRunMode: manifest.lastRunMode ?? manifest.runKind ?? RUN_KIND.INITIAL,
    latestSuccessOrder: manifest.latestSuccessOrder,
    latestSuccessChapterKey: manifest.latestSuccessChapterKey,
    latestSuccessLabel: buildChapterLabel(latestSuccessChapter),
    nextForwardOrder: manifest.nextForwardOrder,
    nextForwardChapterKey: manifest.nextForwardChapterKey,
    nextForwardLabel: buildChapterLabel(nextForwardChapter),
    missingCount: counts.missing,
    missingChapterKeys: [...manifest.missingChapterKeys],
  };
}

export function loadManifestOverview(manifestPath) {
  const manifest = loadManifest(manifestPath);

  return {
    manifestPath,
    sessionDirectory: path.dirname(manifestPath),
    ...buildManifestOverview(manifest),
  };
}
