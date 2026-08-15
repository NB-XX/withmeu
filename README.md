# withMeu

A minimal web viewer for [withFan](https://withfan.co) artist messages — browse subscribed artists' timelines, view images in a gallery, play voice messages, and read translations, all in a clean flat-design interface.

## Features

- **5-artist timeline** — switch between ZHAN, IVI, SUA, RITZ, CHOEUN with large avatars
- **Image gallery** — Instagram-style grid view for image messages, fullscreen viewer with prev/next navigation
- **Voice player** — custom minimal audio player for voice messages (click-to-seek progress bar)
- **Auto-translation** — Korean → Simplified Chinese via withFan's built-in translation API
- **Date filter** — pick a date range or quick-jump to Today / Voice-only / All
- **Full-text search** — search across original text and translations
- **SQLite storage** — all messages and translations persisted locally, instant loading after first sync
- **Auto-refresh** — polls for new messages every 10 minutes in the background

## Architecture

```
withmeu/
├── server.js          # Node.js HTTP server (proxy + SQLite)
├── worker.js          # Cloudflare Worker (API proxy + D1 + cron)
├── schema.sql         # D1 schema (applied via wrangler d1 execute)
├── wrangler.toml      # Cloudflare config
├── data.db            # SQLite database (messages, translations, profiles) — created on first run
├── public/
│   └── index.html     # Single-page frontend
├── config.example.json # Auth config template
└── package.json
```

- **Backend**: Node.js + better-sqlite3. Proxies withFan API calls, caches all data in SQLite, returns cached results instantly while syncing new messages in the background.
- **Frontend**: Vanilla HTML/CSS/JS. Flat minimal design, no frameworks, event-delegated custom player controls.

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- A withFan account with an API access token (your withFan JWT)

### Install & Run

```bash
npm install
node server.js
```

Open **http://localhost:3456** in your browser.

### Configure Auth

The app reads its withFan authorization token from `config.json` at runtime (no token is hardcoded in `server.js`). To set yours up:

1. Copy `config.example.json` to `config.json`.
2. Open `config.json` and fill in your withFan JWT (and refresh token, if you have one).
3. Restart the server.

`config.json` is gitignored and must never be committed. You can also override the token per-session from the **⚙ Settings** panel (press `,`) — the value you paste there is stored in your browser's `localStorage` and sent to the server with each request.

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `1`–`5` | Switch artist |
| `/` | Focus search |
| `F` | Toggle date filter panel |
| `G` | Toggle image gallery |
| `R` | Force refresh |
| `,` | Open settings |
| `Esc` | Close overlay / settings |

## Database

Messages and translations are stored in `data.db` (SQLite, WAL mode). The database is **not** bundled — no historical data ships with the repo. On first run, `server.js` creates an empty `data.db` (via its inline `CREATE TABLE IF NOT EXISTS` statements) and starts fetching fresh messages from withFan. For the Cloudflare deployment, initialize D1 from `schema.sql` (see Deploy below).

## Deploy to Cloudflare

### Architecture

```
┌─ Cloudflare Pages ──────────┐     ┌─ Cloudflare Worker ──────┐
│  index.html  (static)       │────▶│  /api/*  (API proxy)     │
└─────────────────────────────┘     │  D1     (database)       │
                                    │  Cron   (every 10 min)   │
                                    └──────────────────────────┘
```

### Steps

1. **Create D1 database**

   ```bash
   npx wrangler d1 create withmeu-db
   # Copy the returned database_id into wrangler.toml → [[d1_databases]].database_id
   ```

2. **Apply schema**

   ```bash
   npx wrangler d1 execute withmeu-db --file=schema.sql
   ```

3. **Migrate local data** (optional — seeds D1 with existing messages)

   ```bash
   npx wrangler d1 execute withmeu-db --command="..." # run INSERTs from local DB
   ```

4. **Deploy Worker**

   ```bash
   npx wrangler deploy
   # Note the worker URL: https://withmeu.<subdomain>.workers.dev
   ```

5. **Update API base in `public/index.html`**

   Replace `YOUR_SUBDOMAIN` with your actual worker subdomain:

   ```js
   var API_BASE = location.hostname === "localhost" ? "" : "https://withmeu.YOUR_SUBDOMAIN.workers.dev";
   ```

6. **Deploy Pages**

   ```bash
   npx wrangler pages deploy public/
   ```

7. **Verify**

   Open the Pages URL → should show the timeline with data from D1.
   New messages sync automatically every 10 minutes via Cron trigger.

## License

MIT
