"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("overlayBridge", {
  onState: (fn) => ipcRenderer.on("dadops:overlay-state", (_e, s) => fn(s)),
});
