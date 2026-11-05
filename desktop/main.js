// =====================================================================
//  DAD Ops Radio - desktop app (Windows)
//
//  A small window around the radio page (the same one that runs in the
//  browser), plus the three things a browser can't do:
//    1. Talk keys that work while the game has focus (keyboard and mouse
//       buttons, including Mouse 4/5).
//    2. An in-game overlay: a see-through, click-through window on top.
//    3. Living in the system tray, starting with Windows and updating
//       itself from GitHub releases.
// =====================================================================
"use strict";
const { app, BrowserWindow, Tray, Menu, ipcMain, session, screen, nativeImage, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const { keyFromHook, buttonFromHook } = require("./keys");

const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
const RADIO_URL = (process.env.DADOPS_RADIO_URL || CONFIG.radioUrl).replace(/\/+$/, "");
const RADIO_ORIGIN = new URL(RADIO_URL).origin;
const ICON = path.join(__dirname, "build", "icon.png");

// Sign-in passes through Discord and Supabase; everything else opens in the real browser.
const ALLOWED = [RADIO_ORIGIN, "https://discord.com", "https://canary.discord.com", "https://ptb.discord.com"];
const allowed = (url) => {
  try { const u = new URL(url); return ALLOWED.includes(u.origin) || /\.supabase\.co$/.test(u.hostname); } catch { return false; }
};
const fromRadio = (e) => { try { return new URL(e.senderFrame.url).origin === RADIO_ORIGIN; } catch { return false; } };

// Sound must keep playing while the game is in front.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.setAppUserModelId("gg.dadops.radio");

if (!app.requestSingleInstanceLock()) { app.quit(); }

// ---------- saved settings ----------
const PREFS_FILE = () => path.join(app.getPath("userData"), "prefs.json");
let prefs = { overlay: true, startWithWindows: false };
function loadPrefs() { try { prefs = { ...prefs, ...JSON.parse(fs.readFileSync(PREFS_FILE(), "utf8")) }; } catch {} }
function savePrefs() { try { fs.writeFileSync(PREFS_FILE(), JSON.stringify(prefs, null, 2)); } catch {} }

let win = null, overlay = null, tray = null, quitting = false, lastOverlay = null, update = null;

function createWindow(startHidden) {
  win = new BrowserWindow({
    width: 500, height: 900, minWidth: 380, minHeight: 520,
    title: "DAD Ops Radio", icon: ICON, backgroundColor: "#0E0E0B", autoHideMenuBar: true, show: !startHidden,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  win.setMenuBarVisibility(false);
  win.loadURL(RADIO_URL + "/");

  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e, url) => { if (!allowed(url)) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); } });
  win.webContents.on("did-fail-load", (_e, code, desc, url, isMain) => {
    if (isMain && code !== -3) setTimeout(() => win && !win.isDestroyed() && win.loadURL(RADIO_URL + "/"), 5000);
  });
  win.on("close", (e) => { if (!quitting) { e.preventDefault(); win.hide(); } });
  // Mouse 4/5 inside the window must not act as Back/Forward.
  win.on("app-command", (e) => e.preventDefault());
}

