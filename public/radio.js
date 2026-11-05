// DAD Ops Radio - browser test page.
// Signs in with the dadops.gg Discord login, connects to the net control
// (/api/net) and the Cloudflare voice relay, and plays each net in the
// ear and at the volume you pick.
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";

const $ = (id) => document.getElementById(id);
const VIEWS = ["v-signin", "v-ready", "v-net", "v-denied"];
const show = (v) => VIEWS.forEach((id) => ($(id).hidden = id !== v));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// ---------- settings kept in this browser ----------
const DEFAULTS = {
  command: { key: { code: "KeyB" }, pan: -1, vol: 70 },
  air: { key: { code: "KeyN" }, pan: 1, vol: 60 },
  allcall: { key: { code: "KeyM" }, pan: 0, vol: 85 },
};
let settings = structuredClone(DEFAULTS);
try { const s = JSON.parse(localStorage.getItem("dadops-radio") || "null"); if (s) for (const k of Object.keys(DEFAULTS)) settings[k] = { ...DEFAULTS[k], ...(s[k] || {}) }; } catch {}
const save = () => { try { localStorage.setItem("dadops-radio", JSON.stringify(settings)); } catch {} };
const keyLabel = (k) => {
  if (!k) return "None";
  if (k.button != null) return `MOUSE ${k.button + 1}`;
  const c = k.code || "";
  if (c.startsWith("Key")) return c.slice(3);
  if (c.startsWith("Digit")) return c.slice(5);
  return c.replace(/^Numpad/, "NUM ").replace(/(Left|Right)$/, " $1").toUpperCase();
};

// ---------- state ----------
const R = {
  cfg: null, sb: null, token: null,
  ws: null, me: null, can: null, conn: null, nets: {}, roster: [], waiting: new Map(), seq: 0,
  ctx: null, pc: null, mic: null, micTrack: null, chain: Promise.resolve(),
  pipes: new Map(), // conn -> { gain, pan, el, analyser }
  midToConn: new Map(), pulled: new Set(),
  tx: null, capture: null, cards: {}, retry: 0, stopping: false,
};
window.__radio = R; // handy when testing from the browser console

// ---------- sign in ----------
async function boot() {
  R.cfg = await fetch("/api/config").then((r) => r.json());
  R.sb = createClient(R.cfg.supabaseUrl, R.cfg.supabaseKey, { auth: { persistSession: true, detectSessionInUrl: true, flowType: "pkce" } });
  const { data } = await R.sb.auth.getSession();
  R.sb.auth.onAuthStateChange((_e, session) => { if (session) R.token = session.access_token; });
  if (!data.session) return show("v-signin");
  R.token = data.session.access_token;
  $("signout").hidden = false;
  show("v-ready");
}
$("signin").onclick = () => R.sb.auth.signInWithOAuth({ provider: "discord", options: { redirectTo: location.origin + "/" } });
$("signout").onclick = async () => { R.stopping = true; teardown(); await R.sb.auth.signOut(); location.reload(); };
$("goonnet").onclick = () => connect().catch((e) => { $("ready-err").textContent = e.message || String(e); });

// ---------- net control (WebSocket) ----------
function ask(msg) {
  const id = ++R.seq;
  return new Promise((ok, fail) => {
    R.waiting.set(id, { ok, fail });
    R.ws.send(JSON.stringify({ ...msg, id }));
    setTimeout(() => { if (R.waiting.delete(id)) fail(new Error("The net didn't answer in time.")); }, 15000);
  });
}
const tell = (msg) => { try { R.ws && R.ws.readyState === 1 && R.ws.send(JSON.stringify(msg)); } catch {} };

