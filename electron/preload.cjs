const { contextBridge, ipcRenderer } = require("electron");

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

function ensureCallback(callback, eventName) {
  if (typeof callback !== "function") {
    throw new TypeError(`${eventName} 需要回调函数`);
  }
}

function subscribe(channel, callback, eventName) {
  ensureCallback(callback, eventName);

  const listener = (_event, payload) => {
    callback(payload);
  };

  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

function sanitizePayload(payload) {
  return {
    url: String(payload?.url ?? "").trim(),
    startIndex: String(payload?.startIndex ?? "").trim(),
    lastIndex: String(payload?.lastIndex ?? "").trim(),
    outputRoot: String(payload?.outputRoot ?? "").trim(),
  };
}

contextBridge.exposeInMainWorld("booktokiCatcher", {
  getDefaultOutputDirectory: () => ipcRenderer.invoke(CHANNELS.defaultOutputDirectory),
  selectOutputDirectory: () => ipcRenderer.invoke(CHANNELS.selectOutputDirectory),
  selectManifestFile: () => ipcRenderer.invoke(CHANNELS.selectManifestFile),
  readManifestOverview: (manifestPath) => ipcRenderer.invoke(CHANNELS.readManifestOverview, String(manifestPath ?? "").trim()),
  startDownload: (payload) => ipcRenderer.invoke(CHANNELS.startDownload, sanitizePayload(payload)),
  startResumeTail: (payload) =>
    ipcRenderer.invoke(CHANNELS.startResumeTail, {
      manifestPath: String(payload?.manifestPath ?? "").trim(),
    }),
  startResumeMissing: (payload) =>
    ipcRenderer.invoke(CHANNELS.startResumeMissing, {
      manifestPath: String(payload?.manifestPath ?? "").trim(),
    }),
  cancelDownload: () => ipcRenderer.invoke(CHANNELS.cancelDownload),
  openTaskReportDirectory: () => ipcRenderer.invoke(CHANNELS.openTaskReportDirectory),
  onLog: (callback) => subscribe(CHANNELS.log, callback, "onLog"),
  onStatus: (callback) => subscribe(CHANNELS.status, callback, "onStatus"),
  onProgress: (callback) => subscribe(CHANNELS.progress, callback, "onProgress"),
  onTaskFinished: (callback) => subscribe(CHANNELS.taskFinished, callback, "onTaskFinished"),
});
