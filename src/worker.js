// =====================================================================
//  Dad Net (DAD Ops radio) - net control (Cloudflare Worker + one Durable Object)
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
//    DISCORD_BOT_TOKEN           (secret, optional) Maj. Horton's bot token, to show
//                                which Discord voice channel each person is in
//    DISCORD_RALLY_POINT_ID      (secret, optional) The Rally Point's channel ID
//                                (how the radio finds the DAD Ops server)
//    SFU_BASE, DISCORD_API       optional, only changed for local tests
// =====================================================================

// The nets, in the order they show. To add one: copy a line, give it a new
// key (lowercase, no spaces), name, short tag and description, then push.
//   listen/talk: "private" = Private and up, "member" = everyone signed in,
//                "allcall" = S3 + tonight's Squad Leader,
//                "lead" = Sergeant and up, S3, tonight's Squad Leader, and
//                         whoever holds a fireteam's FTL seat
export const NETS = {
  command: { name: "Command", short: "CMD", listen: "private", talk: "lead", joinable: true,
             desc: "Fireteam leads (FTLs), the Squad Leader and Sergeants and up." },
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
  const ores = await fetch(`${base}/rest/v1/ops?select=id,title,details,starts_at,lead_id&cancelled=eq.false&starts_at=gte.${from}&starts_at=lte.${to}&order=starts_at.asc`, { headers: h });
  if (ores.ok) {
    const ops = await ores.json();
    if (Array.isArray(ops) && ops.length) {
      const mine = ops.find((o) => o.lead_id === user.id);
      squadLeader = !!mine;
      const o = mine || ops[0];
      tonight = { title: o.title, details: o.details || "", startsAt: o.starts_at };
    }
  }

  // Their Discord account ID (from the Discord sign-in), for the voice channel lookup.
  const ident = (user.identities || []).find((i) => i.provider === "discord");
  const discordId = String((ident && ident.identity_data && (ident.identity_data.provider_id || ident.identity_data.sub)) ||
    (user.user_metadata && (user.user_metadata.provider_id || user.user_metadata.sub)) || "");

  return { id: user.id, callsign, rank, level, staff, squadLeader, tonight, discordId: /^\d{15,22}$/.test(discordId) ? discordId : null };
}

