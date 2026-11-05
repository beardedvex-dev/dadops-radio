// What the radio page can ask the desktop app for. The app only answers
// pages from the radio's own address (checked in main.js).
"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dadopsDesktop", {
  onInput: (fn) => ipcRenderer.on("dadops:input", (_e, ev) => fn(ev)),
  overlay: (state) => ipcRenderer.send("dadops:overlay", state),
  getPrefs: () => ipcRenderer.invoke("dadops:prefs:get"),
  setPrefs: (p) => ipcRenderer.invoke("dadops:prefs:set", p),
  onPrefs: (fn) => ipcRenderer.on("dadops:prefs", (_e, p) => fn(p)),
  installUpdate: () => ipcRenderer.send("dadops:install-update"),
  pda: (show) => ipcRenderer.send("dadops:pda", show),
  setPdaKey: () => ipcRenderer.send("dadops:pda-key"),
});
