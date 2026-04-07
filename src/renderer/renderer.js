const statusText = document.querySelector("#statusText");
const statusMessage = document.querySelector("#statusMessage");
const urlInput = document.querySelector("#urlInput");
const startInput = document.querySelector("#startInput");
const lastInput = document.querySelector("#lastInput");
const outputInput = document.querySelector("#outputInput");
const startButton = document.querySelector("#startButton");
const cancelButton = document.querySelector("#cancelButton");
const browseButton = document.querySelector("#browseButton");
const manifestInput = document.querySelector("#manifestInput");
const manifestBrowseButton = document.querySelector("#manifestBrowseButton");
const clearLogButton = document.querySelector("#clearLogButton");
const logOutput = document.querySelector("#logOutput");
const openReportButton = document.querySelector("#openReportButton");
const reportHint = document.querySelector("#reportHint");
const resumeHint = document.querySelector("#resumeHint");
const resumeTailButton = document.querySelector("#resumeTailButton");
const resumeMissingButton = document.querySelector("#resumeMissingButton");
const overviewTitleStat = document.querySelector("#overviewTitleStat");
const latestSuccessStat = document.querySelector("#latestSuccessStat");
const nextForwardStat = document.querySelector("#nextForwardStat");
const overviewMissingStat = document.querySelector("#overviewMissingStat");
const runKindStat = document.querySelector("#runKindStat");
const totalStat = document.querySelector("#totalStat");
const successStat = document.querySelector("#successStat");
const failedStat = document.querySelector("#failedStat");
const missingStat = document.querySelector("#missingStat");
const currentStatusStat = document.querySelector("#currentStatusStat");

const STATUS_LABELS = {
  idle: "未开始",
  running: "运行中",
  completed: "完成",
  failed: "失败",
  cancelled: "已取消",
  partial: "部分完成",
  blocked: "已暂停",
};

const PHASE_LABELS = {
  "startup-verification": "等待站点可访问",
  "reading-directory": "读取目录中",
  downloading: "下载中",
  "runtime-blocked": "运行中已暂停",
  "startup-verification-timeout": "启动验证超时",
};

const RUN_KIND_LABELS = {
  initial: "initial",
  "resume-tail": "resume-tail",
  "resume-missing": "resume-missing",
};

let isRunning = false;
let latestSessionDirectory = null;
let latestManifestPath = null;
let latestReportPath = null;
let selectedManifestPath = null;
let selectedManifestOverview = null;
const bridge = window.booktokiCatcher;

function getDisplayState(payload = {}) {
  const status = payload.status ?? payload.currentStatus;

  if (status && status !== "running") {
    return STATUS_LABELS[status] ?? status;
  }

  return PHASE_LABELS[payload.phase] ?? STATUS_LABELS[status] ?? "未开始";
}

function formatPointerLabel(label, order) {
  if (label && label !== "无") {
    return label;
  }

  if (Number.isFinite(order)) {
    return `第 ${order} 章`;
  }

  return "无";
}

function getResumeHint(overview = {}) {
  if (overview.nextForwardOrder === null && Number(overview.missingCount ?? 0) > 0) {
    return "主线已到末尾，请使用补漏章节。";
  }

  if (overview.nextForwardOrder === null) {
    return "已无可继续章节。";
  }

  return "继续爬取将从 nextForward 开始，不会从头确认。";
}

function appendLog(message, level = "info") {
  const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  const line = `[${time}] ${message}`;

  if (!logOutput.textContent || logOutput.textContent === "准备就绪。") {
    logOutput.textContent = line;
  } else {
    logOutput.textContent += `\n${line}`;
  }

  if (level === "error") {
    logOutput.dataset.level = "error";
  }

  logOutput.scrollTop = logOutput.scrollHeight;
}

function setRunningState(running) {
  isRunning = running;
  startButton.disabled = running;
  cancelButton.disabled = !running;
  browseButton.disabled = running;
  manifestBrowseButton.disabled = running;
  resumeTailButton.disabled = running || !selectedManifestPath;
  resumeMissingButton.disabled = running || !selectedManifestPath;
  urlInput.disabled = running;
  startInput.disabled = running;
  lastInput.disabled = running;
}

function setTaskStats(progress = {}) {
  totalStat.textContent = String(progress.totalChapters ?? 0);
  successStat.textContent = String(progress.successCount ?? 0);
  failedStat.textContent = String((progress.failedCount ?? 0) + (progress.blockedCount ?? 0));
  missingStat.textContent = String(progress.missingCount ?? 0);
  currentStatusStat.textContent = getDisplayState(progress);
}

function setManifestOverview(overview = null) {
  selectedManifestOverview = overview;
  overviewTitleStat.textContent = overview?.novelTitle ?? "未选择";
  latestSuccessStat.textContent = formatPointerLabel(overview?.latestSuccessLabel, overview?.latestSuccessOrder);
  nextForwardStat.textContent = formatPointerLabel(overview?.nextForwardLabel, overview?.nextForwardOrder);
  overviewMissingStat.textContent = String(overview?.missingCount ?? 0);
  runKindStat.textContent = RUN_KIND_LABELS[overview?.runKind] ?? "未选择";
  resumeHint.textContent = getResumeHint(overview ?? {});

  if (!isRunning) {
    resumeTailButton.disabled = !selectedManifestPath;
    resumeMissingButton.disabled = !selectedManifestPath;
  }
}

