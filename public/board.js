// Dad Net - the Battle Board.
// Tonight's op, the squad board (fireteams, FTLs, who's where), your comms,
// two timers and a notepad. The radio page (radio.js) sends it what's going
// on through a BroadcastChannel; the board never connects to the net itself,
// so opening or closing it can't drop you off the radio.
"use strict";
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); return true; } catch { return false; } },
};
const RANKS = { recruit: "RCT", pvt: "PVT", pfc: "PFC", cpl: "CPL", sgt: "SGT", sfc: "SFC", "2lt": "2LT", "1lt": "1LT", cpt: "CPT", maj: "MAJ", ltc: "LTC", col: "COL" };

let S = null, heardAt = 0;
if (/[?&]kit=1/.test(location.search)) document.body.classList.add("in-kit"); // folded out beside the radio in the app
window.__board = { get state() { return S; } }; // for tests

// ---------- from the radio ----------
let chan = null;
try {
  chan = new BroadcastChannel("dad-net");
  chan.onmessage = (e) => { if (e.data && e.data.t === "state") { S = e.data.state; heardAt = Date.now(); draw(); } };
  chan.postMessage({ t: "hello" });
} catch {}
setInterval(() => {
  if (Date.now() - heardAt > 5000 && chan) chan.postMessage({ t: "hello" });
  if (S && Date.now() - heardAt > 11000) { S = null; draw(); } // the radio page was closed
}, 3000);

function draw() {
  const st = $("net-state"), ban = $("banner");
  if (!S) {
    st.textContent = "RADIO CLOSED"; st.className = "bad";
    ban.hidden = false; ban.textContent = "Open Dad Net (the radio page) to fill in the squad board and your comms. Timers and notes work anyway.";
  } else if (S.off) {
    st.textContent = "OFF NET"; st.className = "";
    ban.hidden = false; ban.textContent = "You're off net. Get back on net in the radio to see the squad board.";
  } else if (!S.signedIn) {
    st.textContent = "SIGNED OUT"; st.className = ""; ban.hidden = false; ban.textContent = "Sign in on the radio to fill the board.";
  } else {
    st.textContent = String(S.status || "").toUpperCase(); st.className = /on net/i.test(S.status) ? "on" : /reconnect/i.test(S.status) ? "bad" : "";
    ban.hidden = true;
  }
  const on = S && S.signedIn && !S.off && S.me;
  $("who").textContent = on ? `${RANKS[S.me.rank] ? RANKS[S.me.rank] + " " : ""}${S.me.callsign}${S.me.squadLeader ? " · Squad Leader tonight" : ""}${S.me.staff ? " · S3" : ""}` : S && S.callsign ? S.callsign : "Dad Net";
  op(on ? S.tonight : undefined);
  squad(on);
  comms(on);
}