// A short tag for a voice channel: "Fireteam 2" -> "FT2", anything else -> its name.
export function voiceTag(name) {
  const clean = String(name || "").replace(/[^\p{L}\p{N}\s'&/-]/gu, " ").replace(/\s+/g, " ").trim();
  const ft = /fire\s*team\s*(\d+)/i.exec(clean) || /\bft\s*(\d+)/i.exec(clean);
  if (ft) return "FT" + ft[1];
  return clean.length > 16 ? clean.slice(0, 15) + "…" : clean || "Voice";
}

// The dadops.gg rank ladder, lowest first (same codes as the website).
const RANK_ORDER = ["recruit", "pvt", "pfc", "cpl", "sgt", "sfc", "2lt", "1lt", "cpt", "maj", "ltc", "col"];
export const rankAtLeast = (rank, min) => RANK_ORDER.indexOf(rank) >= RANK_ORDER.indexOf(min) && RANK_ORDER.indexOf(rank) >= 0;

// The night an op belongs to (Eastern time, rolling over at 6 AM), for resetting FTL seats.
export function opDay(now = Date.now()) {
  return new Date(now - 6 * 3600e3).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

export function rights(me) {
  const can = { listen: [], talk: [] };
  const isPrivate = me.level === "private";
  for (const [key, net] of Object.entries(NETS)) {
    const listen = net.listen === "member" || (net.listen === "private" && isPrivate);
    const talk = net.talk === "private" ? isPrivate : net.talk === "allcall" ? (me.staff || me.squadLeader)
      : net.talk === "lead" ? (isPrivate && (rankAtLeast(me.rank, "sgt") || me.staff || me.squadLeader)) : false;
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
    // FTL seats: { day, list: { [fireteam channel id]: { userId, callsign, at, by, awaySince } } }
    this.seatState = { day: "", list: {} };
    ctx.blockConcurrencyWhile(async () => { this.seatState = (await ctx.storage.get("seats")) || this.seatState; });
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
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() || {};
      if (a.state === "hello" && Date.now() - (a.at || 0) > 15000) { try { ws.close(4001, "Sign in took too long"); } catch {} }
    }
    await this.voiceTick();
    // Keep ticking while anyone is connected (sign-in timeouts + Discord channels).
    if (this.ctx.getWebSockets().length) await this.ctx.storage.setAlarm(Date.now() + 15000);
  }

  // ---------- which Discord voice channel each person is in ----------
  discord(path) {
    const base = (this.env.DISCORD_API || "https://discord.com/api/v10").replace(/\/+$/, "");
    return fetch(base + path, { headers: { Authorization: `Bot ${this.env.DISCORD_BOT_TOKEN}`, "User-Agent": "Dad Net (dadops.gg, 1.0)" } });
  }
  async voiceTick() {
    if (!this.env.DISCORD_BOT_TOKEN || !/^\d+$/.test(String(this.env.DISCORD_RALLY_POINT_ID || ""))) return;
    const people = this.members().filter(({ a }) => a.me && a.me.discordId);
    if (!people.length) return;
    try {
      if (!this.guildId) {
        const r = await this.discord(`/channels/${this.env.DISCORD_RALLY_POINT_ID}`);
        if (!r.ok) return;
        this.guildId = (await r.json()).guild_id;
      }
      if (!this.chanNames || Date.now() - this.chanAt > 10 * 60e3) {
        const r = await this.discord(`/guilds/${this.guildId}/channels`);
        if (r.ok) { this.chanNames = new Map((await r.json()).map((c) => [String(c.id), c.name])); this.chanAt = Date.now(); }
      }
    } catch { return; }
    let changed = false;
    for (let i = 0; i < people.length; i += 5) { // a few at a time to stay friendly with Discord
      await Promise.all(people.slice(i, i + 5).map(async ({ ws, a }) => {
        let voice = a.voice || null;
        try {
          const r = await this.discord(`/guilds/${this.guildId}/voice-states/${a.me.discordId}`);
          if (r.status === 404) voice = null;
          else if (r.ok) {
            const j = await r.json();
            const name = j.channel_id ? (this.chanNames && this.chanNames.get(String(j.channel_id))) || "Voice" : null;
            voice = name ? { id: String(j.channel_id), name, tag: voiceTag(name) } : null;
          }
        } catch {}
        if (JSON.stringify(voice) !== JSON.stringify(a.voice || null)) { a.voice = voice; ws.serializeAttachment(a); changed = true; }
      }));
    }
    if (this.seatsTick()) changed = true;
    if (changed) this.pushRoster();
  }

  // ---------- FTL seats ----------
  seats() {
    if (this.seatState.day !== opDay()) { this.seatState = { day: opDay(), list: {} }; this.saveSeats(); } // fresh every op night
    return this.seatState.list;
  }
  saveSeats() { this.ctx.waitUntil(this.ctx.storage.put("seats", this.seatState)); }
  seatOf(userId) { const l = this.seats(); return Object.keys(l).find((ch) => l[ch].userId === userId) || null; }
  isFireteam(ch) { const n = this.chanNames && this.chanNames.get(String(ch)); return !!n && /^FT\d+$/.test(voiceTag(n)); }
  canTalk(a, net) {
    if (a.can.talk.includes(net)) return true;
    return net === "command" && a.me.level === "private" && !!this.seatOf(a.me.id);
  }
  // After someone gains or loses a seat: a seat holder goes on Command to talk;
  // someone who can no longer talk there drops back to listening.
  fixCommand(ws, a, gotSeat) {
    const nets = new Set(a.nets), mon = new Set(a.monitor || []);
    if (gotSeat) { nets.add("command"); mon.delete("command"); }
    else if (nets.has("command") && !this.canTalk(a, "command")) mon.add("command");
    a.nets = Object.keys(NETS).filter((n) => nets.has(n));
    a.monitor = a.nets.filter((n) => mon.has(n));
    let stopped = false;
    if (a.talking === "command" && (a.monitor.includes("command") || !a.nets.includes("command"))) { a.talking = null; stopped = true; }
    ws.serializeAttachment(a);
    this.send(ws, { t: "mine", nets: a.nets, monitor: a.monitor });
    if (stopped) this.broadcast({ t: "talking", conn: a.conn, net: null });
  }
  dropSeat(ch) {
    const l = this.seats(), seat = l[ch];
    if (!seat) return;
    delete l[ch]; this.saveSeats();
    const m = this.members().find(({ a }) => a.me.id === seat.userId);
    if (m) this.fixCommand(m.ws, m.a, false);
  }
  giveSeat(ch, ws, a, by) {
    const l = this.seats();
    const old = this.seatOf(a.me.id);
    if (old && old !== ch) delete l[old]; // one seat per person
    l[ch] = { userId: a.me.id, callsign: a.me.callsign, at: Date.now(), by, awaySince: null };
    this.saveSeats();
    this.fixCommand(ws, a, true);
  }
  // A seat frees itself once its FTL has been out of that channel (or off Dad Net) for a minute.
  seatsTick(now = Date.now()) {
    const l = this.seats();
    let changed = false;
    for (const ch of Object.keys(l)) {
      const seat = l[ch];
      const m = this.members().find(({ a }) => a.me.id === seat.userId);
      const here = m && m.a.voice && m.a.voice.id === ch;
      if (here) { if (seat.awaySince) { seat.awaySince = null; this.saveSeats(); } continue; }
      if (!seat.awaySince) { seat.awaySince = now; this.saveSeats(); continue; }
      if (now - seat.awaySince > (+this.env.SEAT_AWAY_MS || 60e3)) { this.dropSeat(ch); changed = true; }
    }
    return changed;
  }
  seatsView() {
    const l = this.seats(), ms = this.members();
    const chans = new Set(Object.keys(l));
    for (const { a } of ms) if (a.voice && a.voice.id && this.isFireteam(a.voice.id)) chans.add(a.voice.id);
    const num = (ch) => +((/\d+/.exec(voiceTag(this.chanNames && this.chanNames.get(ch))) || [999])[0]);
    return [...chans].sort((x, y) => num(x) - num(y)).map((ch) => {
      const name = (this.chanNames && this.chanNames.get(ch)) || "Fireteam";
      const seat = l[ch];
      const holder = seat ? ms.find(({ a }) => a.me.id === seat.userId) : null;
      return { ch, name, tag: voiceTag(name), count: ms.filter(({ a }) => a.voice && a.voice.id === ch).length,
        holder: seat ? { id: seat.userId, callsign: seat.callsign, conn: holder ? holder.a.conn : null, away: !!seat.awaySince } : null };
    });
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
    const l = this.seats();
    const ftlOf = (id) => { const ch = Object.keys(l).find((c) => l[c].userId === id); return ch ? voiceTag(this.chanNames && this.chanNames.get(ch)) : null; };
    return this.members().map(({ a }) => ({
      id: a.me.id, conn: a.conn, callsign: a.me.callsign, rank: a.me.rank || null, level: a.me.level, staff: a.me.staff,
      squadLeader: a.me.squadLeader, voice: a.voice ? { name: a.voice.name, tag: a.voice.tag, id: a.voice.id } : null,
      ftl: ftlOf(a.me.id), lead: !!(a.can && a.can.talk.includes("command")),
      nets: a.nets, monitor: a.monitor || [], talking: a.talking || null,
      published: !!(a.sessionId && a.trackName),
    }));
  }

  send(ws, msg) { try { ws.send(JSON.stringify(msg)); } catch {} }
  broadcast(msg) { const s = JSON.stringify(msg); for (const { ws } of this.members()) { try { ws.send(s); } catch {} } }
  pushRoster() { this.broadcast({ t: "roster", members: this.roster(), seats: this.seatsView() }); }

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
        reply({ t: "welcome", me: { ...me, discordId: undefined }, can, conn, nets: NETS, roster: this.roster(), seats: this.seatsView() });
        this.pushRoster();
        this.ctx.waitUntil(this.voiceTick()); // look up their Discord channel straight away
        return;
      }
      if (a.state !== "on") return;

      if (msg.t === "join" || msg.t === "leave") {
        const net = msg.net;
        if (!NETS[net] || !NETS[net].joinable) return reply({ t: "error", reason: "That net can't be joined or left." });
        if (msg.t === "join" && !a.can.listen.includes(net)) return reply({ t: "error", reason: `${NETS[net].name} opens at Private.` });
        // mode "monitor" = listen only on that net; "talk" (or none) = listen and talk.
        const nets = new Set(a.nets), mon = new Set(a.monitor || []);
        const listenOnly = msg.mode === "monitor" || !this.canTalk(a, net); // e.g. Command without a seat or Sergeant
        if (msg.t === "join") { nets.add(net); listenOnly ? mon.add(net) : mon.delete(net); }
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
        if (net && (!this.canTalk(a, net) || !a.nets.includes(net))) return reply({ t: "error", reason: net === "command" ? "Take your fireteam's FTL seat to talk on Command." : "You can't talk on that net." });
        if (net && (a.monitor || []).includes(net)) return reply({ t: "error", reason: "You're only monitoring that net." });
        if (net && !(a.sessionId && a.trackName)) return reply({ t: "error", reason: "Your mic isn't connected yet." });
        if ((a.talking || null) === net) return;
        a.talking = net;
        ws.serializeAttachment(a);
        this.broadcast({ t: "talking", conn: a.conn, net });
        return;
      }

      if (msg.t === "seat") {
        const ch = String(msg.ch || "");
        const l = this.seats();
        const boss = a.me.staff || a.me.squadLeader; // tonight's Squad Leader and S3 run the board
        if (msg.op === "claim") {
          if (a.me.level !== "private") return reply({ t: "error", reason: "FTL seats open at Private." });
          if (!a.voice || a.voice.id !== ch || !this.isFireteam(ch)) return reply({ t: "error", reason: "Join that fireteam's Discord channel first." });
          if (l[ch] && l[ch].userId !== a.me.id) return reply({ t: "error", reason: `${l[ch].callsign} already has that seat.` });
          this.giveSeat(ch, ws, a, a.me.id);
        } else if (msg.op === "release") {
          if (!l[ch] || (l[ch].userId !== a.me.id && !boss)) return reply({ t: "error", reason: "That isn't your seat." });
          this.dropSeat(ch);
        } else if (msg.op === "assign") {
          if (!boss) return reply({ t: "error", reason: "Only tonight's Squad Leader or S3 can assign seats." });
          const t = this.members().find(({ a: b }) => b.conn === msg.conn);
          if (!t) return reply({ t: "error", reason: "They're not on Dad Net right now." });
          if (t.a.me.level !== "private") return reply({ t: "error", reason: "FTL seats open at Private." });
          if (!this.isFireteam(ch)) return reply({ t: "error", reason: "That isn't a fireteam channel." });
          if (l[ch] && l[ch].userId !== t.a.me.id) this.dropSeat(ch);
          this.giveSeat(ch, t.ws, t.a, a.me.id);
        } else if (msg.op === "clear") {
          if (!boss) return reply({ t: "error", reason: "Only tonight's Squad Leader or S3 can clear seats." });
          this.dropSeat(ch);
        } else return;
        reply({ t: "ok" });
        this.pushRoster();
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
      this.seatsTick(); // starts the one-minute clock on their FTL seat, if they had one
      this.pushRoster();
    }
  }

  async webSocketError(ws) { return this.webSocketClose(ws); }
}