function updateReportHint() {
  if (latestReportPath) {
    reportHint.textContent = `任务报告已生成：${latestReportPath}`;
    return;
  }

  if (latestManifestPath) {
    reportHint.textContent = `任务清单已生成：${latestManifestPath}`;
    return;
  }

  reportHint.textContent = "任务开始后会在作品目录下生成 `_session/manifest.json` 和 `report.json`。";
}

function setReportAvailability() {
  openReportButton.disabled = !latestSessionDirectory;
  updateReportHint();
}

function setStatus(event) {
  statusText.textContent = STATUS_LABELS[event.status] ?? event.status;
  statusMessage.textContent = event.message || "等待中";
  document.body.dataset.status = event.status;
  currentStatusStat.textContent = getDisplayState(event);

  if (event.status === "running") {
    setRunningState(true);
  }

  if (["completed", "failed", "cancelled", "partial", "idle", "blocked"].includes(event.status)) {
    setRunningState(false);
  }
}

async function chooseOutputDirectory() {
  const result = await bridge.selectOutputDirectory();
  if (!result.canceled && result.path) {
    outputInput.value = result.path;
  }
}

async function chooseManifestFile() {
  try {
    const result = await bridge.selectManifestFile();
    if (result.canceled || !result.path) {
      return;
    }

    const overview = await bridge.readManifestOverview(result.path);
    selectedManifestPath = result.path;
    latestSessionDirectory = overview.sessionDirectory ?? latestSessionDirectory;
    latestManifestPath = result.path;
    manifestInput.value = result.path;
    setManifestOverview(overview);
    setReportAvailability();
    appendLog(`已加载任务清单：${result.path}`);
  } catch (error) {
    appendLog(error.message || "读取任务清单失败。", "error");
  }
}

async function startDownload() {
  const payload = {
    url: urlInput.value,
    startIndex: startInput.value,
    lastIndex: lastInput.value,
    outputRoot: outputInput.value,
  };

  appendLog("准备启动下载任务。");

  try {
    await bridge.startDownload(payload);
    latestSessionDirectory = null;
    latestManifestPath = null;
    latestReportPath = null;
    setTaskStats({
      totalChapters: 0,
      successCount: 0,
      failedCount: 0,
      missingCount: 0,
      currentStatus: "running",
    });
    setReportAvailability();
  } catch (error) {
    appendLog(error.message || "启动任务失败。", "error");
    setStatus({
      status: "failed",
      message: error.message || "启动任务失败",
    });
  }
}

async function startResume(mode) {
  if (!selectedManifestPath) {
    appendLog("请先选择 manifest.json。", "warn");
    return;
  }

  const startFn = mode === "resume-tail" ? bridge.startResumeTail : bridge.startResumeMissing;
  const startMessage =
    mode === "resume-tail"
      ? "准备继续主线爬取。"
      : "准备补抓缺失章节。";

  appendLog(startMessage);

  try {
    await startFn({ manifestPath: selectedManifestPath });
    latestReportPath = null;
    setTaskStats({
      totalChapters: selectedManifestOverview?.missingCount ?? 0,
      successCount: 0,
      failedCount: 0,
      missingCount: selectedManifestOverview?.missingCount ?? 0,
      currentStatus: "running",
    });
    setReportAvailability();
  } catch (error) {
    appendLog(error.message || "启动恢复任务失败。", "error");
    setStatus({
      status: "failed",
      message: error.message || "启动恢复任务失败",
    });
  }
}

async function cancelDownload() {
  const result = await bridge.cancelDownload();
  if (result.cancelled) {
    appendLog("已发送取消请求。", "warn");
  }
}

async function openTaskReportDirectory() {
  try {
    const result = await bridge.openTaskReportDirectory();
    if (!result.opened) {
      appendLog(result.message || "当前没有可打开的任务报告目录。", "warn");
      return;
    }

    appendLog(`已打开任务报告目录：${result.path}`);
  } catch (error) {
    appendLog(error.message || "打开任务报告目录失败。", "error");
  }
}

