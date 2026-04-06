import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, dialog, ipcMain } from "electron";

import { CancelledError } from "../src/core/errors.js";
import { downloadSeries, parseDownloadRequest, STATUS } from "../src/core/downloader.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CHANNELS = {
  defaultOutputDirectory: "app:get-default-output-directory",
  selectOutputDirectory: "dialog:select-output-directory",
  startDownload: "download:start",
  cancelDownload: "download:cancel",
  log: "download:log",
  status: "download:status",
  taskFinished: "download:finished",
};

let mainWindow = null;
let currentTask = null;

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 1024,
    minHeight: 720,
    title: "Booktoki Catcher",
    show: false,
    backgroundColor: "#efe4d4",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, "../src/renderer/index.html"));

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
    });

    sendToRenderer(CHANNELS.taskFinished, {
      ok: true,
      summary,
    });
  } catch (error) {
    const cancelled = error instanceof CancelledError || error?.code === "CANCELLED";

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
}

app.whenReady().then(() => {
  registerIpcHandlers();
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
