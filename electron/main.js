import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";

import { CancelledError } from "../src/core/errors.js";
import { downloadSeries, parseDownloadRequest, STATUS } from "../src/core/downloader.js";
import { loadManifestOverview } from "../src/core/session-manifest.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isDevelopment = !app.isPackaged;
const appDisplayName = isDevelopment ? "Booktoki Catcher Dev" : "Booktoki Catcher";

app.setName(appDisplayName);
app.setPath("userData", path.join(app.getPath("appData"), appDisplayName));

const CHANNELS = {
  defaultOutputDirectory: "app:get-default-output-directory",
  selectOutputDirectory: "dialog:select-output-directory",
  selectManifestFile: "dialog:select-manifest-file",
  readManifestOverview: "manifest:read-overview",
  startDownload: "download:start",
  startResumeTail: "download:start-resume-tail",
  startResumeMissing: "download:start-resume-missing",
  cancelDownload: "download:cancel",
  log: "download:log",
  status: "download:status",
  progress: "download:progress",
  taskFinished: "download:finished",
  openTaskReportDirectory: "app:open-task-report-directory",
};

let mainWindow = null;
let currentTask = null;
let latestSessionDirectory = null;
const gotSingleInstanceLock = app.requestSingleInstanceLock();

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }

    mainWindow.show();
    mainWindow.focus();
    return mainWindow;
  }

  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 1024,
    minHeight: 720,
    title: "Booktoki Catcher",
    show: false,
    backgroundColor: "#efe4d4",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, "../src/renderer/index.html")).catch((error) => {
    console.error("Failed to load renderer window:", error);
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    sendToRenderer(CHANNELS.status, {
      status: STATUS.IDLE,
      message: "未开始",
      timestamp: new Date().toISOString(),
    });
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  return mainWindow;
}

function serializeError(error) {
  return {
    code: error?.code ?? "UNKNOWN_ERROR",
    message: error?.message ?? "发生未知错误",
  };
}

function sanitizeGuiPayload(payload) {
  const request = parseDownloadRequest({
    url: payload?.url ?? "",
    startIndex: payload?.startIndex ?? undefined,
    lastIndex: payload?.lastIndex ?? undefined,
    outputRoot: payload?.outputRoot ?? "",
    outputMode: "title-root",
  });

  return {
    url: request.url,
    startIndex: request.startIndex,
    lastIndex: request.lastIndex,
    outputRoot: request.outputRoot,
  };
}

function sanitizeResumePayload(payload, mode) {
  const request = parseDownloadRequest({
    outputMode: "title-root",
    resumeTailManifestPath: mode === "resume-tail" ? payload?.manifestPath ?? "" : undefined,
    resumeMissingManifestPath: mode === "resume-missing" ? payload?.manifestPath ?? "" : undefined,
  });

  return {
    resumeTailManifestPath: request.resumeTailManifestPath,
    resumeMissingManifestPath: request.resumeMissingManifestPath,
  };
}

async function runDownloadTask(payload, controller) {
  try {
    const summary = await downloadSeries({
      ...payload,
      outputMode: "title-root",
      signal: controller.signal,
      onLog: (entry) => {
        sendToRenderer(CHANNELS.log, entry);
      },
      onStatus: (event) => {
        sendToRenderer(CHANNELS.status, event);
      },
      onProgress: (event) => {
        if (event.sessionDirectory) {
          latestSessionDirectory = event.sessionDirectory;
          if (currentTask) {
            currentTask.sessionDirectory = event.sessionDirectory;
          }
        }
        sendToRenderer(CHANNELS.progress, event);
      },
    });

    if (summary.sessionDirectory) {
      latestSessionDirectory = summary.sessionDirectory;
    }

    sendToRenderer(CHANNELS.taskFinished, {
      ok: true,
      summary,
    });
  } catch (error) {
    const cancelled = error instanceof CancelledError || error?.code === "CANCELLED";
    if (error?.summary?.sessionDirectory) {
      latestSessionDirectory = error.summary.sessionDirectory;
    }

    sendToRenderer(CHANNELS.taskFinished, {
      ok: false,
      cancelled,
      error: serializeError(error),
      summary: error?.summary ?? null,
    });
  } finally {
    currentTask = null;
  }
}

function registerIpcHandlers() {
  ipcMain.handle(CHANNELS.defaultOutputDirectory, async () => {
    return {
      path: app.getPath("downloads"),
    };
  });

  ipcMain.handle(CHANNELS.selectOutputDirectory, async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory", "createDirectory"],
    });

    if (result.canceled || !result.filePaths[0]) {
      return {
        canceled: true,
      };
    }

    return {
      canceled: false,
      path: result.filePaths[0],
    };
  });

  ipcMain.handle(CHANNELS.selectManifestFile, async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openFile"],
      filters: [{ name: "Manifest JSON", extensions: ["json"] }],
      defaultPath: latestSessionDirectory ?? app.getPath("downloads"),
    });

    if (result.canceled || !result.filePaths[0]) {
      return {
        canceled: true,
      };
    }

    return {
      canceled: false,
      path: result.filePaths[0],
    };
  });

  ipcMain.handle(CHANNELS.readManifestOverview, async (_event, manifestPath) => {
    const overview = loadManifestOverview(String(manifestPath ?? ""));
    latestSessionDirectory = overview.sessionDirectory;

    return overview;
  });

  ipcMain.handle(CHANNELS.startDownload, async (_event, payload) => {
    if (currentTask) {
      throw new Error("已有下载任务正在运行");
    }

    const sanitizedPayload = sanitizeGuiPayload(payload);
    const controller = new AbortController();
    currentTask = {
      controller,
    };

    void runDownloadTask(sanitizedPayload, controller);

    return {
      accepted: true,
    };
  });

  ipcMain.handle(CHANNELS.startResumeTail, async (_event, payload) => {
    if (currentTask) {
      throw new Error("已有下载任务正在运行");
    }

    const sanitizedPayload = sanitizeResumePayload(payload, "resume-tail");
    const controller = new AbortController();
    currentTask = {
      controller,
    };

    void runDownloadTask(sanitizedPayload, controller);

    return {
      accepted: true,
    };
  });

  ipcMain.handle(CHANNELS.startResumeMissing, async (_event, payload) => {
    if (currentTask) {
      throw new Error("已有下载任务正在运行");
    }

    const sanitizedPayload = sanitizeResumePayload(payload, "resume-missing");
    const controller = new AbortController();
    currentTask = {
      controller,
    };

    void runDownloadTask(sanitizedPayload, controller);

    return {
      accepted: true,
    };
  });

  ipcMain.handle(CHANNELS.cancelDownload, async () => {
    if (!currentTask) {
      return {
        cancelled: false,
      };
    }

    currentTask.controller.abort();

    return {
      cancelled: true,
    };
  });

  ipcMain.handle(CHANNELS.openTaskReportDirectory, async () => {
    if (!latestSessionDirectory) {
      return {
        opened: false,
        message: "当前还没有可打开的任务报告目录。",
      };
    }

    const result = await shell.openPath(latestSessionDirectory);
    if (result) {
      return {
        opened: false,
        message: result,
      };
    }

    return {
      opened: true,
      path: latestSessionDirectory,
    };
  });
}

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    createMainWindow();
  });

  app.whenReady().then(() => {
    registerIpcHandlers();
    createMainWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow();
      } else {
        createMainWindow();
      }
    });
  });
}

app.on("window-all-closed", () => {
  if (isDevelopment || process.platform !== "darwin") {
    app.quit();
  }
});
