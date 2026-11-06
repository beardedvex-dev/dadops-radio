// =====================================================================
//  Dad Net - desktop app (Windows)
//
//  One "field kit" window: a rugged chassis (shell.html) with two separate
//  pages inside it:
//    * the radio page (the same one that runs in the browser), always on
//    * the Battle Board (board.html on the radio's own address), folded out
//      to the right on demand: tonight's op, the squad board, timers, notes
//  They are separate pages side by side, so nothing the board does can drop
//  you off the radio. The radio page tells the board what's going on.
//
//  Plus the things a browser can't do:
//    1. Talk keys that work while the game has focus (keyboard and mouse
//       buttons, including Mouse 4/5), and the F9 key for the kit.
//    2. An in-game overlay: a see-through, click-through window on top.
//    3. The system tray, starting with Windows, and updating itself from
//       GitHub releases.
// =====================================================================
"use strict";
const { app, BaseWindow, BrowserWindow, WebContentsView, Tray, Menu, ipcMain, session, screen, nativeImage, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const { keyFromHook, buttonFromHook } = require("./keys");

const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
const RADIO_URL = (process.env.DADOPS_RADIO_URL || CONFIG.radioUrl).replace(/\/+$/, "");
const RADIO_ORIGIN = new URL(RADIO_URL).origin;
const BOARD_URL = RADIO_URL + "/board?kit=1";
const ICON = path.join(__dirname, "build", "icon.png");

// Sign-in passes through Discord and Supabase; everything else opens in the real browser.
const ALLOWED = [RADIO_ORIGIN, "https://discord.com", "https://canary.discord.com", "https://ptb.discord.com"];
const allowed = (url) => {
  try { const u = new URL(url); return ALLOWED.includes(u.origin) || /\.supabase\.co$/.test(u.hostname); } catch { return false; }
};
const fromRadio = (e) => { try { return new URL(e.senderFrame.url).origin === RADIO_ORIGIN; } catch { return false; } };
const fromShell = (e) => { try { return e.sender === (shellView && shellView.webContents); } catch { return false; } };

// Sound must keep playing while the game is in front.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.setAppUserModelId("gg.dadops.radio");

if (!app.requestSingleInstanceLock()) { app.quit(); }

// ---------- saved settings ----------
const PREFS_FILE = () => path.join(app.getPath("userData"), "prefs.json");
let prefs = { overlay: true, startWithWindows: false, pdaKey: { code: "F9" }, unfolded: false, openWidth: 1560, kitBounds: null,
  overlayCorner: "tl", overlayX: null, overlayY: null, overlayScale: 1, overlayOpacity: 1 };
function loadPrefs() { try { prefs = { ...prefs, ...JSON.parse(fs.readFileSync(PREFS_FILE(), "utf8")) }; } catch {} }
function savePrefs() { try { fs.writeFileSync(PREFS_FILE(), JSON.stringify(prefs, null, 2)); } catch {} }

let updState = "", checkNow = null;
let hookState = "starting", hookLast = 0; // the in-game key listener: starting / running / failed
let kit = null, shellView = null, radioView = null, pdaView = null, overlay = null, tray = null;
let quitting = false, lastOverlay = null, update = null, capturingPda = false, unfolded = false, overGame = false, ovMoving = false;

// ---------- the field kit window ----------
// Chassis sizes (match shell.html): outer margin, rim, screen padding, status strip.
const G = { out: 8, rim: 36, pad: 10, status: 26, gap: 10, tab: 30, radioW: 384, hinge: 26 };
const FOLDED_W = 480, OPEN_MIN_W = 1440, MIN_H = 620;

const radioPrefs = () => ({ contextIsolation: true, sandbox: true, backgroundThrottling: false, preload: path.join(__dirname, "preload.js") });

function guard(wc, origin) {
  wc.setWindowOpenHandler(({ url }) => {
    try { if (origin && new URL(url).origin === origin) { wc.loadURL(url); return { action: "deny" }; } } catch {}
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  wc.on("will-navigate", (e, url) => { if (!allowed(url)) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); } });
}

function createKit(startHidden) {
  const wa = screen.getPrimaryDisplay().workArea;
  const b = prefs.kitBounds || {};
  kit = new BaseWindow({
    width: FOLDED_W, height: Math.min(b.height || 880, wa.height), x: b.x, y: b.y,
    minWidth: 420, minHeight: MIN_H, frame: false, title: "Dad Net", icon: ICON,
    backgroundColor: "#1a1914", show: false,
  });

  shellView = new WebContentsView({ webPreferences: { contextIsolation: true, sandbox: true, preload: path.join(__dirname, "shell-preload.js") } });
  kit.contentView.addChildView(shellView);
  shellView.webContents.loadFile(path.join(__dirname, "shell.html"));
  shellView.webContents.on("will-navigate", (e) => e.preventDefault());
  shellView.webContents.on("did-finish-load", () => { layout(); sendStatus(); });

  radioView = new WebContentsView({ webPreferences: radioPrefs() });
  kit.contentView.addChildView(radioView);
  radioView.webContents.loadURL(RADIO_URL + "/");
  guard(radioView.webContents, null);
  radioView.webContents.on("did-fail-load", (_e, code, _d, _u, isMain) => {
    if (isMain && code !== -3) setTimeout(() => radioView && radioView.webContents.loadURL(RADIO_URL + "/"), 5000);
  });

  kit.on("resize", () => { layout(); });
  const keep = () => {
    if (!kit || kit.isMinimized() || kit.isMaximized()) return;
    const r = kit.getBounds();
    prefs.kitBounds = { x: r.x, y: r.y, height: r.height };
    if (unfolded) prefs.openWidth = r.width;
    savePrefs();
  };
  kit.on("moved", keep); kit.on("resized", keep);
  kit.on("close", (e) => { if (!quitting) { e.preventDefault(); hideKit(); } });
  // Mouse 4/5 inside the window must not act as Back/Forward.
  kit.on("app-command", (e) => e.preventDefault());

  if (prefs.unfolded) setUnfolded(true); else layout();
  if (!startHidden) kit.show();
}

function layout() {
  if (!kit) return;
  const [W, H] = kit.getContentSize();
  const chassis = { x: G.out, y: G.out, w: W - G.out * 2 - (unfolded ? 0 : G.tab), h: H - G.out * 2 };
  const scr = { x: chassis.x + G.rim, y: chassis.y + G.rim, w: chassis.w - G.rim * 2, h: chassis.h - G.rim * 2 };
  const area = { x: scr.x + G.pad, y: scr.y + G.pad, w: scr.w - G.pad * 2, h: scr.h - G.pad * 2 - G.status - G.gap };
  const status = { x: area.x, y: area.y + area.h + G.gap, w: area.w, h: G.status };
  let radio, pda = null, hinge = null, tab = null;
  if (unfolded) {
    radio = { x: area.x, y: area.y, w: G.radioW, h: area.h };
    hinge = { x: area.x + G.radioW, y: area.y, w: G.hinge, h: area.h };
    pda = { x: hinge.x + G.hinge, y: area.y, w: area.w - G.radioW - G.hinge, h: area.h };
  } else {
    radio = { x: area.x, y: area.y, w: area.w, h: area.h };
    tab = { x: chassis.x + chassis.w - 2, y: chassis.y + Math.round(chassis.h / 2) - 95, w: G.tab, h: 190 };
  }
  const r = (o) => ({ x: Math.round(o.x), y: Math.round(o.y), width: Math.max(1, Math.round(o.w)), height: Math.max(1, Math.round(o.h)) });
  shellView.setBounds({ x: 0, y: 0, width: W, height: H });
  radioView.setBounds(r(radio));
  if (pdaView) { pdaView.setVisible(!!pda); if (pda) pdaView.setBounds(r(pda)); }
  shellView.webContents.send("kit:layout", { W, H, unfolded, chassis, screen: scr, status, hinge, tab, pdaKey: keyName(prefs.pdaKey) });
}

// The Battle Board (called pdaView here: it sits where the Field PDA used to).
function ensurePda() {
  if (pdaView) return;
  pdaView = new WebContentsView({ webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  pdaView.setBackgroundColor("#0f0f0b");
  kit.contentView.addChildView(pdaView);
  guard(pdaView.webContents, RADIO_ORIGIN);
  pdaView.webContents.loadURL(BOARD_URL);
  pdaView.webContents.on("did-fail-load", (_e, code, _d, _u, isMain) => {
    if (isMain && code !== -3) setTimeout(() => pdaView && pdaView.webContents.loadURL(BOARD_URL), 5000);
  });
}

function setUnfolded(open) {
  open = !!open;
  if (open === unfolded) { layout(); return; }
  unfolded = open;
  prefs.unfolded = open; savePrefs();
  const b = kit.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;
  if (open) {
    ensurePda();
    const w = Math.min(Math.max(prefs.openWidth || 1560, OPEN_MIN_W), wa.width);
    let x = b.x; if (x + w > wa.x + wa.width) x = Math.max(wa.x, wa.x + wa.width - w);
    kit.setBounds({ x, y: b.y, width: w, height: b.height });
    kit.setMinimumSize(Math.min(OPEN_MIN_W, wa.width), MIN_H);
  } else {
    kit.setMinimumSize(420, MIN_H);
    kit.setBounds({ x: b.x, y: b.y, width: FOLDED_W, height: b.height });
  }
  layout();
  sendStatus();
}

function showKit({ unfold, onTop } = {}) {
  if (unfold !== undefined) setUnfolded(unfold);
  overGame = !!onTop;
  kit.setAlwaysOnTop(overGame, "screen-saver");
  if (kit.isMinimized()) kit.restore();
  kit.show();
  kit.focus();
}
function hideKit() {
  kit.hide();
  if (overGame) { kit.setAlwaysOnTop(false); overGame = false; }
}
// F9: pop the whole kit up over the game, unfolded. Again: tuck it away (the radio stays on net).
function kitKey() {
  if (!kit.isVisible() || kit.isMinimized() || !unfolded) showKit({ unfold: true, onTop: true });
  else hideKit();
}

function sendStatus() {
  if (!shellView) return;
  const o = lastOverlay || {};
  const nets = o.nets || [];
  const tx = nets.find((n) => n.you), live = nets.find((n) => n.talker);
  shellView.webContents.send("kit:status", {
    status: o.status || "Connecting",
    line: tx ? `TX · ${tx.name.toUpperCase()}` : live ? `${live.short} · ${String(live.talker).toUpperCase()}` : `${nets.length} NET${nets.length === 1 ? "" : "S"}`,
    pdaKey: keyName(prefs.pdaKey), unfolded, overlay: prefs.overlay,
  });
}

// ---------- the in-game overlay ----------
// Where it sits: a corner of the main screen, or wherever it was dragged ("custom").
// Size zooms the whole overlay; see-through fades it. Move mode makes it clickable
// so it can be dragged by its top bar, then Done puts it back to click-through.
const OV_W = 320, OV_H = 300, OV_M = 16;
function overlayBox() {
  const sc = Math.min(1.6, Math.max(0.7, +prefs.overlayScale || 1));
  const w = Math.round(OV_W * sc), h = Math.round(OV_H * sc);
  let d = screen.getPrimaryDisplay().workArea, x, y;
  const c = prefs.overlayCorner;
  if (c === "custom" && Number.isFinite(prefs.overlayX) && Number.isFinite(prefs.overlayY)) {
    d = screen.getDisplayNearestPoint({ x: prefs.overlayX + Math.round(w / 2), y: prefs.overlayY + 10 }).workArea;
    x = Math.min(Math.max(prefs.overlayX, d.x), d.x + d.width - w);
    y = Math.min(Math.max(prefs.overlayY, d.y), d.y + d.height - h);
  } else {
    x = /r$/.test(c) ? d.x + d.width - w - OV_M : d.x + OV_M;
    y = /^b/.test(c) ? d.y + d.height - h - OV_M : d.y + OV_M;
  }
  // Which way the rows grow: away from the nearest screen edges.
  const right = x + w / 2 > d.x + d.width / 2, bottom = y + h / 2 > d.y + d.height / 2;
  return { x, y, width: w, height: h, scale: sc, anchor: { h: right ? "right" : "left", v: bottom ? "bottom" : "top" } };
}
function placeOverlay() {
  if (!overlay || overlay.isDestroyed()) return;
  const b = overlayBox();
  overlay.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height });
  overlay.webContents.setZoomFactor(b.scale);
  overlay.setOpacity(Math.min(1, Math.max(0.4, +prefs.overlayOpacity || 1)));
  overlay.webContents.send("dadops:overlay-mode", { anchor: b.anchor, moving: ovMoving });
}
function setOverlayMoving(on) {
  ovMoving = !!on;
  if (!overlay || overlay.isDestroyed()) return;
  overlay.setIgnoreMouseEvents(!ovMoving);
  overlay.setFocusable(ovMoving);
  overlay.setMovable(ovMoving);
  placeOverlay();
  showOverlay();
  sendPrefs();
}
function createOverlay() {
  const d = screen.getPrimaryDisplay().workArea;
  overlay = new BrowserWindow({
    x: d.x + OV_M, y: d.y + OV_M, width: OV_W, height: OV_H,
    frame: false, transparent: true, resizable: false, movable: false, focusable: false, skipTaskbar: true,
    alwaysOnTop: true, hasShadow: false, show: false,
    webPreferences: { preload: path.join(__dirname, "overlay-preload.js"), contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  overlay.setAlwaysOnTop(true, "screen-saver");
  overlay.setIgnoreMouseEvents(true);
  overlay.setVisibleOnAllWorkspaces(true);
  overlay.loadFile(path.join(__dirname, "overlay.html"));
  overlay.webContents.on("will-navigate", (e) => e.preventDefault());
  overlay.webContents.on("did-finish-load", () => { placeOverlay(); showOverlay(); });
  // Dragged in move mode: remember exactly where.
  overlay.on("moved", () => {
    if (!ovMoving) return;
    const b = overlay.getBounds();
    prefs.overlayCorner = "custom"; prefs.overlayX = b.x; prefs.overlayY = b.y; savePrefs();
    placeOverlay(); sendPrefs();
  });
  screen.on("display-metrics-changed", placeOverlay);
}
function showOverlay() {
  if (!overlay || overlay.isDestroyed()) return;
  const want = ovMoving || (prefs.overlay && lastOverlay && lastOverlay.on);
  if (want && !overlay.isVisible()) overlay.showInactive();
  if (!want && overlay.isVisible()) overlay.hide();
  if (lastOverlay) overlay.webContents.send("dadops:overlay-state", lastOverlay);
}

const pdaKeyMatches = (ev) => { const k = prefs.pdaKey; return !!k && ((k.code && ev.code === k.code) || (k.button != null && ev.button === k.button)); };

function applyStartWithWindows() {
  try { app.setLoginItemSettings({ openAtLogin: !!prefs.startWithWindows, args: ["--hidden"] }); } catch {}
}

function buildTray() {
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.setToolTip("Dad Net");
  const offNet = () => !!(lastOverlay && lastOverlay.status === "Off net");
  const menu = () => Menu.buildFromTemplate([
    { label: "Open Dad Net", click: () => showKit({}) },
    { label: `Battle Board (${keyName(prefs.pdaKey)})`, click: () => showKit({ unfold: true }) },
    { label: offNet() ? "Get back on net" : "Go off net", click: () => netCmd(offNet() ? "on" : "off") },
    { type: "separator" },
    { label: "Show overlay in-game", type: "checkbox", checked: prefs.overlay, click: (m) => { prefs.overlay = m.checked; savePrefs(); showOverlay(); sendPrefs(); } },
    { label: ovMoving ? "Done moving the overlay" : "Move the overlay", click: () => setOverlayMoving(!ovMoving) },
    { label: "Start with Windows", type: "checkbox", checked: prefs.startWithWindows, click: (m) => { prefs.startWithWindows = m.checked; savePrefs(); applyStartWithWindows(); sendPrefs(); } },
    { type: "separator" },
    update ? { label: `Restart to update (v${update})`, click: () => installUpdate() } : { label: "Check for updates", enabled: !!checkNow, click: () => checkNow && checkNow() },
    { type: "separator" },
    { label: "Quit", click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu());
  tray.on("click", () => showKit({}));
  tray.refresh = () => tray.setContextMenu(menu());
  tray.items = () => menu().items;
  tray.labels = () => menu().items.map((i) => i.label).filter(Boolean);
}

function netCmd(c) { if (radioView) radioView.webContents.send("dadops:netcmd", c); }
function publicPrefs() {
  return { overlay: prefs.overlay, startWithWindows: prefs.startWithWindows, pdaKey: prefs.pdaKey, capturingPda, unfolded,
    overlayCorner: prefs.overlayCorner, overlayScale: prefs.overlayScale, overlayOpacity: prefs.overlayOpacity, overlayMoving: ovMoving,
    version: app.getVersion(), update, updState, canCheck: !!checkNow, hookState, hookLast };
}
function keyName(k) {
  if (!k) return "no key";
  if (k.button != null) return `Mouse ${k.button + 1}`;
  return String(k.code || "").replace(/^Key/, "").replace(/^Digit/, "");
}
function sendPrefs() {
  if (radioView) radioView.webContents.send("dadops:prefs", publicPrefs());
  if (tray && tray.refresh) tray.refresh();
  sendStatus();
}

// ---------- talk keys (and the kit key) that work in-game ----------
function startHook() {
  let hook;
  try { hook = require("uiohook-napi").uIOhook; } catch (e) { console.error("Global keys unavailable:", e.message); hookState = "failed: " + e.message; return; }
  const down = new Set();
  const deliver = (ev) => { if (radioView) radioView.webContents.send("dadops:input", ev); };
  // The kit key (F9) opens/closes the kit and is kept away from the radio's talk keys.
  let told = 0;
  const send = (ev) => {
    hookLast = Date.now();
    if (hookLast - told > 5000) { told = hookLast; sendPrefs(); } // let the page show "hearing keys"
    if (capturingPda) {
      if (ev.type !== "down") return;
      capturingPda = false;
      if (ev.code !== "Escape") { prefs.pdaKey = ev.code ? { code: ev.code } : { button: ev.button }; savePrefs(); layout(); }
      sendPrefs();
      return;
    }
    if (pdaKeyMatches(ev)) { if (ev.type === "down") kitKey(); return; }
    deliver(ev);
  };
  hook.on("keydown", (e) => { const k = keyFromHook(e.keycode); if (down.has(k)) return; down.add(k); send({ type: "down", code: k }); });
  hook.on("keyup", (e) => { const k = keyFromHook(e.keycode); down.delete(k); send({ type: "up", code: k }); });
  hook.on("mousedown", (e) => { const b = buttonFromHook(e.button); if (b == null || b === 0 || b === 2) return; send({ type: "down", button: b }); });
  hook.on("mouseup", (e) => { const b = buttonFromHook(e.button); if (b == null || b === 0 || b === 2) return; send({ type: "up", button: b }); });
  if (process.env.DADOPS_TEST === "1") { // lets the automated tests press keys and look at the kit
    global.__dadopsHook = hook;
    global.__kitState = () => ({ visible: kit.isVisible(), unfolded, onTop: kit.isAlwaysOnTop(), width: kit.getBounds().width, pda: !!pdaView });
    global.__kitShow = () => showKit({});
    global.__kitMin = () => kit.isMinimized() || process.platform === "linux"; // Xvfb has no taskbar to minimize to
    global.__ovl = () => ({ bounds: overlay.getBounds(), opacity: overlay.getOpacity(), zoom: overlay.webContents.getZoomFactor(), moving: ovMoving, visible: overlay.isVisible(), focusable: overlay.isFocusable() });
    global.__ovlDrag = (x, y) => { overlay.setPosition(x, y); overlay.emit("moved"); };
    global.__netCmd = netCmd;
    global.__trayLabels = () => tray.labels();
    global.__trayClick = (label) => { const it = tray.items().find((i) => i.label === label); if (it) it.click(it); return !!it; };
  }
  try { hook.start(); hookState = "running"; } catch (e) { console.error("Global keys failed to start:", e.message); hookState = "failed: " + e.message; }
  sendPrefs();
  app.on("will-quit", () => { try { hook.stop(); } catch {} });
}

// ---------- updates ----------
function startUpdates() {
  if (!app.isPackaged) return;
  let au;
  try { au = require("electron-updater").autoUpdater; } catch { return; }
  au.autoDownload = true;
  au.autoInstallOnAppQuit = true;
  const say = (t) => { updState = t; sendPrefs(); };
  au.on("checking-for-update", () => say("Checking for updates..."));
  au.on("update-not-available", () => say("Up to date"));
  au.on("update-available", (info) => say(`Downloading v${info.version}...`));
  au.on("download-progress", (p) => say(`Downloading update: ${Math.round(p.percent || 0)}%`));
  au.on("update-downloaded", (info) => { update = info.version; say(""); });
  au.on("error", () => say("Couldn't check for updates (will try again later)"));
  const check = () => au.checkForUpdates().catch(() => {});
  checkNow = check;
  check();
  setInterval(check, 6 * 3600e3);
}
function installUpdate() {
  try { quitting = true; require("electron-updater").autoUpdater.quitAndInstall(true, true); } catch {}
}

// ---------- messages from the radio page ----------
ipcMain.on("dadops:overlay", (e, state) => {
  if (!fromRadio(e) || !state || typeof state !== "object") return;
  const wasOff = lastOverlay && lastOverlay.status === "Off net";
  lastOverlay = state;
  showOverlay();
  sendStatus();
  if (wasOff !== (state.status === "Off net") && tray && tray.refresh) tray.refresh(); // swap the tray's Go off net / Get back on net
});
ipcMain.on("dadops:overlay-set", (e, o) => {
  if (!fromRadio(e) || !o || typeof o !== "object") return;
  if (["tl", "tr", "bl", "br"].includes(o.corner)) prefs.overlayCorner = o.corner;
  if (o.corner === "custom" && Number.isFinite(prefs.overlayX)) prefs.overlayCorner = "custom";
  if (Number.isFinite(o.scale)) prefs.overlayScale = Math.min(1.6, Math.max(0.7, o.scale));
  if (Number.isFinite(o.opacity)) prefs.overlayOpacity = Math.min(1, Math.max(0.4, o.opacity));
  savePrefs();
  if ("move" in o) setOverlayMoving(!!o.move); else { placeOverlay(); sendPrefs(); }
});
ipcMain.on("dadops:overlay-done", (e) => { if (overlay && e.sender === overlay.webContents) setOverlayMoving(false); });
ipcMain.handle("dadops:prefs:get", (e) => (fromRadio(e) ? publicPrefs() : null));
ipcMain.handle("dadops:prefs:set", (e, p) => {
  if (!fromRadio(e) || !p || typeof p !== "object") return null;
  if ("overlay" in p) prefs.overlay = !!p.overlay;
  if ("startWithWindows" in p) { prefs.startWithWindows = !!p.startWithWindows; applyStartWithWindows(); }
  savePrefs(); showOverlay(); sendPrefs();
  return publicPrefs();
});
ipcMain.on("dadops:install-update", (e) => { if (fromRadio(e) && update) installUpdate(); });
ipcMain.on("dadops:check-updates", (e) => { if (fromRadio(e) && checkNow) checkNow(); });
ipcMain.on("dadops:pda", (e, show) => { if (fromRadio(e)) setUnfolded(show === undefined ? !unfolded : !!show); });
ipcMain.on("dadops:pda-key", (e) => { if (fromRadio(e)) { capturingPda = true; sendPrefs(); } });

// ---------- messages from the chassis ----------
ipcMain.on("kit:cmd", (e, cmd) => {
  if (!fromShell(e)) return;
  if (cmd === "min") kit.minimize();
  else if (cmd === "hide") hideKit();
  else if (cmd === "fold") setUnfolded(false);
  else if (cmd === "unfold") setUnfolded(true);
});

app.on("second-instance", () => { if (kit) showKit({}); });
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
  createKit(process.argv.includes("--hidden"));
  createOverlay();
  buildTray();
  applyStartWithWindows();
  startHook();
  startUpdates();
});
