// Dad Net - the radio page (the browser version, and the radio inside the desktop app).
// Signs in with the dadops.gg Discord login, connects to the net control
// (/api/net) and the Cloudflare voice relay, and plays each net in the
// ear and at the volume you pick. It also feeds the Battle Board (board.html).
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";

const $ = (id) => document.getElementById(id);
const VIEWS = ["v-signin", "v-ready", "v-net", "v-denied", "v-off", "v-nets"];
const show = (v) => VIEWS.forEach((id) => ($(id).hidden = id !== v));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// ---------- settings kept in this browser ----------
const DEFAULTS = {
  command: { key: { code: "KeyB" }, pan: -1, vol: 70 },
  recon: { key: { code: "KeyH" }, pan: 1, vol: 60 },
  air: { key: { code: "KeyN" }, pan: 1, vol: 60 },
  logi: { key: { code: "KeyJ" }, pan: 1, vol: 60 },
  allcall: { key: { code: "KeyM" }, pan: 0, vol: 85 },
  // The direct line: one key to talk to the person you picked (or reply), one to step through people.
  direct: { key: { code: "KeyK" }, pan: 0, vol: 85 },
  cycle: { key: { code: "KeyL" } },
};
const FALLBACK = { key: null, pan: 1, vol: 60 }; // for a net added later
// In the desktop app, keys work everywhere (even while typing), so start on mouse buttons
// nobody types with: Mouse 5 = Command, Mouse 4 = All-call. The other nets start unset.
if (window.dadopsDesktop) {
  DEFAULTS.command.key = { button: 4 }; DEFAULTS.allcall.key = { button: 3 };
  DEFAULTS.recon.key = null; DEFAULTS.air.key = null; DEFAULTS.logi.key = null;
  DEFAULTS.direct.key = null; DEFAULTS.cycle.key = null;
}
let settings = structuredClone(DEFAULTS);
try { const s = JSON.parse(localStorage.getItem("dadops-radio") || "null"); if (s) for (const k of Object.keys(s)) settings[k] = { ...(DEFAULTS[k] || FALLBACK), ...(s[k] || {}) }; } catch {}
// One key per net: if two nets ended up with the same key, the later one loses it.
{ const seen = new Set(); for (const k of Object.keys(settings)) { const id = JSON.stringify(settings[k].key); if (settings[k].key && seen.has(id)) settings[k].key = null; seen.add(id); } }
// A net added on the Nets screen starts in the ear it was set up with.
const S = (net) => (settings[net] ||= { ...FALLBACK, pan: R.nets && R.nets[net] && [-1, 0, 1].includes(R.nets[net].ear) ? R.nets[net].ear : FALLBACK.pan });
const save = () => { try { localStorage.setItem("dadops-radio", JSON.stringify(settings)); } catch {} };
const keyLabel = (k) => {
  if (!k) return "None";
  if (k.button != null) return `MOUSE ${k.button + 1}`;
  const c = k.code || "";
  if (c.startsWith("Key")) return c.slice(3);
  if (c.startsWith("Digit")) return c.slice(5);
  return c.replace(/^Numpad/, "NUM ").replace(/(Left|Right)$/, " $1").toUpperCase();
};

// dadops.gg rank codes -> names (same ladder as the website)
const RANKS = { recruit: "Recruit", pvt: "Private", pfc: "Private First Class", cpl: "Corporal", sgt: "Sergeant",
  sfc: "Sergeant First Class", "2lt": "Second Lieutenant", "1lt": "First Lieutenant", cpt: "Captain", maj: "Major",
  ltc: "Lieutenant Colonel", col: "Colonel" };

// ---------- state ----------
const R = {
  cfg: null, sb: null, token: null,
  ws: null, me: null, can: null, conn: null, nets: {}, roster: [], waiting: new Map(), seq: 0,
  ctx: null, pc: null, mic: null, micTrack: null, chain: Promise.resolve(),
  pipes: new Map(), // conn -> { gain, pan, el, analyser }
  midToConn: new Map(), pulled: new Set(),
  tx: null, capture: null, cards: {}, retry: 0, stopping: false, seats: [], off: false,
  directPick: null, lastCaller: null, incoming: new Map(), // the direct line
};
window.__radio = R; // handy when testing from the browser console
// Set when this page is running inside the Dad Net desktop app.
const DESK = window.dadopsDesktop || null;

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
  if (DESK) { desktopSetup(); connect().catch((e) => { $("ready-err").textContent = e.message || String(e); $("goonnet").disabled = false; }); }
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
  if (w.t === "denied") {
    if (R.ws) R.ws.onclose = null; // the switchboard hangs up now: don't treat that as a lost net
    // An old or ended sign-in (signing out on dadops.gg ends this one too):
    // try a fresh one quietly, else sign in again right here, not in a browser.
    if (w.signIn || /sign in again/i.test(w.reason || "")) {
      if (!R.refreshed) {
        R.refreshed = true;
        const r = await R.sb.auth.refreshSession().catch(() => null);
        if (r && r.data && r.data.session) { R.token = r.data.session.access_token; return connect(); }
      }
      R.refreshed = false; R.stopping = true;
      await R.sb.auth.signOut({ scope: "local" }).catch(() => {});
      $("signout").hidden = true;
      $("signin-why").textContent = "Your sign-in ran out (signing out on dadops.gg signs you out here too). Sign in with Discord again.";
      $("signin-why").hidden = false;
      $("goonnet").disabled = false;
      return show("v-signin");
    }
    $("denied-why").textContent = w.reason; R.stopping = true; return show("v-denied");
  }
  R.refreshed = false;
  if (w.t !== "welcome") throw new Error(w.reason || "Couldn't get on net.");
  R.me = w.me; R.can = w.can; R.conn = w.conn; R.nets = w.nets; R.roster = w.roster; R.seats = w.seats || [];
  buildNets();
  show("v-net");
  setStatus("Connecting voice", "");
  await startVoice();
  setStatus("On net", "on");
  R.retry = 0; // only once voice works, so a broken connection backs off instead of retrying every 2 seconds
  render();
  $("goonnet").disabled = false;
}

function onMessage(m) {
  if (m.re && R.waiting.has(m.re)) { const w = R.waiting.get(m.re); R.waiting.delete(m.re); return w.ok(m); }
  if (m.t === "error" && !m.re) { R.lastTalkErr = m.reason; showLastKey(); if (R.tx) { R.tx = null; if (R.micTrack) R.micTrack.enabled = false; render(); } flash(m.reason); return; }
  if (m.t === "roster") { R.roster = m.members; if (m.seats) R.seats = m.seats; render(); pullAll(); }
  else if (m.t === "nets") { // the Nets screen changed something
    R.nets = m.nets; R.can = m.can;
    const me = myEntry();
    if (me && m.mine) { me.nets = m.mine.nets; me.monitor = m.mine.monitor; }
    if (R.tx && R.tx !== "direct" && !canTalkHere(R.tx)) stopTalk(true);
    buildNets(); render(); netsScreen();
  }
  else if (m.t === "direct") { // someone's talking to you on the direct line (or stopped)
    if (m.on) { R.incoming.set(m.from, m.callsign); R.lastCaller = m.from; chirp(1750, 0.06); }
    else R.incoming.delete(m.from);
    render();
  }
  else if (m.t === "mine") { // the switchboard moved us (an FTL seat taken or lost)
    const me = myEntry();
    if (me) { me.nets = m.nets || []; me.monitor = m.monitor || []; }
    if (R.tx && !canTalkHere(R.tx)) stopTalk(true);
    render();
  }
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
  if (R.rawMic) R.rawMic.getTracks().forEach((t) => t.stop());
  try { R.micSrc && R.micSrc.disconnect(); R.micGain && R.micGain.disconnect(); } catch {}
  R.mic = null; R.micTrack = null; R.rawMic = null; R.micSrc = null; R.micGain = null; R.checkDest = null;
}

