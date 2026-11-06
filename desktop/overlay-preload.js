"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("overlayBridge", {
  onState: (fn) => ipcRenderer.on("dadops:overlay-state", (_e, s) => fn(s)),
  onMode: (fn) => ipcRenderer.on("dadops:overlay-mode", (_e, m) => fn(m)),
  done: () => ipcRenderer.send("dadops:overlay-done"),
});
