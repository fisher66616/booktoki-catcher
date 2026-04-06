const { contextBridge, ipcRenderer } = require("electron");

const CHANNELS = {
  defaultOutputDirectory: "app:get-default-output-directory",
  selectOutputDirectory: "dialog:select-output-directory",
  startDownload: "download:start",
  cancelDownload: "download:cancel",
  log: "download:log",
  status: "download:status",
  taskFinished: "download:finished",
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
  startDownload: (payload) => ipcRenderer.invoke(CHANNELS.startDownload, sanitizePayload(payload)),
  cancelDownload: () => ipcRenderer.invoke(CHANNELS.cancelDownload),
  onLog: (callback) => subscribe(CHANNELS.log, callback, "onLog"),
  onStatus: (callback) => subscribe(CHANNELS.status, callback, "onStatus"),
  onTaskFinished: (callback) => subscribe(CHANNELS.taskFinished, callback, "onTaskFinished"),
});