// ---------- the microphone: picker, boost and radio check ----------
// Mic -> boost -> what goes out on the radio (switched off except while you talk)
//              -> a private copy, only for the radio check recording
let micPrefs = { deviceId: "", boost: 100 };
try { micPrefs = { ...micPrefs, ...JSON.parse(localStorage.getItem("dadops-radio-mic") || "{}") }; } catch {}
const saveMic = () => { try { localStorage.setItem("dadops-radio-mic", JSON.stringify(micPrefs)); } catch {} };
const MIC_OPTS = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

async function getRawMic(deviceId) {
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { ...MIC_OPTS, deviceId: { exact: deviceId } } : MIC_OPTS });
  } catch (e) {
    if (!deviceId) throw e;
    micPrefs.deviceId = ""; saveMic(); // that mic is gone: fall back to the default one
    return navigator.mediaDevices.getUserMedia({ audio: MIC_OPTS });
  }
}
async function openMic() {
  R.rawMic = await getRawMic(micPrefs.deviceId);
  R.micSrc = R.ctx.createMediaStreamSource(R.rawMic);
  R.micGain = R.ctx.createGain(); R.micGain.gain.value = micPrefs.boost / 100;
  const out = R.ctx.createMediaStreamDestination();
  R.checkDest = R.ctx.createMediaStreamDestination();
  R.micSrc.connect(R.micGain); R.micGain.connect(out); R.micGain.connect(R.checkDest);
  R.mic = out.stream; R.micTrack = out.stream.getAudioTracks()[0]; R.micTrack.enabled = false;
}
async function switchMic(deviceId) {
  const raw = await getRawMic(deviceId);
  try { R.micSrc.disconnect(); } catch {}
  if (R.rawMic) R.rawMic.getTracks().forEach((t) => t.stop());
  R.rawMic = raw;
  R.micSrc = R.ctx.createMediaStreamSource(raw); R.micSrc.connect(R.micGain);
  micPrefs.deviceId = deviceId; saveMic();
  micList();
}
async function micList() {
  const pick = $("mic-pick"); if (!pick) return;
  let devs = [];
  try { devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput" && d.deviceId !== "default" && d.deviceId !== "communications"); } catch {}
  const current = (R.rawMic && R.rawMic.getAudioTracks()[0] && R.rawMic.getAudioTracks()[0].getSettings().deviceId) || micPrefs.deviceId;
  pick.innerHTML = `<option value="">Windows default (usually the same as Discord)</option>` +
    devs.map((d, i) => `<option value="${esc(d.deviceId)}">${esc(d.label || "Microphone " + (i + 1))}</option>`).join("");
  pick.value = micPrefs.deviceId && devs.some((d) => d.deviceId === micPrefs.deviceId) ? micPrefs.deviceId : "";
  pick.dataset.current = current || "";
}
function micSetup() {
  if (!R.micTrack) { $("micbox").hidden = true; return; }
  $("micbox").hidden = false;
  micList();
  const b = $("mic-boost");
  b.value = micPrefs.boost; $("mic-boost-val").textContent = `${micPrefs.boost}%`;
  b.oninput = () => { micPrefs.boost = +b.value; $("mic-boost-val").textContent = `${b.value}%`; if (R.micGain) R.micGain.gain.setTargetAtTime(micPrefs.boost / 100, R.ctx.currentTime, 0.02); saveMic(); };
  $("mic-pick").onchange = (e) => switchMic(e.target.value).catch(() => { $("mic-state").textContent = "Couldn't open that microphone."; });
  $("mic-check").onclick = radioCheck;
  if (!micSetup.watching) { micSetup.watching = true; try { navigator.mediaDevices.addEventListener("devicechange", micList); } catch {} }
}
async function radioCheck() {
  if (R.checking || !R.checkDest) return;
  const state = $("mic-state"), btn = $("mic-check");
  R.checking = true; btn.disabled = true;
  try {
    const rec = new MediaRecorder(R.checkDest.stream);
    const chunks = [];
    rec.ondataavailable = (e) => e.data && e.data.size && chunks.push(e.data);
    const stopped = new Promise((ok) => (rec.onstop = ok));
    rec.start();
    for (let i = 3; i > 0; i--) { state.textContent = `Recording... say "radio check, one two" (${i})`; await new Promise((r) => setTimeout(r, 1000)); }
    rec.stop(); await stopped;
    const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
    R.lastCheckSize = blob.size;
    state.textContent = "Playing back: this is how you sound on the radio...";
    const url = URL.createObjectURL(blob), au = new Audio(url);
    await au.play().catch(() => {});
    await new Promise((ok) => { au.onended = ok; au.onerror = ok; setTimeout(ok, 6000); });
    URL.revokeObjectURL(url);
    state.textContent = "Too quiet? Turn up Boost. Too loud or crackly? Turn it down.";
  } catch {
    state.textContent = "The radio check didn't work on this device.";
  }
  R.checking = false; btn.disabled = false;
}

// ---------- voice (Cloudflare Realtime) ----------
// Every change to the connection runs one at a time.
const serial = (fn) => (R.chain = R.chain.then(fn, fn));

// The backup route: Cloudflare's TURN relay carries the voice for anyone whose
// network blocks the normal way (some work, hotel and phone networks).
// ?relay=1 forces it, to test that it works.
const RELAY_ONLY = /[?&]relay=1\b/.test(location.search);
async function iceServers() {
  const stun = [{ urls: "stun:stun.cloudflare.com:3478" }];
  try {
    const r = await Promise.race([ask({ t: "ice" }), new Promise((ok) => setTimeout(() => ok(null), 5000))]);
    return r && r.t === "ice" && Array.isArray(r.iceServers) && r.iceServers.length ? r.iceServers : stun;
  } catch { return stun; }
}
// Which way the voice is going: straight to Cloudflare, or through the relay.
async function showRoute() {
  const el = $("route"); if (!el || !R.pc) return;
  try {
    const stats = await R.pc.getStats();
    let pair = null;
    stats.forEach((s) => { if (s.type === "transport" && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId); });
    if (!pair) stats.forEach((s) => { if (!pair && s.type === "candidate-pair" && s.nominated && s.state === "succeeded") pair = s; });
    const local = pair && stats.get(pair.localCandidateId);
    if (!local) return;
    R.route = local.candidateType === "relay" ? "relay" : "direct";
    el.textContent = R.route === "relay" ? "Voice: backup route (relay)" : "Voice: direct";
    el.title = R.route === "relay" ? "Your network blocks the normal way, so your voice goes through Cloudflare's relay. Works the same." : "Your voice goes straight to Cloudflare.";
  } catch {}
}

async function startVoice() {
  const ice = await iceServers();
  R.pc = new RTCPeerConnection({ iceServers: ice, bundlePolicy: "max-bundle", iceTransportPolicy: RELAY_ONLY ? "relay" : "all" });
  R.pc.onconnectionstatechange = () => {
    const st = R.pc && R.pc.connectionState;
    if (st === "connected") setTimeout(showRoute, 300);
    // Voice gave out (network changed, Wi-Fi dropped): start over, the same as a lost net.
    if (st === "failed" && !R.stopping && R.ws) { flash("Lost the voice connection. Getting back on net..."); try { R.ws.close(); } catch {} }
  };
  R.pc.ontrack = (e) => {
    const conn = R.midToConn.get(e.transceiver.mid);
    if (conn) addPipe(conn, e.track);
  };
  const s = await ask({ t: "session" });
  if (s.t !== "session") throw new Error(s.reason || "No voice session.");

  if (R.can.talk.length) {
    await openMic().catch(() => { throw new Error("The radio needs your microphone. Allow it in the address bar and try again."); });
    meter(R.micGain);
    micSetup();
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
    const t = R.ctx.currentTime;
    if (R.incoming.has(conn)) { // talking to you on the direct line
      p.gain.gain.setTargetAtTime(S("direct").vol / 100, t, 0.015);
      p.pan.pan.setTargetAtTime(S("direct").pan || 0, t, 0.01);
      continue;
    }
    const net = who && who.talking;
    const on = net && mine.includes(net);
    p.gain.gain.setTargetAtTime(on ? S(net).vol / 100 : 0, t, 0.015);
    if (on) p.pan.pan.setTargetAtTime(S(net).pan, t, 0.01);
  }
  duckDiscord();
}
// Turn Discord down (desktop app v0.6+): while someone's talking to you, or while anyone is (you too).
let ducked = false;
function duckDiscord() {
  if (!DESK || !DESK.duck) return;
  const mode = deskPrefs.duckMode || "others";
  const mine = myNets();
  const others = R.incoming.size > 0 || R.roster.some((p) => p.conn !== R.conn && p.talking && mine.includes(p.talking));
  const want = mode !== "off" && (others || (mode === "anyone" && !!R.tx));
  if (want !== ducked) { ducked = want; DESK.duck(want); }
}

function myNets() { const me = R.roster.find((x) => x.conn === R.conn); return me ? me.nets : []; }
function myMonitor() { const me = R.roster.find((x) => x.conn === R.conn); return (me && me.monitor) || []; }
function myEntry() { return R.roster.find((x) => x.conn === R.conn); }
// Can I talk on this net at all? Command also opens to whoever holds a fireteam's FTL seat.
function canTalkNet(n) {
  if (!R.can) return false;
  if (n === "direct" || n === "cycle") return !!(R.me && R.me.level === "private"); // the direct line opens at Private
  if (R.can.talk.includes(n)) return true;
  const me = myEntry();
  return !!(R.nets[n] && R.nets[n].talk === "lead" && me && me.ftl); // an FTL seat opens the leads' nets
}
const canTalkHere = (n) => canTalkNet(n) && myNets().includes(n) && !myMonitor().includes(n);

// A short "who is this" label: "FT2 FTL", "SL", or their Discord channel tag.
function roleTag(p) { return p.ftl ? `${p.ftl} FTL` : p.squadLeader ? "SL" : p.voice ? p.voice.tag : ""; }
const withTag = (p) => p.callsign + (roleTag(p) ? ` · ${roleTag(p)}` : "");

// ---------- the direct line ----------
const onNet = (c) => !!c && c !== R.conn && R.roster.some((p) => p.conn === c);
// Who the direct key calls: the one you picked, or else whoever called you last.
function directTarget() { return onNet(R.directPick) ? R.directPick : onNet(R.lastCaller) ? R.lastCaller : null; }
const nameOf = (c) => (R.roster.find((p) => p.conn === c) || {}).callsign || "";
function startDirect() {
  if (R.tx || !R.micTrack || !canTalkNet("direct")) return;
  const to = directTarget();
  if (!to) { flash("Pick someone to call first: click their name, or press your cycle key."); return; }
  R.tx = "direct"; R.txTo = to;
  R.micTrack.enabled = true;
  tell({ t: "talk", direct: to });
  chirp(1800, 0.05);
  render();
}
// The cycle key: the next person, people on your nets first.
function cycleDirect() {
  const mine = myNets();
  const list = R.roster.filter((p) => p.conn !== R.conn)
    .sort((a, b) => Number(!a.nets.some((n) => mine.includes(n))) - Number(!b.nets.some((n) => mine.includes(n))) || a.callsign.localeCompare(b.callsign));
  if (!list.length) { flash("Nobody else is on Dad Net."); return; }
  const i = list.findIndex((p) => p.conn === R.directPick);
  pickDirect(list[(i + 1) % list.length].conn, true);
}
function pickDirect(conn, quiet) {
  R.directPick = onNet(conn) ? conn : null;
  if (R.directPick && !quiet) flash(`Direct line: ${nameOf(conn)}. Hold ${keyLabel(S("direct").key)} to talk to just them.`);
  chirp(1200, 0.03);
  render();
}

// ---------- talking ----------
function startTalk(net) {
  if (net === "cycle") return cycleDirect();
  if (net === "direct") return startDirect();
  if (R.tx || !R.micTrack || !canTalkNet(net) || !myNets().includes(net) || myMonitor().includes(net)) return;
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
  chirp(net === "allcall" ? 660 : net === "direct" ? 1300 : 1000, 0.05);
  render();
}

function matches(k, e) { return k && ((k.code && e.code === k.code) || (k.button != null && e.button === k.button)); }
function netForInput(e) { return Object.keys(settings).find((n) => matches(settings[n].key, e)); }
const typing = () => /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) && document.activeElement.type !== "range";

