// Turn Discord down while the radio talks (Windows).
// Runs duck.ps1 (a small PowerShell helper, started once) and tells it to
// lower Discord's slider in the Windows Volume Mixer, then put it back.
// Nothing about Discord itself is touched: it's the same slider you'd drag
// by hand. If the app goes away mid-call, the helper puts Discord back.
"use strict";
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

class Ducker {
  // dir: where to write the helper (a real folder, not inside the app's package)
  // onStatus(text): called when there's something new to show in the drawer
  constructor({ dir, source, onStatus = () => {} }) {
    this.dir = dir; this.source = source; this.onStatus = onStatus;
    this.proc = null; this.waiting = []; this.buf = "";
    this.ducked = false; this.level = 30; this.offTimer = null;
    this.status = process.platform === "win32" || process.env.DADOPS_DUCK_CMD ? "Not used yet" : "Only on Windows";
  }
  available() { return process.platform === "win32" || !!process.env.DADOPS_DUCK_CMD; }
  say(t) { if (t !== this.status) { this.status = t; this.onStatus(t); } }
  start() {
    if (this.proc || !this.available()) return !!this.proc;
    try {
      let cmd, args;
      if (process.env.DADOPS_DUCK_CMD) { // tests: a stand-in helper
        [cmd, ...args] = JSON.parse(process.env.DADOPS_DUCK_CMD);
      } else {
        const file = path.join(this.dir, "dadnet-duck.ps1");
        fs.writeFileSync(file, fs.readFileSync(this.source, "utf8"));
        cmd = "powershell.exe";
        args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", file];
      }
      this.proc = spawn(cmd, args, { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    } catch (e) { this.say(`Not working: ${e.message}`); return false; }
    this.ready = new Promise((ok) => (this.readyOk = ok));
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (d) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        if (line === "ready") { this.readyOk(true); continue; }
        if (/^err /.test(line) && this.waiting.length === 0) { this.say(`Not working: ${line.slice(4)}`); this.readyOk(false); continue; }
        const w = this.waiting.shift(); if (w) w(line);
      }
    });
    this.proc.on("exit", () => {
      this.proc = null; this.ducked = false;
      for (const w of this.waiting.splice(0)) w("err the helper stopped");
      if (this.readyOk) this.readyOk(false);
    });
    this.proc.on("error", (e) => this.say(`Not working: ${e.message}`));
    return true;
  }
  async send(line) {
    if (!this.start()) return "err not available";
    const ok = await Promise.race([this.ready, new Promise((r) => setTimeout(() => r(false), 15000))]);
    if (!ok || !this.proc) return "err the helper didn't start";
    return new Promise((resolve) => {
      const t = setTimeout(() => { const i = this.waiting.indexOf(done); if (i >= 0) this.waiting.splice(i, 1); resolve("err no answer"); }, 4000);
      const done = (r) => { clearTimeout(t); resolve(r); };
      this.waiting.push(done);
      try { this.proc.stdin.write(line + "\n"); } catch { done("err couldn't reach the helper"); }
    });
  }
  show(r, what) {
    const m = /^ok (\d+)/.exec(r);
    if (m) this.say(+m[1] ? `Working: ${what} Discord (${m[1]} sound stream${m[1] === "1" ? "" : "s"})` : "Discord isn't making any sound right now (start a call in Discord and try again)");
    else this.say(`Not working: ${String(r).replace(/^err /, "")}`);
  }
  // on: true while the radio's talking. Down straight away; back up after a short pause,
  // so it doesn't pump up and down between words.
  set(on, level) {
    if (!this.available()) return;
    if (Number.isFinite(level)) this.level = Math.max(0, Math.min(90, Math.round(level)));
    clearTimeout(this.offTimer);
    if (on) {
      if (this.ducked && this.duckedAt === this.level) return;
      this.ducked = true; this.duckedAt = this.level;
      this.send(`duck ${this.level}`).then((r) => this.show(r, this.level ? "turned down" : "muted"));
    } else if (this.ducked) {
      this.offTimer = setTimeout(() => { this.ducked = false; this.send("restore").then((r) => this.show(r, "put back")); }, 600);
    }
  }
  // The Test button: down for 2 seconds, then back.
  async test(level) {
    if (!this.available()) return this.status;
    const r = await this.send(`duck ${Math.max(0, Math.min(90, Math.round(level)))}`);
    this.show(r, "turned down");
    await new Promise((ok) => setTimeout(ok, 2000));
    if (!this.ducked) await this.send("restore");
    return this.status;
  }
  async stop() {
    clearTimeout(this.offTimer);
    if (!this.proc) return;
    await Promise.race([this.send("restore"), new Promise((r) => setTimeout(r, 1500))]);
    try { this.proc.stdin.end(); } catch {}
    const p = this.proc;
    setTimeout(() => { try { p && p.kill(); } catch {} }, 1500);
  }
}
module.exports = { Ducker };
