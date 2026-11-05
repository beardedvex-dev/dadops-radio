"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("kitBridge", {
  onLayout: (fn) => ipcRenderer.on("kit:layout", (_e, l) => fn(l)),
  onStatus: (fn) => ipcRenderer.on("kit:status", (_e, s) => fn(s)),
  cmd: (c) => ipcRenderer.send("kit:cmd", c),
});