window.addEventListener("keydown", (e) => {
  if (DESK) { // the app's key listener handles talk keys; this window's own keys count too (whichever comes first)
    if (R.capture) { e.preventDefault(); if (e.code === "Escape") endCapture(); else setKey(R.capture, { code: e.code }); return; }
    if (e.repeat || typing()) return;
    const n = netForInput(e);
    if (n && canTalkNet(n) && Date.now() - (R.capturedAt || 0) > 500) { e.preventDefault(); startTalk(n); }
    return;
  }
  if (R.capture) { e.preventDefault(); if (e.code !== "Escape") setKey(R.capture, { code: e.code }); else endCapture(); return; }
  if (e.repeat || typing()) return;
  const n = netForInput(e);
  if (n && canTalkNet(n)) { e.preventDefault(); startTalk(n); }
});
window.addEventListener("keyup", (e) => { const n = netForInput(e); if (n && R.tx === n) stopTalk(); });
window.addEventListener("mousedown", (e) => {
  if (DESK) {
    if (e.button === 3 || e.button === 4) e.preventDefault();
    if (R.capture && e.button !== 0 && e.button !== 2) { e.preventDefault(); setKey(R.capture, { button: e.button }); return; }
    if (e.button === 0 || e.button === 2) return;
    const n = netForInput(e);
    if (n && canTalkNet(n) && Date.now() - (R.capturedAt || 0) > 500) startTalk(n);
    return;
  }
  if (R.capture && e.button > 0) { e.preventDefault(); return setKey(R.capture, { button: e.button }); }
  if (e.button === 0) return;
  const n = netForInput(e);
  if (n && canTalkNet(n)) { e.preventDefault(); startTalk(n); }
});
window.addEventListener("mouseup", (e) => { if (e.button === 3 || e.button === 4) e.preventDefault(); const n = netForInput(e); if (n && R.tx === n) stopTalk(); });
window.addEventListener("contextmenu", (e) => { if (R.capture) e.preventDefault(); });
window.addEventListener("blur", () => { if (!DESK) stopTalk(); });
// In the app, if a key's release only came through this window and focus moved to the game,
// the app's key listener still sends the release, so nothing gets stuck. // in the app the game has focus while you talk

