# DAD Ops Radio: setting up the browser test

About 20–30 minutes, once. After this, every push in GitHub Desktop updates
the radio by itself, the same way Vercel does for the website.

Nothing here touches the dadops.gg website code or database. The radio only
**reads** from dadops.gg (your sign-in, rank and tonight's op).

---

## 1. Cloudflare account (5 min)

1. Go to **dash.cloudflare.com** and sign up for a free account. Use your
   DAD Ops or personal email, **not** your work email.
2. Confirm your email when Cloudflare sends the link.

## 2. Make the voice relay (3 min)

1. In the Cloudflare dashboard, open **Realtime** in the left menu, then
   **SFU**. (If you can't find it, type "Realtime" in the search box at the
   top.)
2. Click **Create** (it may say *Create application*). Name it
   `dadops-radio`.
3. Cloudflare shows two values: the **App ID** and the **App Secret**.
   Keep this page open. You'll paste both in step 5.

The **App Secret is a password.** Don't post it in Discord or send it to
Claude. If it ever leaks, make a new one on this same page and repeat step 5.

> Cloudflare may ask you to add a payment card before Realtime works, even
> though DAD Ops stays inside the free allowance (1,000 GB a month; a
> night of push-to-talk uses a tiny fraction of a GB). That's normal.

## 3. Put the code on GitHub (5 min)

The code is in `C:\dev\forwardoperatingbar\dadops-radio`.

1. Open **GitHub Desktop** → **File** → **Add local repository…**
2. Choose `C:\dev\forwardoperatingbar\dadops-radio`.
3. It says "This directory does not appear to be a Git repository". Click
   **create a repository** in that message, keep the name `dadops-radio`,
   and click **Create repository**.
4. Click **Publish repository**. Name: `DadOps-Radio`. **Keep "Keep this code
   private" ticked.** Click **Publish repository**.

## 4. Connect Cloudflare to the repo (5 min)

1. Cloudflare dashboard → **Workers & Pages** → **Create** (or *Create
   application*).
2. Choose **Import a repository** (it may say *Connect to Git*). Sign in to
   GitHub if asked and allow access to **DadOps-Radio** only.
3. Pick **DadOps-Radio**. Leave the settings as they are:
   - Project name: `dadops-radio`
   - Build command: *(empty)*
   - Deploy command: `npx wrangler deploy`
4. Click **Deploy**. It takes a minute or two. When it's done it shows the
   address, something like `https://dadops-radio.<your-name>.workers.dev`.
   **Write that address down.**

## 5. Give the radio its two keys (2 min)

1. **Workers & Pages** → **dadops-radio** → **Settings** → **Variables and
   Secrets** → **Add**.
2. Add the first one:
   - Type: **Secret**
   - Name: `REALTIME_APP_ID`
   - Value: the **App ID** from step 2
3. Click **Add** again for the second one:
   - Type: **Secret**
   - Name: `REALTIME_APP_SECRET`
   - Value: the **App Secret** from step 2
4. Click **Deploy** (or **Save and deploy**).

The names must be spelled exactly like that, in capitals.

## 6. Let the radio use the dadops.gg sign-in (2 min)

1. **Supabase** → the DAD Ops project → **Authentication** → **URL
   Configuration**.
2. Under **Redirect URLs**, click **Add URL** and paste your address from
   step 4 with `/**` on the end, for example:
   `https://dadops-radio.your-name.workers.dev/**`
3. Click **Save**.

Leave the **Site URL** alone. It stays `https://dadops.gg`.

## 7. Try it yourself (3 min)

1. Open your radio address in Chrome or Edge.
2. **Sign in with Discord** → **Get on net** → allow the microphone.
3. You should see **On net** at the top, and Command, Air / Recon and
   All-call underneath.
4. Open the same address on your phone or a second browser and sign in as
   yourself again. Join Command on both, hold the talk button on one, and
   you should hear yourself on the other (use headphones).

### If something's off

| What you see | What to do |
|---|---|
| Sign in sends you to dadops.gg instead of back to the radio | Step 6: the address in Redirect URLs isn't exactly right, or it's missing `/**` |
| "The radio isn't finished being set up" | Step 5: one of the two secrets is missing or misspelled |
| "Couldn't connect your mic to the relay" or "The voice relay didn't answer" | Step 2/5: the App ID or App Secret is wrong. Copy both again |
| Stuck on "Reconnecting" | Cloudflare → dadops-radio → **Logs** (or *Observability*) and send Claude what it says |
| The microphone was blocked | Click the camera/mic icon in the address bar → Allow → reload |
| A member says "Finish joining DAD Ops on dadops.gg first" | They haven't finished signing up on dadops.gg, or used a different Discord account |

## Who gets what

| Who | Hears | Can talk on |
|---|---|---|
| Recruit | All-call | nothing (listen only) |
| Private and up, plus S3, S6, Quartermasters, Armorers, Scouts, Founders (the same people the Private-only pages let in) | All-call, plus Command and Air / Recon if they join them | Command, Air / Recon |
| S3, and whoever is **tonight's Squad Leader** on the ops board | same as above | All-call too |

"Tonight's Squad Leader" is whoever is set as lead on an op that started in
the last 5 hours or starts in the next 2.
