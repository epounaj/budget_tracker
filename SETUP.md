# Site Ledger — setup guide

A single-file, local-first construction tracker. Your data lives on your own phone/computer (in the browser's IndexedDB) and can be exported to CSV or synced to your Google Drive. AI receipt scanning uses your own API key for Qwen, DeepSeek, or OpenAI.

Everything is in one file: `index.html`. No install, no build step, no server code.

---

## Quick start (works everywhere)

1. Put `index.html` on your phone or computer and open it in a browser.
2. Tap the gear icon (top right) → paste your AI API key → Save.
3. Start adding funds, budget, sellers and purchases.
4. To back up: Settings → Export CSV. To restore: Settings → Import CSV.

That's the whole app. The two features below (camera in some browsers, and Google Drive sync) need the file to be *served* rather than opened directly — see "Why localhost" below.

---

## What works from a plain file (file://)

- All tracking: funds, budget, actions, sellers, purchases
- AI receipt scanning (needs only your API key)
- Manual CSV export and import
- Thumbnails stored on-device

## What needs https or localhost (a "secure context")

- Automatic Google Drive sync (CSV backup + full receipt photos)
- Camera capture in some mobile browsers (many still allow it from file://, but not all)

The app detects this automatically: on an insecure context it hides Drive sync and shows manual CSV instead, so you're never stuck.

---

## Why localhost, and three ways to get it

A "secure context" means the page is served over `https://` or from `localhost`. Pick whichever suits you:

**A. Host the single file (easiest for a phone).** Drop `index.html` onto any static host — Netlify Drop (drag-and-drop, no account needed), GitHub Pages, or Cloudflare Pages. You get an `https://` link you can open and "Add to Home Screen".

**B. Serve locally on a computer.** In the folder with `index.html`, run one command, then open the address it prints:
- Python: `python3 -m http.server 8000` → open `http://localhost:8000`
- Node: `npx serve` → open the address shown

**C. Serve locally on Android (no PC).** Install Termux, then `pkg install python`, `cd` to the folder, and `python3 -m http.server 8000`. Open `http://localhost:8000` in your phone browser.

Add to Home Screen from the browser menu to get an app icon and full-screen behaviour.

---

## AI receipt scanning

In Settings, choose your provider and paste the matching API key:

- **OpenAI** — default model `gpt-4o` (vision-capable).
- **Qwen-VL** — Alibaba DashScope, default `qwen-vl-max`. The app uses the international OpenAI-compatible endpoint. If you're on the China mainland endpoint, change the URL note below.
- **DeepSeek** — default `deepseek-chat`. Note: confirm your DeepSeek account has a vision-capable model enabled; if not, OCR will error and you can enter details by hand.

You can override the model name in Settings if you want a specific one.

On a purchase, tap **Scan receipt with AI** → take/choose the photo → the app sends it to your provider, asks for structured JSON (seller, date, total, item, category, receipt no.), and pre-fills the form. **Always double-check the amount before saving** — OCR can misread.

### Key safety
The key is stored only on your device. But because the app calls the API straight from the browser, anyone who can read the file could read the key. That's fine for your own phone. Don't share the file with a key saved in it. If you ever want to share the app, route the API calls through a tiny proxy that holds the key server-side.

---

## Google Drive sync (optional)

One-time setup, because Google requires it:

1. Go to Google Cloud Console → create a project.
2. APIs & Services → enable the **Google Drive API**.
3. Configure the OAuth consent screen (External; add yourself as a test user).
4. Create credentials → **OAuth client ID** → type **Web application**.
5. Under "Authorised JavaScript origins", add the exact origin you serve from (e.g. `https://your-site.netlify.app` or `http://localhost:8000`).
6. Copy the Client ID (ends in `.apps.googleusercontent.com`).
7. In the app: Settings → paste the Client ID → Save → **Connect Google Drive** → approve.

Once connected:
- Saving a purchase with a photo uploads the full-resolution image to a **Site Ledger** folder in your Drive; only a small thumbnail stays on your phone.
- Your data is backed up as **site-ledger.csv** in that folder (also updates as you go). "Sync now" forces an immediate push.

The app requests the `drive.file` scope, meaning it can only see the files it creates — not the rest of your Drive.

---

## Data & backup notes

- Working data lives in the browser's IndexedDB for the site you serve from. Clearing that browser's site data will erase it — so keep CSV backups or use Drive sync.
- CSV is the portable source of truth: export any time, re-import to restore or move to another device.
- CSV import **replaces** all current data (it asks first).
- Receipt photos are not embedded in the CSV (they'd bloat it); full photos go to Drive, thumbnails stay local, and the CSV keeps the Drive link.

---

## Roadmap ideas (say the word)

- PWA offline caching (service worker) so it opens with no connection
- Merge-on-import instead of replace
- Charts: spend over time, budget burn-down, funds vs. spend
- Pull the CSV back *from* Drive on another device (two-way sync)
- A tiny key-proxy so the app can be safely shared
