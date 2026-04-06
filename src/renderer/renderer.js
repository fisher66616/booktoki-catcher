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
const bridge = window.booktokiCatcher;

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
  const result = await bridge.selectOutputDirectory();
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
    await bridge.startDownload(payload);
  } catch (error) {
    appendLog(error.message || "启动任务失败。", "error");
    setStatus({
      status: "failed",
      message: error.message || "启动任务失败",
    });
  }
}

async function cancelDownload() {
  const result = await bridge.cancelDownload();
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

  bridge.onLog((entry) => {
    appendLog(entry.message, entry.level);
  });

  bridge.onStatus((event) => {
    setStatus(event);
  });

  bridge.onTaskFinished((result) => {
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