// ---------- desktop app ----------
// Keys and mouse buttons from anywhere in Windows, game included.
function onDesktopInput(ev) {
  if (!ev || (ev.type !== "down" && ev.type !== "up")) return;
  R.lastIn = { ev, at: Date.now() }; showLastKey();
  if (R.capture) {
    if (ev.type !== "down") return;
    if (ev.code === "Escape") return endCapture();
    if (ev.code) return setKey(R.capture, { code: ev.code });
    if (ev.button != null && ev.button !== 0 && ev.button !== 2) return setKey(R.capture, { button: ev.button });
    return;
  }
  const n = netForInput(ev);
  if (!n || !R.can) return;
  // The same press that just set a key also arrives here a moment later: don't talk on it.
  if (ev.type === "down" && Date.now() - (R.capturedAt || 0) < 500) return;
  if (ev.type === "down") { if (canTalkNet(n)) startTalk(n); }
  else if (R.tx === n) stopTalk();
}
let deskPrefs = {};
function desktopSetup() {
  document.body.classList.add("desktop");
  if (DESK.kit) { document.body.classList.add("kit"); document.documentElement.classList.add("kit"); } // v0.4+ app: the field kit look
  if (DESK.kit && !DESK.overlayCmd) $("board-open").hidden = true; // older apps: use the fold-out tab
  $("notice-text").innerHTML = "<b>Desktop app.</b> Your talk keys work while the game is in front. Click a key box on a net to change it (Mouse 4/5 work too).";
  DESK.onInput(onDesktopInput);
  const apply = (p) => {
    if (!p) return;
    deskPrefs = p;
    $("opt-overlay").checked = !!p.overlay;
    $("opt-startup").checked = !!p.startWithWindows;
    $("app-version").textContent = p.version ? `v${p.version}` : "";
    if (p.hookState !== undefined) {
      const heard = p.hookLast && Date.now() - p.hookLast < 10 * 60e3;
      $("hook-state").hidden = false;
      $("hook-state").textContent = /^failed/.test(p.hookState) ? `In-game keys: NOT WORKING (${p.hookState.replace(/^failed:\s*/, "")})`
        : heard ? "In-game keys: working" : p.hookState === "running" ? "In-game keys: listening (press any key to check)" : "In-game keys: starting...";
      $("hook-state").className = "muted " + (/^failed/.test(p.hookState) ? "bad" : heard ? "good" : "");
    }
    $("kit-ver").textContent = p.version ? `· v${p.version}` : "";
    $("update").hidden = !p.update;
    if (DESK.checkUpdates && p.canCheck !== undefined) {
      $("upd-line").hidden = !!p.update;
      $("upd-state").textContent = p.updState || "";
      $("upd-check").hidden = !p.canCheck;
    }
    if (DESK.pda && p.pdaKey !== undefined) {
      $("pda-row").hidden = false;
      $("pda-key").textContent = p.capturingPda ? "PRESS A KEY" : keyLabel(p.pdaKey);
      $("pda-key").classList.toggle("wait", !!p.capturingPda);
      // The PDA key can't also be a talk key: the app keeps it for the PDA.
      let cleared = false;
      for (const n of Object.keys(settings)) if (p.pdaKey && JSON.stringify(settings[n].key) === JSON.stringify(p.pdaKey)) { settings[n].key = null; cleared = true; }
      if (cleared) { save(); render(); }
    }
    if (p.update) $("update-text").textContent = `Update ready (v${p.update}).`;
    if (DESK.duck && p.duckMode !== undefined) { // v0.6+: turn Discord down
      $("duck-row").hidden = false;
      $("duck-mode").value = p.duckMode;
      if (document.activeElement !== $("duck-level")) $("duck-level").value = p.duckLevel;
      $("duck-level-val").textContent = +$("duck-level").value === 0 ? "muted" : `${$("duck-level").value}%`;
      $("duck-level").disabled = $("duck-test").disabled = p.duckMode === "off" || !p.duckAvailable;
      $("duck-state").textContent = !p.duckAvailable ? "Only in the Windows app." : p.duckStatus || "";
      $("duck-state").className = "muted " + (/^Not working/.test(p.duckStatus || "") ? "bad" : /^Working/.test(p.duckStatus || "") ? "good" : "");
      if (p.duckMode === "off" && ducked) ducked = false;
    }
    if (DESK.overlayCmd && p.overlayCorner !== undefined) {
      $("ovl-row").hidden = false;
      $("ovl-corner").value = p.overlayCorner;
      $("ovl-custom").hidden = p.overlayCorner !== "custom";
      $("ovl-move").textContent = p.overlayMoving ? "Done moving" : "Move it";
      $("ovl-move").classList.toggle("wait", !!p.overlayMoving);
      $("ovl-move-help").hidden = !p.overlayMoving;
      if (document.activeElement !== $("ovl-size")) $("ovl-size").value = Math.round(p.overlayScale * 100);
      if (document.activeElement !== $("ovl-see")) $("ovl-see").value = Math.round((1 - p.overlayOpacity) * 100);
      $("ovl-size-val").textContent = `${$("ovl-size").value}%`;
      $("ovl-see-val").textContent = `${$("ovl-see").value}%`;
    }
  };
  DESK.getPrefs().then(apply).catch(() => {});
  DESK.onPrefs(apply);
  $("opt-overlay").onchange = (e) => DESK.setPrefs({ overlay: e.target.checked }).then(apply);
  $("opt-startup").onchange = (e) => DESK.setPrefs({ startWithWindows: e.target.checked }).then(apply);
  $("update-now").onclick = () => DESK.installUpdate();
  if (DESK.checkUpdates) $("upd-check").onclick = () => DESK.checkUpdates();
  if (DESK.pda) {
    $("pda-open").onclick = () => DESK.pda(true);
    $("pda-key").onclick = () => DESK.setPdaKey();
  }
  if (DESK.duck) {
    $("duck-mode").onchange = (e) => { DESK.setPrefs({ duckMode: e.target.value }).then(apply); ducked = false; duckDiscord(); };
    $("duck-level").oninput = (e) => { $("duck-level-val").textContent = +e.target.value === 0 ? "muted" : `${e.target.value}%`; };
    $("duck-level").onchange = (e) => DESK.setPrefs({ duckLevel: +e.target.value }).then(apply);
    $("duck-test").onclick = async () => { $("duck-test").disabled = true; $("duck-state").textContent = "Turning Discord down for 2 seconds..."; await DESK.duckTest().catch(() => {}); $("duck-test").disabled = false; };
  }
  if (DESK.overlayCmd) { // v0.5+: put the overlay where you want it
    $("ovl-corner").onchange = (e) => DESK.overlayCmd({ corner: e.target.value });
    $("ovl-move").onclick = () => DESK.overlayCmd({ move: !deskPrefs.overlayMoving });
    $("ovl-size").oninput = (e) => { $("ovl-size-val").textContent = `${e.target.value}%`; DESK.overlayCmd({ scale: e.target.value / 100 }); };
    $("ovl-see").oninput = (e) => { $("ovl-see-val").textContent = `${e.target.value}%`; DESK.overlayCmd({ opacity: 1 - e.target.value / 100 }); };
  }
  // Older apps fold out the dadops.gg PDA; v0.5+ folds out the Battle Board.
  if (DESK.overlayCmd) { $("pda-open").textContent = "Open Battle Board"; $("pda-key").title = "Change the Battle Board key"; }
  $("desk").hidden = false;
  $("last-key").hidden = false; showLastKey();
  $("desk").open = !DESK.kit;
}
function showLastKey() {
  const el = $("last-key"); if (!el) return;
  if (!R.lastIn) { el.textContent = "Last key from the in-game listener: none yet"; return; }
  const { ev } = R.lastIn, n = netForInput(ev);
  el.textContent = `Last key from the in-game listener: ${keyLabel(ev.code ? { code: ev.code } : { button: ev.button })} (${ev.type})` +
    (n ? ` → ${R.nets[n] ? R.nets[n].name : n}` : " → not a talk key") + (R.lastTalkErr ? ` · ${R.lastTalkErr}` : "");
}
function pushOverlay() {
  if (!DESK || !R.me) return;
  const mine = myNets();
  const status = $("status-text").textContent;
  DESK.overlay({
    on: true, status,
    nets: Object.keys(R.nets).filter((n) => mine.includes(n)).map((n) => {
      const t = R.roster.find((p) => p.talking === n && p.conn !== R.conn);
      return { key: n, short: R.nets[n].short, name: R.nets[n].name, talker: t ? withTag(t) : null, you: R.tx === n, alert: !R.nets[n].joinable };
    }).concat(
      // The direct line: you talking to someone, and anyone talking to you.
      R.tx === "direct" ? [{ key: "direct", short: "DM", name: `Direct · ${nameOf(R.txTo)}`, talker: null, you: true, alert: false }] : [],
      [...R.incoming.values()].map((c) => ({ key: "direct", short: "DM", name: "Direct", talker: `${c} (direct)`, you: false, alert: false }))),
    pick: canTalkNet("direct") && directTarget() ? nameOf(directTarget()) : null,
  });
}