// ---------- tonight's op ----------
let opInfo = null;
function op(t) {
  if (t !== undefined) opInfo = t;
  const o = opInfo;
  if (!o) {
    $("op-title").textContent = "No op on right now";
    $("op-details").textContent = "Motor Pool Monday · Cold Zone Wednesday · Hot Zone Friday · The Long Push Saturday. 8 PM ET.";
    $("op-count-lbl").textContent = "Next up"; $("op-count").textContent = "--"; $("op-start").textContent = "--";
    return;
  }
  $("op-title").textContent = o.title;
  $("op-details").textContent = o.details || "";
  const start = new Date(o.startsAt).getTime(), muster = start - 15 * 60e3, now = Date.now();
  $("op-start").textContent = new Date(start).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (now < muster) { $("op-count-lbl").textContent = "Muster in"; $("op-count").textContent = span(muster - now); }
  else if (now < start) { $("op-count-lbl").textContent = "Step off in"; $("op-count").textContent = span(start - now); }
  else { $("op-count-lbl").textContent = "Op running"; $("op-count").textContent = span(now - start); }
}
function span(ms) {
  const t = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

// ---------- squad board ----------
const netBadges = (p) => (p.nets || []).filter((n) => n !== "allcall").map((n) => {
  const net = S.nets[n] || { short: n };
  const mon = (p.monitor || []).includes(n);
  return `<span class="nb ${p.talking === n ? "live" : ""} ${mon ? "mon" : ""}" title="${esc(net.name || n)}${mon ? " (listening)" : ""}">${esc(net.short || n)}</span>`;
}).join("");
const person = (p) => `<li class="${p.talking ? "live" : ""}${p.conn === S.conn ? " me" : ""}"><span class="cs">${esc(p.callsign)}${p.conn === S.conn ? " (you)" : ""}</span>` +
  `${p.rank && RANKS[p.rank] ? `<span class="rk">${RANKS[p.rank]}</span>` : ""}<span class="grow"></span>${netBadges(p)}${p.talking ? '<span class="tx">TALKING</span>' : ""}</li>`;

function squad(on) {
  if (!on) { $("sl-line").innerHTML = "Squad Leader: <b>--</b>"; $("teams").innerHTML = ""; $("others").innerHTML = ""; return; }
  const sl = S.roster.find((p) => p.squadLeader);
  $("sl-line").innerHTML = `Squad Leader: <b>${sl ? esc(sl.callsign) : "none on Dad Net"}</b>${sl && sl.talking ? ' <span class="tx">TALKING</span>' : ""}`;
  const seats = S.seats || [];
  const inTeam = new Set();
  $("teams").innerHTML = seats.length ? seats.map((st) => {
    const ppl = S.roster.filter((p) => p.voice && p.voice.id === st.ch);
    ppl.forEach((p) => inTeam.add(p.conn));
    const h = st.holder, holderLive = h && S.roster.some((p) => p.id === h.id && p.talking === "command");
    return `<div class="team${holderLive ? " live" : ""}"><div class="thead"><span class="ttag">${esc(st.tag)}</span><span class="tname">${esc(st.name)}</span><span class="grow"></span>` +
      `<span class="tftl">FTL: ${h ? `<b>${esc(h.callsign)}</b>${h.away ? " (away)" : ""}` : '<span class="open">OPEN</span>'}</span></div>` +
      `<ul>${ppl.map(person).join("") || '<li class="muted">Nobody from Dad Net in this channel</li>'}</ul></div>`;
  }).join("") : '<p class="muted">No fireteams yet. Fireteams show up when people are in a "Fireteam" channel in Discord.</p>';
  const rest = S.roster.filter((p) => !inTeam.has(p.conn));
  const groups = new Map();
  for (const p of rest) { const k = p.voice ? p.voice.name : "Not in Discord voice"; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(p); }
  $("others").innerHTML = rest.length ? `<h3>ELSEWHERE</h3>` + [...groups].map(([k, ppl]) => `<div class="team other"><div class="thead"><span class="tname">${esc(k)}</span></div><ul>${ppl.map(person).join("")}</ul></div>`).join("") : "";
}

// ---------- comms ----------
function comms(on) {
  if (!on) { $("comms").innerHTML = '<p class="muted">Get on net to see your nets and keys.</p>'; return; }
  const me = S.roster.find((p) => p.conn === S.conn) || { nets: [], monitor: [] };
  const rows = Object.entries(S.nets).filter(([k]) => me.nets.includes(k)).map(([k, n]) => {
    const mon = (me.monitor || []).includes(k);
    const talker = S.roster.find((p) => p.talking === k);
    const count = S.roster.filter((p) => (p.nets || []).includes(k)).length;
    const mode = S.tx === k ? '<span class="tx">YOU</span>' : mon || !n.key ? '<span class="mode">LISTEN</span>' : n.key === "no key" ? '<span class="mode">NO KEY SET</span>' : `<span class="kk">${esc(n.key)}</span>`;
    return `<tr class="${talker ? "live" : ""}"><th>${esc(n.name)}</th><td>${count} on</td><td class="who">${talker ? esc(talker.callsign) : ""}</td><td class="r">${mode}</td></tr>`;
  }).join("");
  $("comms").innerHTML = rows ? `<table><tbody>${rows}</tbody></table>` : '<p class="muted">You\'re not on any nets yet.</p>';
}

// ---------- clocks and timers ----------
let sw = { run: false, from: 0, acc: 0 };
try { sw = { ...sw, ...JSON.parse(store.get("dadnet-stopwatch", "{}")) }; } catch {}
let cdEnd = +store.get("dadnet-countdown", "0") || 0, beeped = cdEnd && cdEnd < Date.now();
const swMs = () => sw.acc + (sw.run ? Date.now() - sw.from : 0);
const saveSw = () => store.set("dadnet-stopwatch", JSON.stringify(sw));
$("sw-go").onclick = () => {
  if (sw.run) { sw.acc = swMs(); sw.run = false; } else { sw.from = Date.now(); sw.run = true; }
  saveSw(); tick();
};
$("sw-reset").onclick = () => { sw = { run: false, from: 0, acc: 0 }; saveSw(); tick(); };
$("sw-mark").onclick = () => addLine(`Stopwatch ${span(swMs())}`);
document.querySelectorAll("[data-cd]").forEach((b) => (b.onclick = () => { cdEnd = Date.now() + +b.dataset.cd * 1000; beeped = false; store.set("dadnet-countdown", String(cdEnd)); tick(); }));
$("cd-stop").onclick = () => { cdEnd = 0; store.set("dadnet-countdown", "0"); $("cd-box").classList.remove("done"); tick(); };

let actx = null;
function beep() {
  try {
    actx = actx || new AudioContext();
    actx.resume();
    [0, 0.25, 0.5].forEach((d) => {
      const o = actx.createOscillator(), g = actx.createGain(), t = actx.currentTime + d;
      o.type = "square"; o.frequency.value = 1200;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.08, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
      o.connect(g).connect(actx.destination); o.start(t); o.stop(t + 0.2);
    });
  } catch {}
}
function tick() {
  const now = Date.now();
  $("clock-et").textContent = new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
  $("sw").textContent = span(swMs());
  $("sw-go").textContent = sw.run ? "Stop" : sw.acc ? "Resume" : "Start";
  const left = cdEnd ? cdEnd - now : 0;
  $("cd").textContent = cdEnd ? (left > 0 ? span(left + 999) : "TIME") : "0:00";
  $("cd-box").classList.toggle("done", !!cdEnd && left <= 0);
  if (cdEnd && left <= 0 && !beeped) { beeped = true; beep(); }
  op();
}
setInterval(tick, 250);

// ---------- notepad ----------
const notes = $("notes");
notes.value = store.get("dadnet-notes", "");
let saveT = 0;
function saveNotes() {
  clearTimeout(saveT);
  saveT = setTimeout(() => { $("notes-saved").textContent = store.set("dadnet-notes", notes.value) ? "SAVED" : "NOT SAVED"; }, 300);
}
notes.addEventListener("input", () => { $("notes-saved").textContent = ""; saveNotes(); });
window.addEventListener("storage", (e) => { if (e.key === "dadnet-notes" && document.activeElement !== notes) notes.value = e.newValue || ""; });
const stamp = () => new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
function addLine(text) {
  const v = notes.value;
  notes.value = v + (v && !v.endsWith("\n") ? "\n" : "") + `[${stamp()}] ${text}`;
  saveNotes();
}
$("n-stamp").onclick = () => {
  const at = notes.selectionStart ?? notes.value.length, ins = `[${stamp()}] `;
  notes.value = notes.value.slice(0, at) + ins + notes.value.slice(notes.selectionEnd ?? at);
  notes.focus(); notes.selectionStart = notes.selectionEnd = at + ins.length; saveNotes();
};
$("n-copy").onclick = async () => {
  try { await navigator.clipboard.writeText(notes.value); $("n-copy").textContent = "Copied"; }
  catch { notes.select(); document.execCommand("copy"); $("n-copy").textContent = "Copied"; }
  setTimeout(() => ($("n-copy").textContent = "Copy"), 1500);
};
// Clear asks twice, without a pop-up.
$("n-clear").onclick = () => {
  const b = $("n-clear");
  if (b.dataset.sure) { notes.value = ""; saveNotes(); delete b.dataset.sure; b.textContent = "Clear"; return; }
  b.dataset.sure = "1"; b.textContent = "Sure? Click again";
  setTimeout(() => { delete b.dataset.sure; b.textContent = "Clear"; }, 3000);
};

draw();
tick();