async function connect() {
  $("goonnet").disabled = true;
  $("ready-err").textContent = "";
  if (!R.ctx) R.ctx = new AudioContext();
  await R.ctx.resume();
  const { data } = await R.sb.auth.getSession();
  if (!data.session) return show("v-signin");
  R.token = data.session.access_token;

  R.ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/net`);
  R.ws.onmessage = (e) => onMessage(JSON.parse(e.data));
  R.ws.onclose = onClosed;
  await new Promise((ok, fail) => { R.ws.onopen = ok; R.ws.onerror = () => fail(new Error("Couldn't reach the radio. Try again.")); });
  const w = await ask({ t: "hello", token: R.token });
  if (w.t === "denied") { $("denied-why").textContent = w.reason; R.stopping = true; return show("v-denied"); }
  if (w.t !== "welcome") throw new Error(w.reason || "Couldn't get on net.");
  R.me = w.me; R.can = w.can; R.conn = w.conn; R.nets = w.nets; R.roster = w.roster; R.retry = 0;
  buildNets();
  show("v-net");
  setStatus("Connecting voice", "");
  await startVoice();
  setStatus("On net", "on");
  render();
  $("goonnet").disabled = false;
}

function onMessage(m) {
  if (m.re && R.waiting.has(m.re)) { const w = R.waiting.get(m.re); R.waiting.delete(m.re); return w.ok(m); }
  if (m.t === "roster") { R.roster = m.members; render(); pullAll(); }
  else if (m.t === "talking") {
    const p = R.roster.find((x) => x.conn === m.conn);
    if (p) p.talking = m.net;
    if (m.net && m.conn !== R.conn && myNets().includes(m.net)) chirp(m.net === "allcall" ? 880 : 1320);
    render();
  }
}

function onClosed() {
  for (const w of R.waiting.values()) w.fail(new Error("Lost the net."));
  R.waiting.clear();
  if (R.stopping) return;
  teardown();
  setStatus("Reconnecting", "bad");
  const wait = Math.min(15000, 2000 * 2 ** R.retry++);
  setTimeout(() => connect().catch(() => onClosed()), wait);
}

function teardown() {
  stopTalk(true);
  try { R.ws && R.ws.close(); } catch {}
  R.ws = null;
  try { R.pc && R.pc.close(); } catch {}
  R.pc = null;
  for (const p of R.pipes.values()) { try { p.el.srcObject = null; p.src.disconnect(); } catch {} }
  R.pipes.clear(); R.midToConn.clear(); R.pulled.clear();
  if (R.mic) R.mic.getTracks().forEach((t) => t.stop());
  R.mic = null; R.micTrack = null;
}

// ---------- voice (Cloudflare Realtime) ----------
// Every change to the connection runs one at a time.
const serial = (fn) => (R.chain = R.chain.then(fn, fn));

async function startVoice() {
  R.pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }], bundlePolicy: "max-bundle" });
  R.pc.ontrack = (e) => {
    const conn = R.midToConn.get(e.transceiver.mid);
    if (conn) addPipe(conn, e.track);
  };
  const s = await ask({ t: "session" });
  if (s.t !== "session") throw new Error(s.reason || "No voice session.");

  if (R.can.talk.length) {
    R.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      .catch(() => { throw new Error("The radio needs your microphone. Allow it in the address bar and try again."); });
    R.micTrack = R.mic.getAudioTracks()[0];
    R.micTrack.enabled = false;
    meter(R.mic);
    await serial(async () => {
      const tx = R.pc.addTransceiver(R.micTrack, { direction: "sendonly" });
      await R.pc.setLocalDescription(await R.pc.createOffer());
      const r = await ask({ t: "publish", sdp: R.pc.localDescription.sdp, mid: tx.mid });
      if (r.t !== "published") throw new Error(r.reason || "Couldn't connect your mic.");
      await R.pc.setRemoteDescription({ type: "answer", sdp: r.sdp });
    });
  } else {
    meter(null);
  }
  pullAll();
}

function pullAll() {
  if (!R.pc) return;
  for (const p of R.roster) {
    if (p.conn === R.conn || !p.published || R.pulled.has(p.conn)) continue;
    R.pulled.add(p.conn);
    serial(async () => {
      if (!R.pc) return;
      const r = await ask({ t: "pull", conn: p.conn });
      if (r.gone || !r.mid) { R.pulled.delete(p.conn); return; }
      R.midToConn.set(r.mid, p.conn);
      if (r.sdp) {
        await R.pc.setRemoteDescription({ type: "offer", sdp: r.sdp });
        await R.pc.setLocalDescription(await R.pc.createAnswer());
        if (r.renegotiate) await ask({ t: "renegotiate", sdp: R.pc.localDescription.sdp });
      }
      const t = R.pc.getTransceivers().find((x) => x.mid === r.mid);
      if (t && t.receiver.track && !R.pipes.has(p.conn)) addPipe(p.conn, t.receiver.track);
    }).catch(() => R.pulled.delete(p.conn));
  }
}

function addPipe(conn, track) {
  if (R.pipes.has(conn)) return;
  const stream = new MediaStream([track]);
  // Chrome only lets a call's audio into the mixer if an <audio> is also playing it.
  const el = new Audio(); el.muted = true; el.srcObject = stream; el.play().catch(() => {});
  const src = R.ctx.createMediaStreamSource(stream);
  const gain = R.ctx.createGain(); gain.gain.value = 0;
  const pan = R.ctx.createStereoPanner();
  const analyser = R.ctx.createAnalyser(); analyser.fftSize = 256;
  src.connect(gain).connect(pan).connect(R.ctx.destination);
  gain.connect(analyser);
  R.pipes.set(conn, { el, src, gain, pan, analyser });
  mix();
}

// Who you hear: only people talking on a net you're on, in that net's ear and volume.
function mix() {
  const mine = myNets();
  for (const [conn, p] of R.pipes) {
    const who = R.roster.find((x) => x.conn === conn);
    const net = who && who.talking;
    const on = net && mine.includes(net);
    const t = R.ctx.currentTime;
    p.gain.gain.setTargetAtTime(on ? settings[net].vol / 100 : 0, t, 0.015);
    if (on) p.pan.pan.setTargetAtTime(settings[net].pan, t, 0.01);
  }
}

function myNets() { const me = R.roster.find((x) => x.conn === R.conn); return me ? me.nets : []; }

// ---------- talking ----------
function startTalk(net) {
  if (R.tx || !R.micTrack || !R.can.talk.includes(net) || !myNets().includes(net)) return;
  R.tx = net;
  R.micTrack.enabled = true;
  tell({ t: "talk", net });
  chirp(net === "allcall" ? 990 : 1500, 0.05);
  render();
}
function stopTalk(now) {
  if (!R.tx) return;
  const net = R.tx;
  R.tx = null;
  const done = () => { if (!R.tx && R.micTrack) R.micTrack.enabled = false; tell({ t: "talk", net: null }); };
  now ? done() : setTimeout(done, 150); // a short tail so the last word isn't cut off
  chirp(net === "allcall" ? 660 : 1000, 0.05);
  render();
}

function matches(k, e) { return k && ((k.code && e.code === k.code) || (k.button != null && e.button === k.button)); }
function netForInput(e) { return Object.keys(settings).find((n) => matches(settings[n].key, e)); }
const typing = () => /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) && document.activeElement.type !== "range";

window.addEventListener("keydown", (e) => {
  if (R.capture) { e.preventDefault(); if (e.code !== "Escape") setKey(R.capture, { code: e.code }); else endCapture(); return; }
  if (e.repeat || typing()) return;
  const n = netForInput(e);
  if (n && R.can && R.can.talk.includes(n)) { e.preventDefault(); startTalk(n); }
});
window.addEventListener("keyup", (e) => { const n = netForInput(e); if (n && R.tx === n) stopTalk(); });
window.addEventListener("mousedown", (e) => {
  if (R.capture && e.button > 0) { e.preventDefault(); return setKey(R.capture, { button: e.button }); }
  if (e.button === 0) return;
  const n = netForInput(e);
  if (n && R.can && R.can.talk.includes(n)) { e.preventDefault(); startTalk(n); }
});
window.addEventListener("mouseup", (e) => { if (e.button === 3 || e.button === 4) e.preventDefault(); const n = netForInput(e); if (n && R.tx === n) stopTalk(); });
window.addEventListener("contextmenu", (e) => { if (R.capture) e.preventDefault(); });
window.addEventListener("blur", () => stopTalk());

function setKey(net, key) {
  for (const n of Object.keys(settings)) if (n !== net && JSON.stringify(settings[n].key) === JSON.stringify(key)) settings[n].key = null;
  settings[net].key = key; save(); endCapture();
}
function endCapture() { R.capture = null; render(); }

// ---------- sounds ----------
function chirp(freq, len = 0.07) {
  if (!R.ctx) return;
  const o = R.ctx.createOscillator(), g = R.ctx.createGain(), t = R.ctx.currentTime;
  o.type = "square"; o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.06, t + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, t + len);
  o.connect(g).connect(R.ctx.destination); o.start(t); o.stop(t + len + 0.02);
}

function meter(stream) {
  const box = $("meter");
  box.innerHTML = "<span></span>".repeat(8);
  if (!stream) { $("foot-text").textContent = "Listen only"; return; }
  const a = R.ctx.createAnalyser(); a.fftSize = 512;
  R.ctx.createMediaStreamSource(stream).connect(a);
  const buf = new Float32Array(a.fftSize), bars = [...box.children];
  const tick = () => {
    if (R.mic !== stream) return;
    a.getFloatTimeDomainData(buf);
    let peak = 0; for (const v of buf) peak = Math.max(peak, Math.abs(v));
    const lit = R.tx ? Math.min(8, Math.round(peak * 24)) : 0;
    bars.forEach((b, i) => b.classList.toggle("on", i < lit));
    requestAnimationFrame(tick);
  };
  tick();
}

// ---------- screen ----------
function setStatus(text, cls) { $("status-text").textContent = text; $("status").className = "pill " + (cls || ""); }

function buildNets() {
  const box = $("nets");
  box.innerHTML = "";
  R.cards = {};
  for (const [key, net] of Object.entries(R.nets)) {
    if (!R.can.listen.includes(key) && key !== "command" && key !== "air") continue;
    const el = document.createElement("div");
    el.className = `net ${key}`;
    el.innerHTML = `
      <div class="net-top">
        <span class="net-name">${esc(net.name.toUpperCase())}</span>
        ${net.joinable ? "" : '<span class="tag">ALWAYS ON</span>'}
        <span class="count" data-r="count"></span>
        <span class="grow"></span>
        <span data-r="keybox"></span>
      </div>
      <p class="desc" data-r="desc"></p>
      <div class="speaking" data-r="speaking" hidden></div>
      <div class="people" data-r="people"></div>
      <div class="controls" data-r="controls">
        <div class="seg" role="group" aria-label="${esc(net.name)} ear">
          <button data-pan="-1">Left</button><button data-pan="0">Both</button><button data-pan="1">Right</button>
        </div>
        <label class="vol">Vol <input type="range" min="0" max="100" aria-label="${esc(net.name)} volume" data-r="vol"></label>
        ${net.joinable ? '<button class="ghost small" data-r="leave">Leave</button>' : ""}
      </div>
      <button class="ptt" data-r="ptt" hidden></button>
      <button class="join" data-r="join" hidden>Join net</button>`;
    const q = (r) => el.querySelector(`[data-r="${r}"]`);
    el.querySelectorAll("[data-pan]").forEach((b) => (b.onclick = () => { settings[key].pan = +b.dataset.pan; save(); render(); mix(); }));
    q("vol").value = settings[key].vol;
    q("vol").oninput = (e) => { settings[key].vol = +e.target.value; save(); mix(); };
    // Use our own nets from the answer straight away, so a talk key works the moment you join.
    const setMine = (r) => { const me = R.roster.find((x) => x.conn === R.conn); if (me && r.nets) { me.nets = r.nets; render(); } };
    if (q("leave")) q("leave").onclick = () => { if (R.tx === key) stopTalk(true); ask({ t: "leave", net: key }).then(setMine).catch(() => {}); };
    q("join").onclick = () => ask({ t: "join", net: key }).then((r) => { if (r.t === "error") alertIn(el, r.reason); else setMine(r); }).catch(() => {});
    const ptt = q("ptt");
    ptt.onpointerdown = (e) => { e.preventDefault(); ptt.setPointerCapture(e.pointerId); startTalk(key); };
    ptt.onpointerup = ptt.onpointercancel = () => { if (R.tx === key) stopTalk(); };
    ptt.onkeydown = (e) => { if ((e.key === " " || e.key === "Enter") && !e.repeat) { e.preventDefault(); startTalk(key); } };
    ptt.onkeyup = (e) => { if (e.key === " " || e.key === "Enter") stopTalk(); };
    box.appendChild(el);
    R.cards[key] = { el, q };
  }
}

function alertIn(el, text) { const d = el.querySelector('[data-r="desc"]'); d.textContent = text; }

function render() {
  if (!R.me) return;
  const me = R.me;
  $("tonight").textContent = me.tonight ? me.tonight.title : "No op on right now";
  const role = [me.level === "private" ? "Private +" : "Recruit", me.staff ? "S3" : null, me.squadLeader ? "Squad Leader tonight" : null].filter(Boolean).join(" · ");
  $("whoami").textContent = `Signed in as ${me.callsign} (${role})`;
  const mine = myNets();

  for (const [key, { el, q }] of Object.entries(R.cards)) {
    const net = R.nets[key];
    const joined = mine.includes(key);
    const canListen = R.can.listen.includes(key), canTalk = R.can.talk.includes(key);
    const on = R.roster.filter((p) => p.nets.includes(key));
    const talker = on.find((p) => p.talking === key);
    el.classList.toggle("joined", joined);
    el.classList.toggle("live", !!talker && joined);

    q("count").textContent = `${on.length} on net`;
    const keybox = q("keybox");
    if (canTalk && joined) {
      const waiting = R.capture === key;
      keybox.innerHTML = `<button class="key ${waiting ? "wait" : ""}" title="Change this net's talk key">${waiting ? "PRESS A KEY" : esc(keyLabel(settings[key].key))}</button>`;
      keybox.firstChild.onclick = (e) => { e.stopPropagation(); R.capture = R.capture === key ? null : key; render(); };
    } else keybox.innerHTML = canListen && !canTalk && joined ? '<span class="count">Listen only</span>' : "";

    const desc = q("desc");
    if (!canListen) desc.textContent = `${net.name} opens at Private.`;
    else if (!joined) desc.textContent = key === "air" ? "Pilots and recon who split off from the fireteams." : "Fireteam leads talking to each other.";
    else if (key === "allcall") desc.textContent = canTalk ? "You can talk to everyone on the radio. Use it sparingly." : "Tonight's Squad Leader and S3 can talk to everyone. Plays a chirp first.";
    else desc.textContent = "";

    const sp = q("speaking");
    if (talker && joined) {
      sp.hidden = false;
      sp.innerHTML = talker.conn === R.conn ? `<b>You</b> are talking` : `<b>${esc(talker.callsign)}</b> is talking`;
    } else sp.hidden = true;

    q("people").innerHTML = joined ? on.map((p) => `<span class="chip ${p.talking === key ? "on" : ""}">${esc(p.callsign)}${p.conn === R.conn ? " (you)" : ""}</span>`).join("") : "";
    q("controls").hidden = !joined;
    el.querySelectorAll("[data-pan]").forEach((b) => b.setAttribute("aria-pressed", String(+b.dataset.pan === settings[key].pan)));
    q("join").hidden = joined || !canListen || !net.joinable;
    const ptt = q("ptt");
    ptt.hidden = !(joined && canTalk);
    ptt.classList.toggle("tx", R.tx === key);
    ptt.textContent = R.tx === key ? `Talking on ${net.name}` : `Hold to talk on ${net.name}  ·  ${keyLabel(settings[key].key)}`;
  }

  const foot = document.querySelector(".foot");
  foot.classList.toggle("tx", !!R.tx);
  const first = R.can.talk.find((n) => mine.includes(n));
  $("foot-text").textContent = !R.micTrack ? "Listen only" : R.tx ? `Talking on ${R.nets[R.tx].name}` :
    first ? `Hold ${keyLabel(settings[first].key)} to talk on ${R.nets[first].name}` : "Join a net to talk";
  mix();
}

boot().catch((e) => { show("v-ready"); $("ready-err").textContent = "Couldn't load the radio: " + (e.message || e); });