function setKey(net, key) {
  if (!R.capture || R.capture !== net) return; // already set by the other path
  for (const n of Object.keys(settings)) if (n !== net && JSON.stringify(settings[n].key) === JSON.stringify(key)) settings[n].key = null;
  S(net).key = key; save(); endCapture();
}
function endCapture() { R.capture = null; R.capturedAt = Date.now(); render(); }

// A short message under the header (talk refused, etc.).
function flash(text) {
  let f = $("flash");
  if (!f) { f = document.createElement("div"); f.id = "flash"; f.setAttribute("role", "alert"); $("nets").before(f); }
  f.textContent = text; f.hidden = false;
  clearTimeout(flash.t); flash.t = setTimeout(() => (f.hidden = true), 6000);
}

// ---------- sounds ----------
function chirp(freq, len = 0.07) {
  if (!R.ctx) return;
  const o = R.ctx.createOscillator(), g = R.ctx.createGain(), t = R.ctx.currentTime;
  o.type = "square"; o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.06, t + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, t + len);
  o.connect(g).connect(R.ctx.destination); o.start(t); o.stop(t + len + 0.02);
}

// Mic level: the footer lights while you talk; the Mic check box shows it live.
function meter(node) {
  const box = $("meter"), box2 = $("mic-meter");
  box.innerHTML = "<span></span>".repeat(8);
  if (box2) box2.innerHTML = "<span></span>".repeat(16);
  if (!node) { $("foot-text").textContent = "Listen only"; return; }
  const a = R.ctx.createAnalyser(); a.fftSize = 512;
  node.connect(a);
  const buf = new Float32Array(a.fftSize), bars = [...box.children], bars2 = box2 ? [...box2.children] : [];
  const tick = () => {
    if (R.micGain !== node) return;
    a.getFloatTimeDomainData(buf);
    let peak = 0; for (const v of buf) peak = Math.max(peak, Math.abs(v));
    R.micPeak = peak;
    const lit = R.tx ? Math.min(8, Math.round(peak * 24)) : 0;
    bars.forEach((b, i) => b.classList.toggle("on", i < lit));
    const lit2 = Math.min(16, Math.round(peak * 40));
    bars2.forEach((b, i) => { b.classList.toggle("on", i < lit2); b.classList.toggle("hot", i >= 13 && i < lit2); });
    setTimeout(() => requestAnimationFrame(tick), 30);
  };
  tick();
}

// ---------- screen ----------
function setStatus(text, cls) {
  $("status-text").textContent = text; $("status").className = "pill " + (cls || "");
  $("kit-status").textContent = text.toUpperCase(); $("kit-status").className = cls || "";
  pushOverlay();
}

