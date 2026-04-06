const statusText = document.querySelector("#statusText");
const statusMessage = document.querySelector("#statusMessage");
const urlInput = document.querySelector("#urlInput");
const startInput = document.querySelector("#startInput");
const lastInput = document.querySelector("#lastInput");
const outputInput = document.querySelector("#outputInput");
const startButton = document.querySelector("#startButton");
const cancelButton = document.querySelector("#cancelButton");
const browseButton = document.querySelector("#browseButton");
const clearLogButton = document.querySelector("#clearLogButton");
const logOutput = document.querySelector("#logOutput");

const STATUS_LABELS = {
  idle: "未开始",
  running: "运行中",
  completed: "完成",
  failed: "失败",
  cancelled: "已取消",
  partial: "部分完成",
};

let isRunning = false;

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
  urlInput.disabled = running;
  startInput.disabled = running;
  lastInput.disabled = running;
}

function setStatus(event) {
  statusText.textContent = STATUS_LABELS[event.status] ?? event.status;
  statusMessage.textContent = event.message || "等待中";
  document.body.dataset.status = event.status;

  if (event.status === "running") {
    setRunningState(true);
  }

  if (["completed", "failed", "cancelled", "partial", "idle"].includes(event.status)) {
    setRunningState(false);
  }
}

async function chooseOutputDirectory() {
  const result = await window.booktokiCatcher.selectOutputDirectory();
  if (!result.canceled && result.path) {
    outputInput.value = result.path;
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
    await window.booktokiCatcher.startDownload(payload);
  } catch (error) {
    appendLog(error.message || "启动任务失败。", "error");
    setStatus({
      status: "failed",
      message: error.message || "启动任务失败",
    });
  }
}

async function cancelDownload() {
  const result = await window.booktokiCatcher.cancelDownload();
  if (result.cancelled) {
    appendLog("已发送取消请求。", "warn");
  }
}

function registerEventListeners() {
  browseButton.addEventListener("click", () => {
    void chooseOutputDirectory();
  });

  startButton.addEventListener("click", () => {
    void startDownload();
  });

  cancelButton.addEventListener("click", () => {
    void cancelDownload();
  });

  clearLogButton.addEventListener("click", () => {
    logOutput.textContent = "日志已清空。";
  });

  window.booktokiCatcher.onLog((entry) => {
    appendLog(entry.message, entry.level);
  });

  window.booktokiCatcher.onStatus((event) => {
    setStatus(event);
  });

  window.booktokiCatcher.onTaskFinished((result) => {
    if (result.ok) {
      appendLog(`任务结束。共完成 ${result.summary.completedChapters} 个章节。`);
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
  const outputDirectory = await window.booktokiCatcher.getDefaultOutputDirectory();
  if (outputDirectory?.path) {
    outputInput.value = outputDirectory.path;
  }

  setStatus({
    status: "idle",
    message: "等待输入下载参数。",
  });
  registerEventListeners();
}

void bootstrap();
