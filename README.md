# Dad Net

DAD Ops' own radio (it used to be called DAD Ops Radio; the repo keeps its old name).

Extra voice nets on top of Discord, so fireteam leads can reach each other
without swapping channels. Fireteams keep talking in their Discord channels
as normal. The radio adds:

| Net | Who | Notes |
|---|---|---|
| **Command** | Talk: whoever holds a fireteam's **FTL seat**, Sergeants and up, tonight's Squad Leader and S3. Listen: Private and up | Fireteam leads talking to each other. Left ear by default |
| **Recon** | Private and up | Scouts and snipers. Right ear by default |
| **Air Support** | Private and up | Heli pilots and air support. Right ear by default |
| **Logistics / Vehicles** | Private and up | Drivers and supply runs. Right ear by default |
| **All-call** | Everyone listens; S3 and tonight's Squad Leader talk | Both ears, chirp first |

**FTL seats:** fireteams stay in Discord. Every team channel in Discord gets one
FTL seat: any voice channel in The Rally Point's category (Horton's op-night
channels like "⚔️ Assault 1", Alpha Squad...) except The Rally Point and the
AFK channel, plus anything named "Fireteam 2" or "FT2". Anyone Private+ in that channel can click
**Take FTL**; it puts them on Command in Talk mode. Tonight's Squad Leader and
S3 can assign, change or clear seats. A seat frees itself about a minute after
its FTL leaves that Discord channel (or Dad Net), and all seats reset each op
night (6 AM Eastern). This needs the Discord bot set up (SETUP.md).

**Battle Board:** Dad Net's own tactical screen (`public/board.html`):
tonight's op with a muster/step-off countdown, the squad board (fireteams,
FTLs, who's in which channel and on which net, who's talking), your comms and
keys, a stopwatch and countdown, and a notepad saved on that computer. In the
app it folds out of the field kit (F9); in a browser, the **Battle Board**
button opens it in its own window. The Field PDA stays on dadops.gg.

**Status:** the browser version is live. The **desktop app** (talk keys that
work while the game has focus, Mouse 4/5, the overlay, tray, start with
Windows, auto-update) is in `desktop/`. Build and install steps: [DESKTOP.md](DESKTOP.md).

Plan: `claude/Radio-Plan.md` in the DAD Ops project. Setup: [SETUP.md](SETUP.md).
Test night: [TEST-NIGHT.md](TEST-NIGHT.md).

## How it works

```
 Browser (public/)              Cloudflare Worker (src/worker.js)         Cloudflare Realtime
 ─────────────────              ─────────────────────────────────         ───────────────────
 sign in (dadops.gg login) ───▶ checks your rank with dadops.gg
 nets, who's talking  ◀──────▶ "Radio" switchboard (Durable Object) ───▶ voice sessions/tracks
 your mic + everyone else ◀══════════════ voice (WebRTC) ═══════════════▶ the voice relay
```

- **Sign-in:** the same Supabase Discord login as dadops.gg. The Worker
  checks it with `member_pages_me()` (the Private-only pages check), reads
  the callsign and S3 badge from `profiles`, and tonight's Squad Leader from
  `ops.lead_id`. Read-only: no new tables or functions on dadops.gg.
- **Switchboard:** one Durable Object keeps who's on which net and who's
  talking, and is the only thing holding the Realtime App Secret.
- **Voice:** each person who can talk sends one mic stream, switched off
  except while a talk key is held. Everyone gets everyone's stream, and the
  page only lets through people talking on a net you're on, in that net's
  ear and volume.

## Files

| File | What |
|---|---|
| `wrangler.jsonc` | Cloudflare settings (public values only) |
| `src/worker.js` | The Worker and the switchboard |
| `public/index.html`, `radio.js`, `radio.css`, `patch.png` | The radio page |
| `public/board.html`, `board.js`, `board.css` | The Battle Board (gets its info from the radio page through the browser, never connects by itself) |
| `SETUP.md` | One-time setup steps |
| `TEST-NIGHT.md` | Checklist for the first test with the crew |
| `desktop/` | The Windows app (Electron): `main.js` window/tray/keys/overlay/updates, `shell.html`/`shell.js` the field kit chassis, `keys.js`, `preload.js`, `overlay.html`/`overlay.js`, `config.json` (the radio address) |
| `.github/workflows/desktop.yml` | Builds the installer on GitHub (Actions → Build desktop app → Run workflow). A copy to paste in is `desktop/build-workflow.yml` |
| `DESKTOP.md` | Building, installing and using the desktop app |
| `site/` | radio.dadops.gg, Dad Net's home page (own Vercel project). Steps: `HOME-PAGE.md` |

**Adding or changing a net (v0.6):** the **Nets** button on the radio
(BeardedVeX and S3 - Core only, checked with dadops.gg's `desk_can('health')`)
opens the Nets screen: add, rename, reorder or delete nets, set who listens
(everyone, or Private and up) and who talks (Private and up; leads = FTL seats,
Sergeants and up, Squad Leader, S3; Squad Leader and S3; S3 only), always on
or join/leave, and the default ear. **Add a net for tonight** makes one that
goes away at 6 AM Eastern. Command can't be deleted (FTL seats talk there).
Changes go live for everyone straight away; the switchboard keeps them. The
`NETS` list in `src/worker.js` is only the starting set (**Put back the
starting nets** restores it).

**Direct line (v0.6):** talk to one person. Pick them (click their name on a
net or the Battle Board, the Calling list, or the Next key in-game), then hold
the Direct key. With nobody picked, the Direct key replies to whoever called you
last. Private and up can start a call; anyone on Dad Net can be called. Only
the person called hears it on their radio. (Everyone's app receives everyone's
voice and plays only what's meant for it, so it isn't encrypted end to end.)

**Turn Discord down (app v0.6, Windows):** lowers Discord's slider in the
Windows Volume Mixer while the radio talks to you (or while anyone talks,
you too), to a level you pick or muted, then puts it back. `desktop/duck.ps1`
does it (a small PowerShell helper the app starts once); `desktop/duck.js`
drives it.

Secrets (in Cloudflare only, never in this repo): `REALTIME_APP_ID`,
`REALTIME_APP_SECRET`, and optionally `DISCORD_BOT_TOKEN` + `DISCORD_RALLY_POINT_ID`
(shows each person's Discord voice channel; see SETUP.md) and `TURN_KEY_ID` +
`TURN_KEY_API_TOKEN` (the backup route through Cloudflare's TURN relay for
networks that block voice; `?relay=1` on the radio's address forces it to test),
and `DADNET_KEY` (the same key as in dadops.gg's Vercel: Dad Net tells the website
who's on Command and each team's FTL, for Horton's lineup card, the muster board
and the op card; see DAD-NET.md in the website repo).