function buildNets() {
  const box = $("nets");
  box.innerHTML = "";
  R.cards = {};
  for (const [key, net] of Object.entries(R.nets)) {
    if (!R.can.listen.includes(key) && !net.joinable) continue;
    const el = document.createElement("div");
    el.className = `net ${key}`;
    el.innerHTML = `
      <div class="net-top">
        <span class="net-name">${esc(net.name.toUpperCase())}</span>
        ${net.joinable ? "" : '<span class="tag">ALWAYS ON</span>'}
        <span class="count" data-r="count"></span>
        <span class="grow"></span>
        <span data-r="keybox"></span>
        <button class="more" data-r="more" aria-expanded="false" aria-label="${esc(net.name)}: show who's on and the ear/volume controls">▾</button>
      </div>
      <p class="desc" data-r="desc"></p>
      <div class="speaking" data-r="speaking" hidden></div>
      <div class="people" data-r="people"></div>
      <div class="controls" data-r="controls">
        ${net.joinable ? `<div class="seg" role="group" aria-label="${esc(net.name)} talk or monitor" data-r="mode">
          <button data-mode="talk">Talk</button><button data-mode="monitor">Monitor</button>
        </div>` : ""}
        <div class="seg" role="group" aria-label="${esc(net.name)} ear">
          <button data-pan="-1">Left</button><button data-pan="0">Both</button><button data-pan="1">Right</button>
        </div>
        <label class="vol">Vol <input type="range" min="0" max="100" aria-label="${esc(net.name)} volume" data-r="vol"></label>
        ${net.joinable ? '<button class="ghost small" data-r="leave">Leave</button>' : ""}
      </div>
      <button class="ptt" data-r="ptt" hidden></button>
      <div class="joinrow" data-r="joinrow" hidden>
        <button class="join" data-r="join">Join net</button>
        <button class="ghost small" data-r="monitor" title="Listen to this net without talking on it">Monitor only</button>
      </div>`;
    const q = (r) => el.querySelector(`[data-r="${r}"]`);
    el.querySelectorAll("[data-pan]").forEach((b) => (b.onclick = () => { S(key).pan = +b.dataset.pan; save(); render(); mix(); }));
    q("vol").value = S(key).vol;
    q("vol").oninput = (e) => { S(key).vol = +e.target.value; save(); mix(); };
    // Use our own nets from the answer straight away, so a talk key works the moment you join.
    const setMine = (r) => { const me = R.roster.find((x) => x.conn === R.conn); if (me && r.nets) { me.nets = r.nets; me.monitor = r.monitor || []; render(); } };
    const joinAs = (mode) => { if (mode === "monitor" && R.tx === key) stopTalk(true); return ask({ t: "join", net: key, mode }).then((r) => { if (r.t === "error") alertIn(el, r.reason); else setMine(r); }).catch(() => {}); };
    if (q("leave")) q("leave").onclick = () => { if (R.tx === key) stopTalk(true); ask({ t: "leave", net: key }).then(setMine).catch(() => {}); };
    q("join").onclick = () => joinAs("talk");
    q("monitor").onclick = () => joinAs("monitor");
    el.querySelectorAll("[data-mode]").forEach((b) => (b.onclick = () => joinAs(b.dataset.mode)));
    q("more").onclick = () => { const open = !el.classList.contains("open"); el.classList.toggle("open", open); q("more").setAttribute("aria-expanded", String(open)); };
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

const LEAD_ONLY = "Listen only. Take your fireteam's FTL seat to talk here. Sergeants and up can talk without one.";

function render() {
  if (!R.me || R.off) return;
  const me = R.me;
  $("tonight").textContent = me.tonight ? me.tonight.title : "No op on right now";
  const rank = RANKS[me.rank] || (me.level === "private" ? "Private +" : "Recruit");
  const role = [rank, me.staff ? "S3" : null, me.squadLeader ? "Squad Leader tonight" : null].filter(Boolean).join(" · ");
  const mine0 = R.roster.find((x) => x.conn === R.conn);
  const myVoice = mine0 && mine0.voice;
  $("whoami").textContent = `Signed in as ${me.callsign} (${role})` + (myVoice ? ` · Discord: ${myVoice.name}` : "");
  $("nets-open").hidden = !me.netsBoss;
  $("kit-discord").textContent = myVoice ? `Discord: ${myVoice.name}` : "";
  const mine = myNets();

  for (const [key, { el, q }] of Object.entries(R.cards)) {
    const net = R.nets[key];
    const joined = mine.includes(key);
    const canListen = R.can.listen.includes(key), canTalk = canTalkNet(key);
    const monitoring = joined && myMonitor().includes(key), talkHere = canTalk && joined && !monitoring;
    const on = R.roster.filter((p) => p.nets.includes(key));
    const talker = on.find((p) => p.talking === key);
    el.classList.toggle("joined", joined);
    el.classList.toggle("locked", !canListen);
    el.classList.toggle("live", !!talker && joined);

    q("count").textContent = `${on.length} on net`;
    const keybox = q("keybox");
    if (talkHere) {
      const waiting = R.capture === key;
      keybox.innerHTML = `<button class="key ${waiting ? "wait" : ""}" title="Change this net's talk key">${waiting ? "PRESS A KEY" : esc(keyLabel(S(key).key))}</button>`;
      keybox.firstChild.onclick = (e) => { e.stopPropagation(); R.capture = R.capture === key ? null : key; render(); };
    } else keybox.innerHTML = monitoring ? '<span class="tag">MONITORING</span>' : canListen && !canTalk && joined ? '<span class="count">Listen only</span>' : "";

    const desc = q("desc");
    if (!canListen) desc.textContent = `${net.name} opens at Private.`;
    else if (!joined) desc.textContent = net.desc || "";
    else if (monitoring && !canTalk) desc.textContent = key === "command" ? LEAD_ONLY : "Listen only on this net.";
    else if (monitoring) desc.textContent = "Monitoring: you hear this net but can't talk on it. Switch to Talk to speak up.";
    else if (!canTalk && key === "command") desc.textContent = LEAD_ONLY;
    else if (!net.joinable) desc.textContent = canTalk ? "You can talk to everyone on the radio. Use it sparingly." : (net.desc || "");
    else desc.textContent = "";

    const sp = q("speaking");
    if (talker && joined) {
      sp.hidden = false;
      sp.innerHTML = talker.conn === R.conn ? `<b>You</b> are talking` : `<b>${esc(withTag(talker))}</b> is talking`;
    } else sp.hidden = true;

    q("people").innerHTML = joined ? on.map((p) => { const mon = (p.monitor || []).includes(key);
      const me = p.conn === R.conn, pick = !me && canTalkNet("direct");
      return `<span class="chip ${p.talking === key ? "on" : ""} ${mon ? "mon" : ""} ${R.directPick === p.conn ? "picked" : ""}" ${pick ? `data-pick="${esc(p.conn)}" role="button" tabindex="0" title="${mon ? "Monitoring (listen only). " : ""}Click to pick ${esc(p.callsign)} for your direct line"` : mon ? 'title="Monitoring (listen only)"' : ""}>${R.directPick === p.conn ? "📞 " : ""}${esc(withTag(p))}${me ? " (you)" : ""}${mon ? " · listening" : ""}</span>`; }).join("") : "";
    const mode = q("mode");
    if (mode) { mode.hidden = !(joined && canTalk); mode.querySelectorAll("[data-mode]").forEach((b) => b.setAttribute("aria-pressed", String((b.dataset.mode === "monitor") === monitoring))); }
    q("controls").hidden = !joined;
    el.querySelectorAll("[data-pan]").forEach((b) => b.setAttribute("aria-pressed", String(+b.dataset.pan === S(key).pan)));
    q("joinrow").hidden = joined || !canListen || !net.joinable;
    q("monitor").hidden = !canTalk;
    q("join").textContent = canTalk ? "Join net" : "Listen in";
    if (monitoring && !canTalk) keybox.innerHTML = '<span class="count">Listen only</span>';
    const ptt = q("ptt");
    ptt.hidden = !talkHere;
    ptt.classList.toggle("tx", R.tx === key);
    ptt.textContent = R.tx === key ? `Talking on ${net.name}` : `Hold to talk on ${net.name}  ·  ${keyLabel(S(key).key)}`;
  }

  const foot = document.querySelector(".foot");
  foot.classList.toggle("tx", !!R.tx);
  const first = Object.keys(R.nets).find((n) => canTalkHere(n));
  $("foot-text").textContent = !R.micTrack ? "Listen only" : R.tx === "direct" ? `Talking to ${nameOf(R.txTo)} (direct)` : R.tx ? `Talking on ${(R.nets[R.tx] || { name: R.tx }).name}` :
    first ? `Hold ${keyLabel(S(first).key)} to talk on ${R.nets[first].name}` : "Join a net to talk";
  renderSeats();
  renderDirect();
  mix();
  pushOverlay();
  feedBoard();
}

// ---------- the direct line card ----------
function renderDirect() {
  const box = $("direct"); if (!box) return;
  box.hidden = false;
  const can = canTalkNet("direct");
  const incoming = [...R.incoming.values()];
  const others = R.roster.filter((p) => p.conn !== R.conn).sort((a, b) => a.callsign.localeCompare(b.callsign));
  const to = directTarget();
  const keyBtn = (k, title) => { const waiting = R.capture === k; return `<button class="key ${waiting ? "wait" : ""}" data-dkey="${k}" title="${title}">${waiting ? "PRESS A KEY" : esc(keyLabel(S(k).key))}</button>`; };
  // Don't rebuild under an open dropdown.
  if (box.contains(document.activeElement) && document.activeElement.tagName === "SELECT") return;
  box.classList.toggle("live", incoming.length > 0 || R.tx === "direct");
  box.innerHTML = `<div class="net-top"><span class="net-name">DIRECT LINE</span><span class="count">${others.length} on Dad Net</span><span class="grow"></span>
      ${can ? `<span class="klbl dk">Talk</span>${keyBtn("direct", "Your direct line talk key")}<span class="klbl dk">Next</span>${keyBtn("cycle", "Step to the next person")}` : ""}</div>
    ${incoming.length ? `<div class="speaking">📞 <b>${esc(incoming.join(", "))}</b> ${incoming.length === 1 ? "is" : "are"} talking to you</div>` : ""}
    ${R.tx === "direct" ? `<div class="speaking you">📞 You're talking to <b>${esc(nameOf(R.txTo))}</b> only</div>` : ""}
    ${can ? `<label class="dl-pick"><span class="muted">Calling</span>
      <select id="dl-pick" aria-label="Who your direct line calls">
        <option value="">${onNet(R.lastCaller) ? `Whoever called last (${esc(nameOf(R.lastCaller))})` : "Nobody picked: replies to whoever calls you"}</option>
        ${others.map((p) => `<option value="${esc(p.conn)}"${R.directPick === p.conn ? " selected" : ""}>${esc(withTag(p))}</option>`).join("")}
      </select></label>
      <p class="desc">Talk to one person, wherever they are on Dad Net. Pick them here, click their name on a net, or press your Next key to step through people. Others can't hear it on their radio.</p>
      <button class="ptt" id="dl-ptt" ${to ? "" : "disabled"}>${R.tx === "direct" ? `Talking to ${esc(nameOf(R.txTo))}` : to ? `Hold to talk to ${esc(nameOf(to))}  ·  ${esc(keyLabel(S("direct").key))}` : "Pick someone to call"}</button>`
      : `<p class="desc">The direct line opens at Private. You'll still hear anyone who calls you.</p>`}
    <div class="controls dl-controls"><label class="vol">Vol <input type="range" min="0" max="100" value="${S("direct").vol}" id="dl-vol" aria-label="Direct line volume"></label></div>`;
}
$("direct").addEventListener("click", (e) => {
  const k = e.target.closest("[data-dkey]");
  if (k) { e.stopPropagation(); R.capture = R.capture === k.dataset.dkey ? null : k.dataset.dkey; render(); }
});
$("direct").addEventListener("change", (e) => { if (e.target.id === "dl-pick") { pickDirect(e.target.value || null, true); e.target.blur(); } });
$("direct").addEventListener("input", (e) => { if (e.target.id === "dl-vol") { S("direct").vol = +e.target.value; save(); mix(); } });
$("direct").addEventListener("pointerdown", (e) => { const b = e.target.closest("#dl-ptt"); if (b && !b.disabled) { e.preventDefault(); b.setPointerCapture(e.pointerId); startDirect(); } });
$("direct").addEventListener("pointerup", (e) => { if (e.target.closest("#dl-ptt") && R.tx === "direct") stopTalk(); });
$("direct").addEventListener("pointercancel", () => { if (R.tx === "direct") stopTalk(); });
// Clicking someone's name on a net picks them for the direct line.
$("nets").addEventListener("click", (e) => { const c = e.target.closest("[data-pick]"); if (c) pickDirect(c.dataset.pick); });
$("nets").addEventListener("keydown", (e) => { const c = e.target.closest("[data-pick]"); if (c && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); pickDirect(c.dataset.pick); } });

// ---------- the Nets screen (BeardedVeX and S3 - Core) ----------
const LISTEN_TXT = { member: "Everyone (Recruits too)", private: "Private and up" };
const TALK_TXT = { private: "Private and up", lead: "Leads: FTL seats, Sergeants and up, Squad Leader, S3", allcall: "Tonight's Squad Leader and S3", s3: "S3 only" };
const EAR_TXT = { "-1": "Left ear", "0": "Both ears", "1": "Right ear" };
let netEdit = null, netSure = null;
function netsScreen() {
  const box = $("nets-screen"); if (!box || $("v-nets").hidden || !R.me) return;
  const keys = Object.keys(R.nets);
  const f = netEdit;
  const opts = (map, v) => Object.entries(map).map(([k, t]) => `<option value="${k}"${String(v) === k ? " selected" : ""}>${esc(t)}</option>`).join("");
  box.innerHTML = `
    <p class="muted">Changes go live for everyone on Dad Net straight away. Command always stays (FTL seats talk there).</p>
    <div class="nl">${keys.map((k, i) => { const n = R.nets[k]; return `<div class="nrow" data-k="${esc(k)}">
      <span class="tag">${esc(n.short)}</span>
      <div class="grow"><b>${esc(n.name)}</b>${n.oneOff ? ' <span class="tag tonight">TONIGHT ONLY</span>' : ""}${n.joinable ? "" : ' <span class="tag">ALWAYS ON</span>'}
        <div class="muted">Listen: ${esc(LISTEN_TXT[n.listen])} · Talk: ${esc(TALK_TXT[n.talk])} · ${esc(EAR_TXT[String(n.ear ?? 1)])}</div></div>
      <button class="ghost small" data-nm="-1" ${i ? "" : "disabled"} aria-label="Move ${esc(n.name)} up">↑</button>
      <button class="ghost small" data-nm="1" ${i < keys.length - 1 ? "" : "disabled"} aria-label="Move ${esc(n.name)} down">↓</button>
      <button class="ghost small" data-ne>Edit</button>
      ${k === "command" ? "" : `<button class="ghost small ${netSure === k ? "sure" : ""}" data-nd>${netSure === k ? "Sure? Tap again" : "Delete"}</button>`}
    </div>`; }).join("")}</div>
    ${f ? `<form class="box nform" id="net-form">
      <div class="label">${f.key ? `EDIT ${esc((R.nets[f.key] || {}).name || "").toUpperCase()}` : f.oneOff ? "NEW NET FOR TONIGHT" : "NEW NET"}</div>
      <label>Name <input name="name" maxlength="30" required value="${esc(f.name || "")}" placeholder="Like Armor or Bravo Squad"></label>
      <label>Short tag (2 to 5) <input name="short" maxlength="5" required value="${esc(f.short || "")}" placeholder="ARM"></label>
      <label>What it's for <input name="desc" maxlength="140" value="${esc(f.desc || "")}" placeholder="One line people see under the name"></label>
      <label>Who can listen <select name="listen">${opts(LISTEN_TXT, f.listen || "private")}</select></label>
      <label>Who can talk <select name="talk">${opts(TALK_TXT, f.talk || "private")}</select></label>
      <label>Starts in <select name="ear">${opts(EAR_TXT, f.ear ?? 1)}</select></label>
      <label class="opt"><input type="checkbox" name="joinable" ${f.joinable === false ? "" : "checked"}> People join it (untick: everyone who can listen is always on it)</label>
      ${f.key ? "" : `<label class="opt"><input type="checkbox" name="oneOff" ${f.oneOff ? "checked" : ""}> Tonight only (it goes away at 6 AM Eastern)</label>`}
      <p class="muted" id="net-err" role="alert"></p>
      <div class="update-line"><button class="join" type="submit">Save</button><button class="ghost small" type="button" id="net-cancel">Cancel</button></div>
    </form>` : `<div class="update-line"><button class="join" id="net-add">Add a net</button><button class="join" id="net-tonight">Add a net for tonight</button>
      <button class="ghost small ${netSure === "__reset" ? "sure" : ""}" id="net-reset">${netSure === "__reset" ? "Sure? Tap again" : "Put back the starting nets"}</button></div>`}`;
}
async function netsAsk(msg) {
  try { const r = await ask(msg); if (r.t === "error") { flash(r.reason); const e = $("net-err"); if (e) e.textContent = r.reason; return false; } return true; }
  catch (e) { flash(e.message); return false; }
}
$("nets-screen").addEventListener("click", async (e) => {
  const row = e.target.closest(".nrow"), k = row && row.dataset.k;
  if (e.target.closest("[data-nm]")) { netSure = null; await netsAsk({ t: "nets:move", key: k, dir: +e.target.closest("[data-nm]").dataset.nm }); return; }
  if (e.target.closest("[data-ne]")) { netSure = null; netEdit = { key: k, ...R.nets[k] }; netsScreen(); return; }
  if (e.target.closest("[data-nd]")) {
    if (netSure !== k) { netSure = k; netsScreen(); return; }
    netSure = null; await netsAsk({ t: "nets:delete", key: k }); netsScreen(); return;
  }
  if (e.target.id === "net-add" || e.target.id === "net-tonight") { netSure = null; netEdit = { oneOff: e.target.id === "net-tonight", joinable: true, ear: 1 }; netsScreen(); $("net-form")?.querySelector("input")?.focus(); return; }
  if (e.target.id === "net-cancel") { netEdit = null; netsScreen(); return; }
  if (e.target.id === "net-reset") {
    if (netSure !== "__reset") { netSure = "__reset"; netsScreen(); return; }
    netSure = null; await netsAsk({ t: "nets:reset" }); netsScreen();
  }
});
$("nets-screen").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const net = { key: netEdit && netEdit.key, name: fd.get("name"), short: fd.get("short"), desc: fd.get("desc"), listen: fd.get("listen"), talk: fd.get("talk"),
    ear: +fd.get("ear"), joinable: fd.get("joinable") === "on" };
  if (await netsAsk({ t: "nets:save", net, oneOff: fd.get("oneOff") === "on" })) { netEdit = null; netsScreen(); }
});
$("nets-open").onclick = () => { netEdit = null; netSure = null; show("v-nets"); netsScreen(); };
$("nets-back").onclick = () => { netEdit = null; show(R.off ? "v-off" : "v-net"); };

// ---------- fireteams and FTL seats ----------
// One FTL seat per Discord "Fireteam" channel. Anyone Private+ in that channel can take it;
// tonight's Squad Leader and S3 can assign, change or clear seats. The seat holder talks on Command.
function renderSeats() {
  const box = $("fireteams"), seats = R.seats || [];
  const sl = R.roster.find((p) => p.squadLeader);
  if (!seats.length && !sl) { box.hidden = true; box.innerHTML = ""; return; }
  // Don't rebuild under someone's open Assign dropdown.
  if (box.contains(document.activeElement) && document.activeElement.tagName === "SELECT") return;
  box.hidden = false;
  const me = myEntry(), myCh = me && me.voice && me.voice.id;
  const boss = R.me.staff || R.me.squadLeader, priv = R.me.level === "private";
  box.innerHTML = `<div class="label pad nets-head"><span>FIRETEAMS</span><span class="klbl">${sl ? "Squad Leader: " + esc(sl.callsign) : "No Squad Leader on net"}</span></div>` +
    seats.map((st) => {
      const here = myCh === st.ch, mine = !!st.holder && st.holder.id === R.me.id;
      const inCh = R.roster.filter((p) => p.voice && p.voice.id === st.ch && p.level === "private");
      const talking = st.holder && R.roster.find((p) => p.id === st.holder.id && p.talking === "command");
      let act = "";
      if (mine) act = `<button class="ghost small" data-seat="release" data-ch="${esc(st.ch)}">Give up</button>`;
      else if (!st.holder && here && priv) act = `<button class="join" data-seat="claim" data-ch="${esc(st.ch)}">Take FTL</button>`;
      const pick = boss ? `<select class="ftpick" data-ch="${esc(st.ch)}" aria-label="Assign the ${esc(st.tag)} FTL seat"><option value="">${st.holder ? "Change…" : "Assign…"}</option>` +
        inCh.filter((p) => !st.holder || p.id !== st.holder.id).map((p) => `<option value="${esc(p.conn)}">${esc(p.callsign)}</option>`).join("") +
        (st.holder ? '<option value="__clear">Clear seat</option>' : "") + "</select>" : "";
      const holder = st.holder ? `<b>${mine ? "You" : esc(st.holder.callsign)}</b>${st.holder.away ? ' <span class="muted">(away)</span>' : ""}` : '<span class="muted">open</span>';
      return `<div class="ft${mine ? " mine" : ""}${here ? " here" : ""}${talking ? " live" : ""}"><span class="fttag">${esc(st.tag)}</span>` +
        `<div class="grow"><div class="ftname">${esc(st.name)} · ${st.count} on Dad Net${here ? " · you're here" : ""}</div><div class="ftl">FTL: ${holder}</div></div>${act}${pick}</div>`;
    }).join("") + (seats.length ? "" : '<p class="muted ftnone">Nobody is in a team channel in Discord yet.</p>');
}
async function seatCmd(op, ch, conn) {
  try { const r = await ask({ t: "seat", op, ch, conn }); if (r.t === "error") flash(r.reason); } catch (e) { flash(e.message); }
}
$("fireteams").addEventListener("click", (e) => { const b = e.target.closest("[data-seat]"); if (b) seatCmd(b.dataset.seat, b.dataset.ch); });
$("fireteams").addEventListener("change", (e) => {
  const sel = e.target.closest(".ftpick"); if (!sel || !sel.value) return;
  const v = sel.value; sel.blur();
  if (v === "__clear") seatCmd("clear", sel.dataset.ch); else seatCmd("assign", sel.dataset.ch, v);
});

// ---------- going off net (the app and the Battle Board stay open) ----------
function goOff() {
  if (R.off) return;
  R.off = true; R.stopping = true;
  if (R.ws) R.ws.onclose = null;
  for (const w of R.waiting.values()) w.fail(new Error("Off net."));
  R.waiting.clear();
  teardown();
  R.roster = []; R.seats = [];
  show("v-off");
  if (DESK) DESK.overlay({ on: false, status: "Off net", nets: [] });
  feedBoard();
}
function backOn() {
  if (!R.off) return;
  R.off = false; R.stopping = false;
  $("backon").disabled = true;
  connect().catch((e) => { show("v-ready"); $("ready-err").textContent = e.message || String(e); })
    .finally(() => { $("backon").disabled = false; });
}
$("offnet").onclick = goOff;
$("backon").onclick = backOn;

// ---------- the Battle Board ----------
// The board (board.html) is its own page: in the app it folds out beside the radio,
// in a browser it opens in its own window. This page tells it what's going on.
let boardChan = null;
try {
  boardChan = new BroadcastChannel("dad-net");
  boardChan.onmessage = (e) => {
    if (e.data && e.data.t === "hello") feedBoard();
    if (e.data && e.data.t === "pick" && typeof e.data.conn === "string") pickDirect(e.data.conn, true); // a name clicked on the Battle Board
  };
} catch {}
function feedBoard() {
  if (!boardChan) return;
  const st = R.off || !R.me ? { off: R.off, signedIn: !!R.me, callsign: R.me && R.me.callsign } : {
    off: false, signedIn: true, status: $("status-text").textContent,
    me: { id: R.me.id, callsign: R.me.callsign, rank: R.me.rank, staff: R.me.staff, squadLeader: R.me.squadLeader, level: R.me.level },
    tonight: R.me.tonight, conn: R.conn, tx: R.tx,
    nets: Object.fromEntries(Object.entries(R.nets).map(([k, n]) => [k, { name: n.name, short: n.short, key: canTalkNet(k) ? (S(k).key ? keyLabel(S(k).key) : "no key") : null }])),
    roster: R.roster.map((p) => ({ id: p.id, conn: p.conn, callsign: p.callsign, rank: p.rank, squadLeader: p.squadLeader, staff: p.staff,
      voice: p.voice, ftl: p.ftl, nets: p.nets, monitor: p.monitor, talking: p.talking })),
    seats: R.seats,
    direct: { can: canTalkNet("direct"), pick: R.directPick, to: directTarget(), incoming: [...R.incoming.values()], tx: R.tx === "direct" ? R.txTo : null, key: keyLabel(S("direct").key) },
  };
  try { boardChan.postMessage({ t: "state", state: st }); } catch {}
}
$("board-open").onclick = () => {
  if (DESK && DESK.pda) return DESK.pda(true);
  window.open("/board", "dadnet-board", "popup,width=1000,height=820");
};
if (DESK && DESK.onNetCmd) DESK.onNetCmd((c) => (c === "off" ? goOff() : backOn()));

boot().catch((e) => { show("v-ready"); $("ready-err").textContent = "Couldn't load the radio: " + (e.message || e); });
