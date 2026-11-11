<div align="center">

# Vortex Video Scraper & Downloader

**Deep website crawling · Multi-source media extraction · Automated downloads · Telegram delivery**

A self-hosted web app for discovering video links across websites, extracting playable media streams, downloading videos in batches, and optionally forwarding completed files to Telegram.

[![Node.js](https://img.shields.io/badge/Node.js-22-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Python](https://img.shields.io/badge/Python-3.11%2B-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![Scrapling](https://img.shields.io/badge/Powered%20by-Scrapling-6C5CE7)](https://github.com/D4Vinci/Scrapling)
[![yt--dlp](https://img.shields.io/badge/Downloader-yt--dlp-222222)](https://github.com/yt-dlp/yt-dlp)
[![License](https://img.shields.io/badge/License-Not%20specified-lightgrey)](#)

</div>

---

## Overview

Vortex combines a React dashboard with a Python media-inspection and download engine. Enter one or more website URLs, inspect a page, crawl its video catalogue, review discovered media, and send individual or batch downloads to the queue.

The crawler uses a lightweight extraction path first. Browser-based recovery is reserved for pages where normal extraction finds no videos, helping difficult JavaScript-driven pages without adding browser overhead to every successful crawl.

## Features

### Website inspection & deep crawling
- Inspect a website before starting a full crawl.
- Accept multiple root URLs in one operation.
- Deep-crawl catalogues, category pages, galleries, channels, and linked video/watch pages.
- Discover candidate video subpages from page links and common video URL patterns.
- Batch crawling with configurable subpage limits and offset-based continuation.
- Load the next batch or crawl the remaining discovered subpages.
- Deduplicate submitted root URLs and isolate per-website failures in multi-URL crawls.
- Compact crawler and test status messages, with detailed diagnostics available separately.

### Media and stream extraction
- Detect HTML5 video and source elements.
- Inspect iframe/embed players and media references.
- Identify common direct media and streaming formats, including MP4, WebM, HLS (M3U8), and MPEG-DASH (MPD).
- Scan page markup and scripts for stream candidates.
- Use Scrapling with browser-like request headers for normal page fetching.
- Trigger browser recovery only when the normal extraction route returns zero videos.
- Handle direct media URLs as input, not just catalogue pages.
- Present discovered video details and available format choices in the scraper interface.

### Downloads & queue management
- Download a single discovered video or selected videos.
- Add all discovered videos to the Nonstop Auto-Pilot queue.
- Process nonstop batch downloads one at a time.
- Track job states, progress, speed, ETA, and completion/failure information.
- Retry failed jobs, cancel active jobs, delete queue entries, and clear finished jobs.
- Stop the nonstop queue and terminate active engine processes.
- Remux/convert media to MP4 using FFmpeg where supported.
- Keep per-job JSON progress reports for status recovery while the instance filesystem remains available.

### Restart-aware nonstop queue
- Save queue snapshots locally during normal operation.
- Re-queue the in-progress item during graceful shutdown so it can be attempted again.
- Restore pending work automatically when the server starts.
- Optional Supabase-backed queue snapshots are supported through server-side environment variables.
- Completed queue items are not intentionally re-added when the saved queue state is current.

> **Important deployment note:** Koyeb Free instances use ephemeral local storage. Local downloads, logs, reports, and local queue snapshots can disappear when an instance is replaced. For durable queue recovery across instance replacement, configure the optional Supabase integration described below. Supabase stores queue metadata only; it does not store the downloaded video files. A recovered queue also needs the Koyeb instance to be running before it can continue processing.

### Telegram integration
- Configure a Telegram bot token and destination chat/channel ID in the app.
- Test the Telegram connection.
- Send inspection/test notifications.
- Optionally auto-upload completed downloads to Telegram.
- Manually upload files from the file manager.
- Optional Telegram API ID, API hash, and topic/thread ID settings are available for supported upload workflows.
- The upload engine includes large-file handling paths, including MTProto and multipart upload support where configured and supported.

### File library & reports
- Browse downloaded video files from the dashboard.
- Preview supported videos in the built-in player.
- Download files to your device.
- Upload a selected file to Telegram.
- View associated download reports.
- Delete files and associated reports from the app.
- Refresh the file listing on demand.

### Dashboard & diagnostics
- Separate Scraper, Queue, Files, Telegram, and Logs sections.
- Live nonstop queue status with current item and completed, failed, and pending counts.
- Engine diagnostics with info, warning, and error filters.
- Copy logs for troubleshooting.
- Bounded concurrent inspection of multiple root URLs to keep crawler resource usage controlled.
- Per-URL error isolation so one failed site does not automatically discard other crawl results.
- Background crawl tasks with status polling to avoid holding a long HTTP request open for the entire crawl.
- Single active crawl protection to prevent overlapping crawl requests.
- Graceful SIGTERM/SIGINT shutdown handling with a bounded shutdown window.

## Screenshots

Screenshots can be added here as the interface evolves.

## Tech stack

| Layer | Technology |
| --- | --- |
| Frontend | React 19, TypeScript, Vite, Tailwind CSS |
| UI / motion | Lucide React, Motion |
| API server | Node.js 22, Express |
| Scraping | Python, Scrapling |
| Media extraction / downloads | yt-dlp |
| Media processing | FFmpeg |
| Optional durable queue metadata | Supabase (PostgreSQL REST API) |
| Optional delivery | Telegram Bot API / Telegram client upload support |
| Deployment | Docker |

## Project structure

```text
.
├── engine/
│   ├── runner.py              # Python task entry point
│   ├── scraper.py              # Website inspection and media crawler
│   ├── downloader.py           # Download and media processing
│   ├── telegram_notifier.py    # Telegram notifications and delivery
│   └── config.py               # Engine settings and data directories
├── src/
│   ├── components/             # Dashboard, scraper, queue, files, Telegram, logs
│   ├── App.tsx                 # Main application and API integration
│   └── ...
├── downloads/                  # Downloaded media (runtime-generated)
├── reports/                    # Download reports (runtime-generated)
├── logs/                       # Logs, job state, queue checkpoint (runtime-generated)
├── server.ts                   # Express API and process/queue orchestration
├── requirements.txt            # Python dependencies
├── package.json                # Node dependencies and scripts
├── Dockerfile                  # Production container
└── supabase-queue-schema.sql   # Optional durable queue table schema
```

## Run locally

### Requirements

- Node.js 22 or newer
- Python 3.11 or newer
- FFmpeg
- Git

### 1. Clone the repository

```bash
git clone https://github.com/RadiuxSource/Scrapling.git
cd Scrapling
```

### 2. Install Node dependencies

```bash
npm install
```

### 3. Create a Python virtual environment

**Linux / macOS**
```bash
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
pip install --upgrade "scrapling[fetchers]"
scrapling install
```

**Windows PowerShell**
```powershell
py -3 -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
pip install --upgrade "scrapling[fetchers]"
scrapling install
```

Make sure the Python executable used by the server can import Scrapling and yt-dlp. The production Docker image installs Python dependencies and FFmpeg automatically.

### 4. Start the development server

```bash
npm run dev
```

Open the local URL printed by the server.

### 5. Production build

```bash
npm run build
npm start
```

Type-check the TypeScript project with:

```bash
npm run lint
```

## Configuration

Most application settings, including Telegram credentials, can be configured from the dashboard and saved by the app. Keep secrets out of source control.

### Optional Supabase queue persistence

Supabase is optional for local development. It is recommended when deploying on an ephemeral filesystem and you want the nonstop queue snapshot to survive instance replacement.

1. Create a Supabase project.
2. Open the Supabase **SQL Editor**.
3. Run the complete contents of [supabase-queue-schema.sql](./supabase-queue-schema.sql).
4. In your deployment's environment-variable settings, add:

| Variable | Value |
| --- | --- |
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Your project's service-role key |

5. Redeploy the application and check the server logs for the message confirming that the queue snapshot was loaded from Supabase.

**Security:** The service-role key is a server-only secret. Never put it in a `VITE_*` variable, frontend code, public repository, screenshot, or browser request. Do not share it in issues or chat.

Supabase stores the queue state and pending item metadata, not downloaded video files, browser sessions, logs, or reports. Keep the Supabase project active and within its free-plan limits. If Supabase is not configured or temporarily unavailable, the app can fall back to its local checkpoint, but that fallback cannot survive replacement of an ephemeral instance.

### Telegram setup

1. Create a bot using Telegram's official `@BotFather`.
2. Add the bot to your destination chat or channel and grant it permission to post.
3. In the Telegram section of Vortex, enter the bot token and destination chat/channel ID.
4. Use **Test Connection** to verify the configuration.
5. Enable automatic upload if you want completed downloads forwarded automatically.

Optional Telegram API ID/hash and topic/thread ID fields are available for supported client-upload and topic workflows.

## Deployment with Docker

The repository includes a production Dockerfile that:
- Uses Node.js 22 on Debian Bookworm Slim.
- Installs Python, FFmpeg, process utilities, CA certificates, and the `libatomic1` runtime dependency.
- Installs Node and Python requirements.
- Installs Scrapling browser dependencies.
- Builds the Vite frontend and Express server.
- Starts the production server on the configured `PORT` (default 3000).

Build and run locally:

```bash
docker build -t vortex-video-scraper .
docker run --rm -p 3000:3000 -e PORT=3000 vortex-video-scraper
```

For Koyeb or another container host, deploy from this repository using the Dockerfile and configure the service to expose the application port. Add optional Supabase credentials as server-side environment variables if durable queue metadata is required.

### Free-instance considerations

- Free compute may stop, sleep, or be replaced according to the hosting provider's policies.
- Queue metadata can be restored from Supabase after the app starts, but the app cannot download while its compute instance is stopped.
- Files written to the container's local `downloads/`, `reports/`, and `logs/` directories are not durable on an ephemeral instance.
- Supabase queue backup does not preserve partially downloaded bytes. An interrupted item is retried from its source URL after restart.
- Long-running downloads may be interrupted by platform shutdown; graceful shutdown attempts to checkpoint the queue, while durable recovery depends on the latest successful Supabase write.

## API overview

The Express server exposes the application API, including:

| Endpoint | Purpose |
| --- | --- |
| `POST /api/test-website` | Inspect a website and return a test report |
| `POST /api/scrape` | Start a background crawl task |
| `GET /api/scrape/status/:id` | Poll a crawl task |
| `POST /api/download` | Start an individual download |
| `POST /api/download-all-nonstop` | Add videos to the nonstop queue |
| `GET /api/nonstop-queue/status` | Read nonstop queue status |
| `POST /api/nonstop-queue/stop` | Stop the nonstop queue |
| `GET /api/jobs` | List download jobs |
| `POST /api/jobs/cancel/:id` | Cancel a job |
| `GET /api/downloads` | List downloaded files |
| `GET /api/reports` | List download reports |

The API is intended to be used by the Vortex frontend. Authentication and public multi-user access controls should be added before exposing it as a shared public service.

## Troubleshooting

**Supabase reports "Invalid Supabase URL"**
- In Koyeb, set `SUPABASE_URL` to the Supabase **Project URL**, normally `https://<project-ref>.supabase.co`.
- Find it in Supabase → **Project Settings** → **API** → **Project URL**.
- Do not use the generic dashboard URL `https://supabase.com/dashboard`. The server also recognizes a project dashboard URL such as `https://supabase.com/dashboard/project/<project-ref>` and converts it to the matching project API hostname.
- A URL ending in `/rest/v1` is also accepted; the server normalizes it before making REST requests.
- Keep `SUPABASE_SERVICE_ROLE_KEY` from the same project. The URL and key must belong to the same Supabase project.
- After changing Koyeb environment variables, save and redeploy the service.

**Supabase reports a REST API path error (PGRST125 / HTTP 404)**
- Verify that `SUPABASE_URL` is the project URL, not a table URL, SQL Editor URL, or unrelated dashboard page.
- Confirm the `vortex_queue_state` table exists in that same project and that `supabase-queue-schema.sql` ran successfully.

**The app starts but downloads stop after an instance restart**
- Check that both Supabase environment variables are configured correctly.
- Confirm that `supabase-queue-schema.sql` was executed successfully.
- Check server logs for Supabase backup/restore errors.
- Remember that restored queue entries need the source URLs to remain accessible.

**Supabase reports a missing table**
- Run `supabase-queue-schema.sql` in the correct Supabase project.
- Confirm that `SUPABASE_URL` points to that same project.

**Scrapling browser installation fails during Docker build**
- Confirm that the Dockerfile system dependencies are installed.
- The image includes `libatomic1`, required by the Playwright browser runtime in affected environments.

**A crawl takes a long time or returns no videos**
- Try **Test Website** first.
- Start with a smaller subpage batch, then use the next-batch controls.
- Review the Logs section for per-page fetch and extraction errors.
- Some websites require authentication, block automated traffic, or load media through unsupported player logic; extraction cannot be guaranteed for every site.

**Telegram upload fails**
- Verify the bot token and destination ID.
- Ensure the bot is a member/admin where required.
- Check optional client API credentials if using a client-based upload route.
- Review the Logs section for the underlying Telegram response.

## Fix log

### 11/11 — Per-browser workspace isolation
- Added signed, persistent browser workspace identity so each browser session can keep its own jobs, crawl state, queue, logs, downloads, settings, and Telegram configuration separate.
- Workspace files are stored under `data/workspaces/`; keep `WORKSPACE_SECRET` stable across deployments so existing workspace cookies remain valid.
- Added environment-based `WORKSPACE_SECRET` and one-time `WORKSPACE_MIGRATION_TOKEN` configuration. Do not commit either secret; configure them in the deployment environment.
- Added a protected legacy-workspace claim flow to migrate the existing single-workspace data into the owner's workspace without deleting the original legacy files.
- Queue snapshots use workspace-specific Supabase row IDs. Apply the updated `supabase-queue-schema.sql` before enabling multi-workspace queue persistence.
- Per-workspace Python runner paths are supplied through environment variables so crawler extraction modules retain their existing behavior.
- Deployment note: Supabase stores queue metadata, not downloaded media. Use persistent storage for files that must survive instance replacement; an interrupted active item is requeued, not guaranteed to resume from an exact byte offset.
- This feature needs deployment-level verification with multiple browsers and a real Koyeb restart before it can be called production-verified.


### 11/11 — Queue restore timeout and notification visibility
- Added a 12-second timeout to the Supabase queue restore request so a stalled network request cannot leave the recovery indicator spinning indefinitely.
- Kept restore status available to the dashboard for up to 45 seconds after success or cancellation, instead of clearing it on the first status poll.
- Kept cancellation distinct from timeout: a user-cancelled restore reports cancellation, while an expired request reports a timeout error and can fall back to the local queue checkpoint.
- This change improves restore feedback; verify recovery against the configured Supabase project after redeployment.


### 10/11 — Supabase URL validation still rejecting a valid Project URL
- Hardened `SUPABASE_URL` parsing to accept the canonical `https://<project-ref>.supabase.co` origin, an optional trailing slash, and the `/rest/v1` REST endpoint.
- The parser now explicitly validates the Supabase project hostname and rejects unexpected path segments, rather than treating the normal root slash as an invalid path.
- Strips accidental surrounding single or double quotes from the environment value, a common copy/paste issue in deployment dashboards.
- Keeps dashboard project URL conversion support and normalizes accepted values to the project origin before making REST requests.
- For Koyeb, set `SUPABASE_URL=https://<project-ref>.supabase.co` (without quotes); ensure `SUPABASE_SERVICE_ROLE_KEY` is from the same Supabase project, then trigger a fresh deployment so the new server build is used.
- This fix validates URL formatting only; it does not verify the API key, table existence, or network connectivity.



### 10/11 — Supabase queue restore URL and API-path errors
- Fixed Supabase URL normalization used by durable nonstop-queue restore and backup.
- The server now accepts the standard Supabase Project URL (`https://<project-ref>.supabase.co`), a Project URL with a trailing `/rest/v1`, and the Supabase project dashboard URL (`https://supabase.com/dashboard/project/<project-ref>`), converting the dashboard form to the matching project API hostname.
- Added clearer validation guidance when an unrelated dashboard path or malformed URL is supplied.
- Documented that `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` must come from the same Supabase project.
- Added troubleshooting steps for `PGRST125` / HTTP 404 invalid REST paths.
- The earlier queue restore UI includes a cancellable “Restoring queue…” notice and a temporary success confirmation. End-to-end restore still needs to be verified against the configured Supabase project after redeployment.

## Responsible use

Use Vortex only with websites and media you are authorized to access, download, and redistribute. Respect copyright, site terms, privacy, and applicable laws. Do not use the software to bypass access controls or download content without permission.

## Contributing

Bug reports and focused improvements are welcome. When reporting an issue, include:
- The action you performed (test, crawl, single download, batch download, or Telegram upload).
- A sanitized URL and relevant error message.
- Relevant log lines with tokens, cookies, private URLs, and personal data removed.
- Your deployment type and runtime versions.

Keep credentials and private environment files out of commits.

---

<div align="center">

**Vortex Video Scraper & Downloader**

Built to inspect deeper, extract smarter, and keep batch workflows moving.

</div>
