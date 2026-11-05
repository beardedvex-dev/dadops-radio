// Draws the field kit's chassis around the radio and the Field PDA.
// main.js decides where everything goes and sends the boxes here.
"use strict";
const $ = (id) => document.getElementById(id);
const put = (el, b) => { if (!b) { el.hidden = true; return; } el.hidden = false; Object.assign(el.style, { left: b.x + "px", top: b.y + "px", width: b.w + "px", height: b.h + "px" }); };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
let st = { status: "Connecting", line: "", pdaKey: "F9", unfolded: false };

function layout(l) {
  const c = l.chassis;
  put($("chassis"), c);
  put($("rim"), { x: c.x + 10, y: c.y + 10, w: c.w - 20, h: c.h - 20 });
  const s = 22;
  Object.assign($("s1").style, { left: c.x + s + "px", top: c.y + s + "px" });
  Object.assign($("s2").style, { left: c.x + c.w - s - 14 + "px", top: c.y + s + "px" });
  Object.assign($("s3").style, { left: c.x + s + "px", top: c.y + c.h - s - 14 + "px" });
  Object.assign($("s4").style, { left: c.x + c.w - s - 14 + "px", top: c.y + c.h - s - 14 + "px" });
  Object.assign($("engrave").style, { left: c.x + 48 + "px", top: c.y + 13 + "px" });
  Object.assign($("winbtns").style, { left: c.x + c.w - 48 - 66 + "px", top: c.y + 7 + "px" });
  put($("screen"), l.screen);
  // Drag strips on the rim only: between the chassis edge and the screen.
  const sc = l.screen;
  put($("dragT"), { x: c.x, y: c.y, w: c.w, h: sc.y - c.y });
  put($("dragB"), { x: c.x, y: sc.y + sc.h, w: c.w, h: c.y + c.h - (sc.y + sc.h) });
  put($("dragL"), { x: c.x, y: sc.y, w: sc.x - c.x, h: sc.h });
  put($("dragR"), { x: sc.x + sc.w, y: sc.y, w: c.x + c.w - (sc.x + sc.w), h: sc.h });
  put($("status"), l.status);
  put($("hinge"), l.hinge);
  put($("unfold"), l.tab);
  st.unfolded = l.unfolded; st.pdaKey = l.pdaKey || st.pdaKey;
  status();
}

function status(s) {
  if (s) st = { ...st, ...s };
  const on = /on net/i.test(st.status);
  const parts = [
    `<span class="${on ? "on" : /reconnect|lost/i.test(st.status) ? "bad" : ""}">RADIO ${esc(String(st.status).toUpperCase())}</span>`,
    `<span>${esc(st.line || "")}</span>`,
    `<span>${esc(String(st.pdaKey).toUpperCase())} ${st.unfolded ? "SHOW / HIDE" : "FIELD PDA"}</span>`,
  ].filter((p) => !/<span><\/span>/.test(p));
  $("status").innerHTML = parts.join("<span>·</span>");
}

window.kitBridge.onLayout(layout);
window.kitBridge.onStatus(status);
$("min").onclick = () => window.kitBridge.cmd("min");
$("hide").onclick = () => window.kitBridge.cmd("hide");
$("fold").onclick = () => window.kitBridge.cmd("fold");
$("unfold").onclick = () => window.kitBridge.cmd("unfold");
