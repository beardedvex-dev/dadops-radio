# Dad Net desktop app: building and installing

The desktop app is a small Windows program around the same radio page you
already use, plus:

- **Talk keys that work while the game is in front**, keyboard or mouse
  buttons (Mouse 4/5 included)
- **The in-game overlay** in the top-left corner: who's talking on which net,
  and a tan **TX** bar while you're talking
- **The tray:** closing the window keeps the radio running (bottom right, by
  the clock). Right-click the DAD Ops patch there to quit.
- **Start with Windows** (optional) and **automatic updates**

You don't install any developer tools. GitHub builds the installer for you.

---

## One time: 4 things before the first build

### 1. Put your radio address in the app (1 min)

Open `desktop\config.json` in Notepad and replace the address with your
radio's Cloudflare address (the one you open in the browser):

```json
{
  "radioUrl": "https://dadops-radio.your-name.workers.dev"
}
```

Save it. If you leave the placeholder, the build stops and tells you.

### 2. Make the repo public (1 min)

GitHub → **DadOps-Radio** → **Settings** → scroll to the bottom (**Danger
Zone**) → **Change visibility** → **Make public** → confirm.

Why: the app updates itself from the repo's **Releases**, and members
download the installer from there. Neither works on a private repo without
building a password into the app. Making it public is safe because nothing
secret is in the repo: the App ID and App Secret live only in Cloudflare, and
the Supabase key in it is the public one dadops.gg already shows to every
visitor.

### 3. Commit and push

GitHub Desktop → the **dadops-radio** repo → commit → **Push origin**.

### 4. Add the build recipe on GitHub (2 min)

Windows wouldn't let Claude write into the hidden `.github` folder, so this
one file goes in through the GitHub website:

1. Open `desktop\build-workflow.yml` in Notepad → **Ctrl+A**, **Ctrl+C**.
2. GitHub → **DadOps-Radio** → **Add file** → **Create new file**.
3. For the name, type exactly: `.github/workflows/desktop.yml`
   (typing the `/` makes the folders as you go).
4. Paste into the big box → **Commit changes…** → **Commit changes**.
5. Back in GitHub Desktop: **Fetch origin**, then **Pull origin**, so your
   copy has it too. (Do this before your next push.)

---

## Building the installer (every new version)

1. GitHub → **DadOps-Radio** → **Actions** tab.
   (First time only: if it asks, click **I understand my workflows, go ahead
   and enable them**.)
2. Click **Build desktop app** on the left → **Run workflow** → **Run
   workflow**.
3. Wait about 5–10 minutes for the green tick.
4. Go to the repo's **Releases** (right side of the repo's main page). The new
   release has the installer (**Dad-Net-Setup-x.y.z.exe** from v0.5.0; older
   ones are called DAD-Ops-Radio-Setup).

Each build needs a new version number. Claude bumps it in
`desktop\package.json` whenever the app changes, and tells you.

## Installing

1. Download **Dad-Net-Setup-x.y.z.exe** from Releases (or radio.dadops.gg) and run it.
2. Windows will probably say **"Windows protected your PC"**, because the app
   isn't code-signed yet. Click **More info** → **Run anyway**.
3. It installs and opens. Sign in with Discord in the window that appears.
   It's the same sign-in as the website.
4. It gets on net by itself. Allow the microphone if Windows asks.

## Setting it up

- **Talk keys:** join a net, then click the small key box on that net's card
  (it shows **B** for Command to start). It says **PRESS A KEY**. Press the
  key or mouse button you want, e.g. **Mouse 5**. **Esc** cancels.
  Pick keys the game and Discord don't already use.
- **Ears and volume:** same as the browser version.
- **Overlay and Start with Windows:** the **Desktop app** box at the bottom,
  or right-click the tray icon.
- **The overlay needs the game in Borderless or Windowed mode.** Nothing
  can draw over exclusive Fullscreen. Most games call it "Borderless",
  "Windowed Fullscreen" or "Fullscreen (Windowed)".

## The field kit (from v0.4.0; Battle Board from v0.5.0)

The app is one rugged "field kit". The radio is on the left, and the
**Battle Board** folds out to the right (up to v0.4.2 this was the dadops.gg
Field PDA; the PDA now stays on the website, linked at the bottom of the board).

- **Folded:** just the radio. Click the **BATTLE BOARD ▸** tab sticking out of
  the right edge to fold the board out.
- **Unfolded:** radio + Battle Board: tonight's op and countdown, the squad
  board (fireteams, FTLs, who's where), your comms, a stopwatch, a countdown
  that beeps, and a notepad (saved on this PC). Click **◂ FOLD** on the hinge
  to fold it away.
- **F9 anywhere, even in-game:** pops the whole kit up unfolded, on top of
  the game. Press F9 again to tuck it away. The radio stays on net the whole
  time; your talk keys keep working while it's open.
- **Drag** the kit by its rim. **–** minimizes, **×** hides it to the tray
  (still on net).
- Change the F9 key in **Desktop app** (bottom of the radio, click to open)
  → **Show/hide key**. If a net was using that key, the net gives it up.
- Closed net cards stay compact. Click **▾** on a joined net to see who's on
  it and the ear/volume controls; a net with someone talking opens by itself.
- **Go off net** (on the radio, or right-click the tray icon) leaves every
  net but keeps the app and the Battle Board open. **Get back on net** puts
  you back. Restarting the app always starts on net.
- It remembers whether the board was folded out, plus its size and position.

## Moving the overlay (from v0.5.0)

Open **Desktop app** at the bottom of the radio:
- **Overlay spot:** pick a corner (top/bottom, left/right). The rows grow
  away from the edge it sits on.
- **Move it:** the overlay gets a tan bar that says DRAG ME. Drag it anywhere
  (over the game is fine), then click **Done** on the overlay or **Done
  moving** in the radio. The spot changes to "Where I dragged it". Also in
  the tray menu: **Move the overlay**.
- **Size:** 70% to 160%. **See-through:** 0% to 60%.
All of it is remembered.

## Updating

The app checks for updates when it starts and every 6 hours. When a new
version has downloaded, the **Desktop app** box shows **Update ready** with a
**Restart now** button (also in the tray menu). Or just quit and reopen; it
updates on the way out.

## Trying it in-game

Quickest test on your own:
1. Open the app on your PC and the browser version on your phone, both signed
   in as you, and join Recon on both (Command needs an FTL seat or Sergeant+).
2. Set Recon to Mouse 5 in the app.
3. Start WARDOGS in borderless, hold Mouse 5 and talk: your phone plays it,
   and the overlay shows **TX · RECON** while you hold it.
4. Talk on your phone: the overlay shows you talking on **RCN**.

## If something's off

| What you see | What to do |
|---|---|
| The build fails at "Check the radio address" | Step 1 above |
| The build fails somewhere else | Open the failed run, click the red step, copy the last 20 lines to Claude |
| Talk keys don't work in-game | Make sure the game isn't running as administrator (or right-click the app → Run as administrator once to test). Windows doesn't pass keys from an admin game to a normal app |
| The overlay doesn't show | The game is in exclusive Fullscreen. Switch it to Borderless. Also check the overlay box is ticked |
| Antivirus warns about the app | New, unsigned apps that listen for keys sometimes get flagged. It's the talk-key feature. Code signing (later) fixes this |
| "Update ready" shows | Click **Restart now**, or just quit and reopen; it installs on the way out |

**Anti-cheat:** the app doesn't touch the game. The overlay is its own
see-through window on top (like Discord's), and the talk keys use the same
standard Windows key listener Discord and OBS use.
