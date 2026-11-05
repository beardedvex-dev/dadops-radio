# radio.dadops.gg: the radio's home page

The page lives in the `site/` folder of this repo: `index.html` plus a few
images. It's its own small Vercel project, so it never touches the dadops.gg
website. The **Download for Windows** button always points at the newest
installer on GitHub Releases by itself, so new versions need no page change.

## Put it live (about 10 minutes, once)

### 1. Make a Vercel project from this repo
1. **vercel.com** → **Add New…** → **Project**.
2. Find **DadOps-Radio** in the list → **Import**. (If it isn't listed, click
   **Adjust GitHub App Permissions** and allow DadOps-Radio.)
3. On the settings screen:
   - **Project Name:** `dadops-radio-home`
   - **Framework Preset:** **Other**
   - **Root Directory:** click **Edit** → pick **site** → **Continue**
   - Leave Build and Output settings empty.
4. **Deploy**. In a minute you get a test address like
   `dadops-radio-home.vercel.app`. Open it and check the page.

### 2. Give it radio.dadops.gg
1. In the new project → **Settings** → **Domains** → type `radio.dadops.gg` → **Add**.
2. Vercel tells you what it needs:
   - **If it just shows a green tick / "Valid Configuration":** done. (That
     happens when dadops.gg's DNS is already managed by Vercel.)
   - **If it asks for a CNAME record:** go to wherever dadops.gg's DNS lives
     (Namecheap → Domain List → dadops.gg → **Advanced DNS**) → **Add New
     Record** → Type **CNAME**, Host **radio**, Value the one Vercel shows
     (usually `cname.vercel-dns.com`) → save. It can take a few minutes to an
     hour to go green.
3. Open **https://radio.dadops.gg**.

Leave the dadops.gg website project alone: this is a separate project and
only adds the `radio` subdomain.

## After that
Every push to the radio repo also updates this page (Vercel watches the repo
like Cloudflare does). Editing the page = editing `site/index.html`.
