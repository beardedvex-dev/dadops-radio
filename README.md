# DAD Ops Radio

Extra voice nets on top of Discord, so fireteam leads can reach each other
without swapping channels. Fireteams keep talking in their Discord channels
as normal. The radio adds:

| Net | Who | Notes |
|---|---|---|
| **Command** | Private and up | Fireteam leads talking to each other. Left ear by default |
| **Air / Recon** | Private and up | Pilots and recon who split off. Right ear by default |
| **All-call** | Everyone listens; S3 and tonight's Squad Leader talk | Both ears, chirp first |

**Status:** phase 1, the **browser test**. The desktop app (talk keys that
work while the game has focus, plus the overlay) is phase 2.

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

Secrets (in Cloudflare only, never in this repo): `REALTIME_APP_ID`,
`REALTIME_APP_SECRET`.
