// =====================================================================
//  DAD Ops Radio - net control (Cloudflare Worker + one Durable Object)
//
//  What runs where:
//    * This Worker sends out the test page (the files in /public) and
//      hands every /api/net connection to the "crew" Durable Object.
//    * The Durable Object ("Radio", below) is the switchboard: it checks
//      who you are with the dadops.gg sign-in, keeps track of who's on
//      which net and who's talking, and is the only thing that talks to
//      Cloudflare Realtime (the voice relay), because that needs the
//      App Secret, which must never reach a browser.
//
//  Settings (wrangler.jsonc "vars", plus one secret):
//    SUPABASE_URL, SUPABASE_KEY  the same public values as dadops.gg
//    REALTIME_APP_ID             (secret) from Cloudflare > Realtime > SFU
//    REALTIME_APP_SECRET         (secret) from the same place
//    SFU_BASE                    optional, only changed for local tests
// =====================================================================

// The nets, in the order they show. To add one: copy a line, give it a new
// key (lowercase, no spaces), name, short tag and description, then push.
//   listen/talk: "private" = Private and up, "member" = everyone signed in,
//                "allcall" = S3 + tonight's Squad Leader
export const NETS = {
  command: { name: "Command", short: "CMD", listen: "private", talk: "private", joinable: true,
             desc: "Fireteam leads talking to each other." },
  recon:   { name: "Recon", short: "RCN", listen: "private", talk: "private", joinable: true,
             desc: "Scouts and snipers calling out what they see." },
  air:     { name: "Air Support", short: "AIR", listen: "private", talk: "private", joinable: true,
             desc: "Heli pilots and air support calls." },
  logi:    { name: "Logistics / Vehicles", short: "LOG", listen: "private", talk: "private", joinable: true,
             desc: "Drivers, supply runs and vehicle moves." },
  allcall: { name: "All-call", short: "ALL", listen: "member", talk: "allcall", joinable: false,
             desc: "Tonight's Squad Leader and S3 can talk to everyone. Plays a chirp first." },
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/config") {
      return json({ supabaseUrl: env.SUPABASE_URL, supabaseKey: env.SUPABASE_KEY, nets: NETS });
    }
    if (url.pathname === "/api/net") {
      if (request.headers.get("Upgrade") !== "websocket") return json({ error: "Expected a WebSocket" }, 426);
      const id = env.RADIO.idFromName("crew");
      return env.RADIO.get(id).fetch(request);
    }
    if (url.pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);
    return env.ASSETS.fetch(request);
  },
};

