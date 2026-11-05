// Draws the in-game overlay from what the radio page sends.
//   state = { on, status, nets: [{ short, name, talker, you, alert }] }
"use strict";
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const BARS = '<span class="bars" aria-hidden="true"><i></i><i></i><i></i><i></i></span>';

function draw(s) {
  const wrap = document.getElementById("wrap");
  if (!s || !s.on) { wrap.innerHTML = ""; return; }
  const head = '<div class="head"><img src="build/icon.png" alt=""><span>DAD OPS RADIO</span></div>';
  if (s.status && s.status !== "On net") {
    wrap.innerHTML = head + `<div class="row down"><span class="tag">RADIO</span><span>${esc(s.status)}...</span></div>`;
    return;
  }
  const nets = s.nets || [];
  const busy = nets.filter((n) => n.talker || n.you);
  if (!busy.length) {
    wrap.innerHTML = `<div class="row"><img src="build/icon.png" alt="" style="width:16px;height:16px"><span class="tag" style="border:0;padding:0">${esc(nets.map((n) => n.short).join(" · ") || "RADIO")}</span><span class="quiet">on net</span></div>`;
    return;
  }
  wrap.innerHTML = head + busy.map((n) => n.you
    ? `<div class="row tx ${n.alert ? "alert" : ""}"><span class="tag">${esc(n.short)}</span><span class="who">TX · ${esc(n.name.toUpperCase())}</span></div>`
    : `<div class="row live ${n.alert ? "alert" : ""}"><span class="tag">${esc(n.short)}</span>${BARS}<span class="who">${esc(n.talker)}</span></div>`).join("");
}

window.overlayBridge.onState(draw);