function createOverlay() {
  const d = screen.getPrimaryDisplay().workArea;
  overlay = new BrowserWindow({
    x: d.x + 16, y: d.y + 16, width: 320, height: 300,
    frame: false, transparent: true, resizable: false, movable: false, focusable: false, skipTaskbar: true,
    alwaysOnTop: true, hasShadow: false, show: false,
    webPreferences: { preload: path.join(__dirname, "overlay-preload.js"), contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  overlay.setAlwaysOnTop(true, "screen-saver");
  overlay.setIgnoreMouseEvents(true);
  overlay.setVisibleOnAllWorkspaces(true);
  overlay.loadFile(path.join(__dirname, "overlay.html"));
  overlay.webContents.on("will-navigate", (e) => e.preventDefault());
}

function showOverlay() {
  if (!overlay || overlay.isDestroyed()) return;
  const want = prefs.overlay && lastOverlay && lastOverlay.on;
  if (want && !overlay.isVisible()) overlay.showInactive();
  if (!want && overlay.isVisible()) overlay.hide();
  if (lastOverlay) overlay.webContents.send("dadops:overlay-state", lastOverlay);
}

function applyStartWithWindows() {
  try { app.setLoginItemSettings({ openAtLogin: !!prefs.startWithWindows, args: ["--hidden"] }); } catch {}
}

function buildTray() {
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.setToolTip("DAD Ops Radio");
  const menu = () => Menu.buildFromTemplate([
    { label: "Open DAD Ops Radio", click: () => { win.show(); win.focus(); } },
    { type: "separator" },
    { label: "Show overlay in-game", type: "checkbox", checked: prefs.overlay, click: (m) => { prefs.overlay = m.checked; savePrefs(); showOverlay(); sendPrefs(); } },
    { label: "Start with Windows", type: "checkbox", checked: prefs.startWithWindows, click: (m) => { prefs.startWithWindows = m.checked; savePrefs(); applyStartWithWindows(); sendPrefs(); } },
    ...(update ? [{ type: "separator" }, { label: `Restart to update (v${update})`, click: () => installUpdate() }] : []),
    { type: "separator" },
    { label: "Quit", click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu());
  tray.on("click", () => { win.isVisible() ? win.focus() : win.show(); });
  tray.refresh = () => tray.setContextMenu(menu());
}

function sendPrefs() {
  if (win && !win.isDestroyed()) win.webContents.send("dadops:prefs", { ...prefs, version: app.getVersion(), update });
  if (tray && tray.refresh) tray.refresh();
}

// ---------- talk keys that work in-game ----------
function startHook() {
  let hook;
  try { hook = require("uiohook-napi").uIOhook; } catch (e) { console.error("Global keys unavailable:", e.message); return; }
  const down = new Set();
  const send = (ev) => { if (win && !win.isDestroyed()) win.webContents.send("dadops:input", ev); };
  hook.on("keydown", (e) => { const k = keyFromHook(e.keycode); if (down.has(k)) return; down.add(k); send({ type: "down", code: k }); });
  hook.on("keyup", (e) => { const k = keyFromHook(e.keycode); down.delete(k); send({ type: "up", code: k }); });
  hook.on("mousedown", (e) => { const b = buttonFromHook(e.button); if (b == null || b === 0 || b === 2) return; send({ type: "down", button: b }); });
  hook.on("mouseup", (e) => { const b = buttonFromHook(e.button); if (b == null || b === 0 || b === 2) return; send({ type: "up", button: b }); });
  try { hook.start(); } catch (e) { console.error("Global keys failed to start:", e.message); }
  app.on("will-quit", () => { try { hook.stop(); } catch {} });
}

// ---------- updates ----------
function startUpdates() {
  if (!app.isPackaged) return;
  let au;
  try { au = require("electron-updater").autoUpdater; } catch { return; }
  au.autoDownload = true;
  au.autoInstallOnAppQuit = true;
  au.on("update-downloaded", (info) => { update = info.version; sendPrefs(); });
  au.on("error", () => {});
  const check = () => au.checkForUpdates().catch(() => {});
  check();
  setInterval(check, 6 * 3600e3);
}
function installUpdate() {
  try { quitting = true; require("electron-updater").autoUpdater.quitAndInstall(true, true); } catch {}
}

// ---------- messages from the radio page ----------
ipcMain.on("dadops:overlay", (e, state) => {
  if (!fromRadio(e) || !state || typeof state !== "object") return;
  lastOverlay = state;
  showOverlay();
});
ipcMain.handle("dadops:prefs:get", (e) => (fromRadio(e) ? { ...prefs, version: app.getVersion(), update } : null));
ipcMain.handle("dadops:prefs:set", (e, p) => {
  if (!fromRadio(e) || !p || typeof p !== "object") return null;
  if ("overlay" in p) prefs.overlay = !!p.overlay;
  if ("startWithWindows" in p) { prefs.startWithWindows = !!p.startWithWindows; applyStartWithWindows(); }
  savePrefs(); showOverlay(); sendPrefs();
  return { ...prefs, version: app.getVersion(), update };
});
ipcMain.on("dadops:install-update", (e) => { if (fromRadio(e) && update) installUpdate(); });

app.on("second-instance", () => { if (win) { win.show(); win.focus(); } });
app.on("before-quit", () => { quitting = true; });
app.on("window-all-closed", (e) => e.preventDefault());

app.whenReady().then(() => {
  loadPrefs();
  // The microphone, for the radio page only.
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb, details) => {
    const origin = (() => { try { return new URL(details.requestingUrl || wc.getURL()).origin; } catch { return ""; } })();
    cb(origin === RADIO_ORIGIN && (perm === "media" || perm === "audioCapture"));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, perm, origin) => origin === RADIO_ORIGIN && (perm === "media" || perm === "audioCapture"));
  createWindow(process.argv.includes("--hidden"));
  createOverlay();
  buildTray();
  applyStartWithWindows();
  startHook();
  startUpdates();
});