// ---------------------------------------------------------------------
//  Who are you? Checks the dadops.gg sign-in and works out what you can do.
// ---------------------------------------------------------------------
export async function whoIs(env, token, now = Date.now()) {
  if (typeof token !== "string" || token.length < 20 || token.length > 4096) return { error: "Sign in again." };
  const base = String(env.SUPABASE_URL || "").replace(/\/+$/, "");
  const h = { apikey: env.SUPABASE_KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const ures = await fetch(`${base}/auth/v1/user`, { headers: h });
  if (!ures.ok) return { error: "Your sign-in has expired. Sign in again." };
  const user = await ures.json();
  if (!user || !user.id) return { error: "Sign in again." };

  // The same check the website's Private-only pages use.
  const mres = await fetch(`${base}/rest/v1/rpc/member_pages_me`, { method: "POST", headers: h, body: "{}" });
  if (!mres.ok) return { error: "Couldn't check your rank on dadops.gg. Try again in a minute." };
  const m = await mres.json();
  let level;
  if (m && m.ok === true) level = "private";
  else if (m && m.why === "recruit") level = "recruit";
  else if (m && m.why === "not_joined") return { error: "Finish joining DAD Ops on dadops.gg first." };
  else if (m && m.why === "locked") return { error: "This account can't use the radio." };
  else if (m && m.why === "away") return { error: "Rejoin the DAD Ops Discord to use the radio." };
  else return { error: "Sign in again." };

  // Callsign, rank and S3 badge (profiles are public on dadops.gg).
  let callsign = "Operator", staff = false, rank = null;
  const pres = await fetch(`${base}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=callsign,staff,service_rank`, { headers: h });
  if (pres.ok) {
    const rows = await pres.json();
    if (rows && rows[0]) { callsign = rows[0].callsign || callsign; staff = rows[0].staff != null; rank = rows[0].service_rank || null; }
  } else {
    const p2 = await fetch(`${base}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=callsign`, { headers: h });
    if (p2.ok) { const r = await p2.json(); if (r && r[0] && r[0].callsign) callsign = r[0].callsign; }
  }

  // Tonight's Squad Leader: leading an op that started up to 5 hours ago or
  // starts within the next 2 hours.
  let squadLeader = false, tonight = null;
  const from = new Date(now - 5 * 3600e3).toISOString(), to = new Date(now + 2 * 3600e3).toISOString();
  const ores = await fetch(`${base}/rest/v1/ops?select=id,title,starts_at,lead_id&cancelled=eq.false&starts_at=gte.${from}&starts_at=lte.${to}&order=starts_at.asc`, { headers: h });
  if (ores.ok) {
    const ops = await ores.json();
    if (Array.isArray(ops) && ops.length) {
      const mine = ops.find((o) => o.lead_id === user.id);
      squadLeader = !!mine;
      const o = mine || ops[0];
      tonight = { title: o.title, startsAt: o.starts_at };
    }
  }

  return { id: user.id, callsign, rank, level, staff, squadLeader, tonight };
}

export function rights(me) {
  const can = { listen: [], talk: [] };
  const isPrivate = me.level === "private";
  for (const [key, net] of Object.entries(NETS)) {
    const listen = net.listen === "member" || (net.listen === "private" && isPrivate);
    const talk = net.talk === "private" ? isPrivate : net.talk === "allcall" ? (me.staff || me.squadLeader) : false;
    if (listen) can.listen.push(key);
    if (talk) can.talk.push(key);
  }
  return can;
}

// ---------------------------------------------------------------------
//  The switchboard
// ---------------------------------------------------------------------
export class Radio {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ state: "hello", at: Date.now() });
    // Anyone who doesn't sign in within 15 seconds is dropped.
    const alarm = await this.ctx.storage.getAlarm();
    if (!alarm) await this.ctx.storage.setAlarm(Date.now() + 15000);
    return new Response(null, { status: 101, webSocket: client });
  }

  async alarm() {
    let waiting = false;
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() || {};
      if (a.state === "hello") {
        if (Date.now() - (a.at || 0) > 15000) { try { ws.close(4001, "Sign in took too long"); } catch {} }
        else waiting = true;
      }
    }
    if (waiting) await this.ctx.storage.setAlarm(Date.now() + 15000);
  }

  members() {
    const out = [];
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (a && a.state === "on") out.push({ ws, a });
    }
    return out;
  }

  roster() {
    return this.members().map(({ a }) => ({
      id: a.me.id, conn: a.conn, callsign: a.me.callsign, rank: a.me.rank || null, level: a.me.level, staff: a.me.staff,
      squadLeader: a.me.squadLeader, nets: a.nets, monitor: a.monitor || [], talking: a.talking || null,
      published: !!(a.sessionId && a.trackName),
    }));
  }

  send(ws, msg) { try { ws.send(JSON.stringify(msg)); } catch {} }
  broadcast(msg) { const s = JSON.stringify(msg); for (const { ws } of this.members()) { try { ws.send(s); } catch {} } }
  pushRoster() { this.broadcast({ t: "roster", members: this.roster() }); }

  sfu(path, method, body) {
    const base = (this.env.SFU_BASE || "https://rtc.live.cloudflare.com/v1").replace(/\/+$/, "");
    return fetch(`${base}/apps/${this.env.REALTIME_APP_ID}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.env.REALTIME_APP_SECRET}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  async webSocketMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)); } catch { return; }
    if (!msg || typeof msg.t !== "string") return;
    const a = ws.deserializeAttachment() || {};
    const reply = (m) => this.send(ws, { ...m, re: msg.id });

    try {
      if (msg.t === "hello") {
        if (a.state !== "hello") return;
        const me = await whoIs(this.env, msg.token);
        if (me.error) { reply({ t: "denied", reason: me.error }); try { ws.close(4003, "Not allowed"); } catch {} return; }
        const can = rights(me);
        const conn = crypto.randomUUID().slice(0, 8);
        // Everyone hears All-call. Command and Air are opt-in.
        const nets = can.listen.filter((n) => !NETS[n].joinable);
        ws.serializeAttachment({ state: "on", me, can, conn, nets, talking: null });
        reply({ t: "welcome", me, can, conn, nets: NETS, roster: this.roster() });
        this.pushRoster();
        return;
      }
      if (a.state !== "on") return;

      if (msg.t === "join" || msg.t === "leave") {
        const net = msg.net;
        if (!NETS[net] || !NETS[net].joinable) return reply({ t: "error", reason: "That net can't be joined or left." });
        if (msg.t === "join" && !a.can.listen.includes(net)) return reply({ t: "error", reason: `${NETS[net].name} opens at Private.` });
        // mode "monitor" = listen only on that net; "talk" (or none) = listen and talk.
        const nets = new Set(a.nets), mon = new Set(a.monitor || []);
        if (msg.t === "join") { nets.add(net); msg.mode === "monitor" ? mon.add(net) : mon.delete(net); }
        else { nets.delete(net); mon.delete(net); }
        a.nets = Object.keys(NETS).filter((n) => nets.has(n));
        a.monitor = a.nets.filter((n) => mon.has(n));
        let stopped = false;
        if (a.talking && (!a.nets.includes(a.talking) || a.monitor.includes(a.talking))) { a.talking = null; stopped = true; }
        ws.serializeAttachment(a);
        reply({ t: "ok", nets: a.nets, monitor: a.monitor });
        if (stopped) this.broadcast({ t: "talking", conn: a.conn, net: null });
        this.pushRoster();
        return;
      }

      if (msg.t === "talk") {
        const net = msg.net || null;
        if (net && (!a.can.talk.includes(net) || !a.nets.includes(net))) return reply({ t: "error", reason: "You can't talk on that net." });
        if (net && (a.monitor || []).includes(net)) return reply({ t: "error", reason: "You're only monitoring that net." });
        if (net && !(a.sessionId && a.trackName)) return reply({ t: "error", reason: "Your mic isn't connected yet." });
        if ((a.talking || null) === net) return;
        a.talking = net;
        ws.serializeAttachment(a);
        this.broadcast({ t: "talking", conn: a.conn, net });
        return;
      }

      if (msg.t === "session") {
        if (a.sessionId) return reply({ t: "session", sessionId: a.sessionId });
        if (!this.env.REALTIME_APP_ID || !this.env.REALTIME_APP_SECRET) {
          return reply({ t: "error", reason: "The radio isn't finished being set up: the Realtime App ID or App Secret is missing in Cloudflare." });
        }
        const r = await this.sfu("/sessions/new", "POST");
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.sessionId) return reply({ t: "error", reason: "The voice relay didn't answer. Try again." });
        a.sessionId = j.sessionId;
        ws.serializeAttachment(a);
        return reply({ t: "session", sessionId: j.sessionId });
      }

      if (msg.t === "publish") {
        if (!a.can.talk.length) return reply({ t: "error", reason: "You're listen-only." });
        if (!a.sessionId) return reply({ t: "error", reason: "No voice session yet." });
        if (typeof msg.sdp !== "string" || typeof msg.mid !== "string") return;
        const trackName = `mic-${a.conn}`;
        const r = await this.sfu(`/sessions/${a.sessionId}/tracks/new`, "POST", {
          sessionDescription: { type: "offer", sdp: msg.sdp },
          tracks: [{ location: "local", mid: msg.mid, trackName }],
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.sessionDescription) return reply({ t: "error", reason: "Couldn't connect your mic to the relay." });
        a.trackName = trackName;
        ws.serializeAttachment(a);
        reply({ t: "published", sdp: j.sessionDescription.sdp });
        this.pushRoster();
        return;
      }

      if (msg.t === "pull") {
        if (!a.sessionId) return reply({ t: "error", reason: "No voice session yet." });
        const target = this.members().find(({ a: b }) => b.conn === msg.conn);
        if (!target || !target.a.sessionId || !target.a.trackName) return reply({ t: "pulled", conn: msg.conn, gone: true });
        const r = await this.sfu(`/sessions/${a.sessionId}/tracks/new`, "POST", {
          tracks: [{ location: "remote", sessionId: target.a.sessionId, trackName: target.a.trackName }],
        });
        const j = await r.json().catch(() => ({}));
        const tr = j.tracks && j.tracks[0];
        if (!r.ok || !tr || tr.errorCode) return reply({ t: "pulled", conn: msg.conn, gone: true });
        return reply({ t: "pulled", conn: msg.conn, mid: tr.mid, sdp: j.sessionDescription && j.sessionDescription.sdp,
          renegotiate: !!j.requiresImmediateRenegotiation });
      }

      if (msg.t === "renegotiate") {
        if (!a.sessionId || typeof msg.sdp !== "string") return;
        const r = await this.sfu(`/sessions/${a.sessionId}/renegotiate`, "PUT", { sessionDescription: { type: "answer", sdp: msg.sdp } });
        return reply({ t: r.ok ? "ok" : "error", reason: r.ok ? undefined : "The relay didn't accept the update." });
      }

      if (msg.t === "ping") return reply({ t: "pong" });
    } catch (e) {
      reply({ t: "error", reason: "Something went wrong on the net. Try again." });
    }
  }

  async webSocketClose(ws) {
    const a = ws.deserializeAttachment() || {};
    try { ws.close(1000, "bye"); } catch {}
    if (a.state === "on") {
      ws.serializeAttachment({ state: "gone" });
      if (a.talking) this.broadcast({ t: "talking", conn: a.conn, net: null });
      this.pushRoster();
    }
  }

  async webSocketError(ws) { return this.webSocketClose(ws); }
}
