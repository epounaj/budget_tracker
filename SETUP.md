# Site Ledger — setup guide

A single-file construction tracker. You **sign in with Google**. Your ledger backup and AI API keys are stored in **your** Google Drive (`Site Ledger` folder), not in this website or GitHub.

Everything is in one file: `index.html`. Serve it over **https** or **localhost** (Google login will not work from `file://`).

---

## Quick start (hosted)

1. Put `index.html` on GitHub Pages (or any static host).
2. Create a Google OAuth **Web** client (steps below) and add this site as an authorised origin.
3. Open the site → **Continue with Google** (paste the Client ID the first time if asked).
4. Settings → paste your AI API key → Save. It is written to `site-ledger-settings.json` in your Drive.
5. Add funds, budget, sellers and purchases as usual.

On another phone: sign in with the **same Google account**. Keys and CSV load from Drive.

---

## Google OAuth (required)

1. [Google Cloud Console](https://console.cloud.google.com/) → create a project.
2. APIs & Services → enable **Google Drive API**.
3. OAuth consent screen: External; add yourself as a test user. Scopes used: email, profile, `drive.file`.
4. Credentials → **OAuth client ID** → type **Web application**.
5. **Authorised JavaScript origins** — add the exact origin, for example:
   - `https://epounaj.github.io`
   - `http://localhost:8000`
6. Copy the Client ID (`….apps.googleusercontent.com`).
7. First visit: paste it on the login screen. Optional: put it in `index.html` as `const GOOGLE_CLIENT_ID='…';` so other devices skip that step.

The Client ID is public (not a secret). Do **not** put an API key in the HTML.

### GitHub Pages

Repo → Settings → Pages → Deploy from branch → `main` / `/ (root)`.  
URL: `https://epounaj.github.io/budget_tracker/`

Add `https://epounaj.github.io` as an authorised origin.

---

## What is stored where

| Item | Where |
| --- | --- |
| AI API key, provider, model, custom API URL | Your Drive: `Site Ledger/site-ledger-settings.json` |
| Ledger CSV | Your Drive: `Site Ledger/site-ledger.csv` |
| Full receipt photos | Your Drive: `Site Ledger/` |
| Working copy on this phone | Browser IndexedDB for this site |

Sign out clears the key from this browser. It stays in your Drive until you sign in again.

The app only asks for `drive.file`: it can see files **it** created, not the rest of your Drive.

Anyone with a Google account can open the public GitHub Pages URL and sign in to **their** empty copy. They cannot see your Drive files.

---

## AI receipt scanning

Settings → choose provider → paste key → Save (writes to your Drive profile):

- **OpenAI** — default `gpt-4o` if you leave Model on Default
- **Qwen-VL** — default `qwen-vl-max`
- **DeepSeek** — pick a vision-capable model from the list if `deepseek-chat` fails
- **Custom (OpenAI-compatible)** — your own base URL + key. Tap **Load** to browse `/v1/models` (Groq, OpenRouter, Ollama, LM Studio, vLLM, etc.). The model must support vision (`image_url`) for receipt scanning.

If the API cannot list models (CORS or no `/v1/models` route), choose **Other…** and type the model name.

Scan still runs from the browser to the provider. Double-check amounts before saving.

---

## Local serve (for testing)

In the folder with `index.html`:

- Python: `python3 -m http.server 8000` → `http://localhost:8000`
- Node: `npx serve`

Add `http://localhost:8000` as an authorised origin.

---

## Manual CSV

Settings still has Export / Import. Import **replaces** all current data (it asks first).
