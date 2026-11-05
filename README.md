# DAD Ops Radio

Extra voice nets on top of Discord, so fireteam leads can reach each other
without swapping channels. Fireteams keep talking in their Discord channels
as normal. The radio adds:

| Net | Who | Notes |
|---|---|---|
| **Command** | Private and up | Fireteam leads talking to each other. Left ear by default |
| **Recon** | Private and up | Scouts and snipers. Right ear by default |
| **Air Support** | Private and up | Heli pilots and air support. Right ear by default |
| **Logistics / Vehicles** | Private and up | Drivers and supply runs. Right ear by default |
| **All-call** | Everyone listens; S3 and tonight's Squad Leader talk | Both ears, chirp first |

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
| `public/index.html`, `radio.js`, `radio.css`, `patch.png` | The test page |
| `SETUP.md` | One-time setup steps |
| `TEST-NIGHT.md` | Checklist for the first test with the crew |
| `desktop/` | The Windows app (Electron): `main.js` window/tray/keys/overlay/updates, `keys.js`, `preload.js`, `overlay.html`/`overlay.js`, `config.json` (the radio address) |
| `.github/workflows/desktop.yml` | Builds the installer on GitHub (Actions → Build desktop app → Run workflow). A copy to paste in is `desktop/build-workflow.yml` |
| `DESKTOP.md` | Building, installing and using the desktop app |
| `site/` | radio.dadops.gg, the radio's home page (own Vercel project). Steps: `HOME-PAGE.md` |

**Adding or changing a net:** edit the `NETS` list at the top of
`src/worker.js` (copy a line, change the key, name, short tag and
description), then commit and push. A Nets screen for S3 is planned for
phase 2.

Secrets (in Cloudflare only, never in this repo): `REALTIME_APP_ID`,
`REALTIME_APP_SECRET`, and optionally `DISCORD_BOT_TOKEN` + `DISCORD_RALLY_POINT_ID`
(shows each person's Discord voice channel; see SETUP.md).