function registerEventListeners() {
  browseButton.addEventListener("click", () => {
    void chooseOutputDirectory();
  });

  manifestBrowseButton.addEventListener("click", () => {
    void chooseManifestFile();
  });

  startButton.addEventListener("click", () => {
    void startDownload();
  });

  resumeTailButton.addEventListener("click", () => {
    void startResume("resume-tail");
  });

  resumeMissingButton.addEventListener("click", () => {
    void startResume("resume-missing");
  });

  cancelButton.addEventListener("click", () => {
    void cancelDownload();
  });

  openReportButton.addEventListener("click", () => {
    void openTaskReportDirectory();
  });

  clearLogButton.addEventListener("click", () => {
    logOutput.textContent = "日志已清空。";
  });

  bridge.onLog((entry) => {
    appendLog(entry.message, entry.level);
  });

  bridge.onStatus((event) => {
    setStatus(event);
  });

  bridge.onProgress((event) => {
    if (event.sessionDirectory) {
      latestSessionDirectory = event.sessionDirectory;
    }

    if (event.manifestPath) {
      latestManifestPath = event.manifestPath;
    }

    if (event.reportPath) {
      latestReportPath = event.reportPath;
    }

    setManifestOverview({
      novelTitle: event.novelTitle ?? selectedManifestOverview?.novelTitle,
      runKind: event.runKind ?? selectedManifestOverview?.runKind,
      latestSuccessOrder: event.latestSuccessOrder ?? selectedManifestOverview?.latestSuccessOrder ?? null,
      latestSuccessChapterKey: event.latestSuccessChapterKey ?? selectedManifestOverview?.latestSuccessChapterKey ?? null,
      latestSuccessLabel: event.latestSuccessLabel ?? selectedManifestOverview?.latestSuccessLabel ?? "无",
      nextForwardOrder: event.nextForwardOrder ?? selectedManifestOverview?.nextForwardOrder ?? null,
      nextForwardChapterKey: event.nextForwardChapterKey ?? selectedManifestOverview?.nextForwardChapterKey ?? null,
      nextForwardLabel: event.nextForwardLabel ?? selectedManifestOverview?.nextForwardLabel ?? "无",
      missingCount: event.missingCount ?? selectedManifestOverview?.missingCount ?? 0,
      missingChapterKeys: event.missingChapterKeys ?? selectedManifestOverview?.missingChapterKeys ?? [],
    });
    setTaskStats(event);
    setReportAvailability();
  });

  bridge.onTaskFinished((result) => {
    if (result.summary?.sessionDirectory) {
      latestSessionDirectory = result.summary.sessionDirectory;
    }

    if (result.summary?.manifestPath) {
      latestManifestPath = result.summary.manifestPath;
    }

    if (result.summary?.reportPath) {
      latestReportPath = result.summary.reportPath;
    }

    if (result.summary) {
      setManifestOverview({
        novelTitle: result.summary.contentTitle,
        runKind: result.summary.lastRunMode,
        latestSuccessOrder: result.summary.latestSuccessOrder,
        latestSuccessChapterKey: result.summary.latestSuccessChapterKey,
        latestSuccessLabel: result.summary.latestSuccessLabel,
        nextForwardOrder: result.summary.nextForwardOrder,
        nextForwardChapterKey: result.summary.nextForwardChapterKey,
        nextForwardLabel: result.summary.nextForwardLabel,
        missingCount: result.summary.missingCount,
        missingChapterKeys: result.summary.missingChapterKeys,
      });
      setTaskStats({
        totalChapters: result.summary.totalChapters,
        successCount: result.summary.completedChapters,
        failedCount: result.summary.failedCount ?? result.summary.failedChapters,
        blockedCount: result.summary.blockedCount ?? 0,
        missingCount: result.summary.missingCount,
        currentStatus: result.summary.finalStatus,
        phase: result.summary.phase,
      });
      setReportAvailability();
    }

    if (result.ok) {
      if (result.summary?.resumeDisposition && result.summary.resumeDisposition !== "started") {
        appendLog(
          `恢复任务无需继续执行：${result.summary.resumeDisposition === "already-at-tail" ? "主线已完成，可改用补漏章节。" : "已无可继续章节。"}`,
        );
        return;
      }
      appendLog(
        `任务结束。状态=${STATUS_LABELS[result.summary.finalStatus] ?? result.summary.finalStatus}，成功 ${result.summary.completedChapters} / ${result.summary.totalChapters}，缺失 ${result.summary.missingCount}。`,
      );
      return;
    }

    if (result.cancelled) {
      appendLog("任务已取消。", "warn");
      return;
    }

    appendLog(result.error?.message || "任务失败。", "error");
  });
}

async function bootstrap() {
  if (!bridge) {
    setStatus({
      status: "failed",
      message: "桌面桥接未加载，应用无法运行。",
    });
    appendLog("预加载桥接未成功注入，按钮和目录选择不可用。", "error");
    startButton.disabled = true;
    browseButton.disabled = true;
    return;
  }

  try {
    const outputDirectory = await bridge.getDefaultOutputDirectory();
    if (outputDirectory?.path) {
      outputInput.value = outputDirectory.path;
    }

    setStatus({
      status: "idle",
      message: "等待输入下载参数。",
    });
    setTaskStats({
      totalChapters: 0,
      successCount: 0,
      failedCount: 0,
      missingCount: 0,
      currentStatus: "idle",
    });
    setManifestOverview(null);
    setReportAvailability();
    registerEventListeners();
  } catch (error) {
    setStatus({
      status: "failed",
      message: "初始化失败。",
    });
    appendLog(error.message || "初始化桌面应用时发生错误。", "error");
    startButton.disabled = true;
    browseButton.disabled = true;
  }
}

void bootstrap();
