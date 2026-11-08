# Vortex Video Scraping and Downloading Application

A complete, production-grade automated media scraping, stream sniffing, and video downloading engine powered by **Scrapling**, **yt-dlp**, and **FFmpeg**, featuring a modern React/Express web console, CLI interface, and direct **Telegram Bot** channel integration.

---

## 1. Key Capabilities

- **Whole-Website & Deep Catalog Crawling**:
  - Automatically crawls entire website index pages, video galleries, channel feeds, and playlists using Scrapling's adaptive DOM and link discovery.
  - Recursively finds all internal video watch links (`/watch`, `/video/`, `/v/`, `/play/`, `/clip/`, `/post/`, `/movie/`, etc.) and extracts playable media streams from all subpages concurrently.
  - No need to click into individual videos manually—just provide the website homepage or gallery link!
- **Automated Nonstop Sequential Downloader**:
  - One-click **Download All Nonstop** pipeline.
  - Automatically downloads discovered videos one by one without stopping.
  - Automatically merges video+audio with FFmpeg into standardized MP4 containers.
  - Forwards each completed video directly to your Telegram channel in real time!
- **Universal Media Detection**:
  - Direct MP4, WebM, HLS (`.m3u8` master and playlists), and MPEG-DASH (`.mpd`).
  - HTML5 `<video>`, `<source>`, JSON-LD `VideoObject`, and embedded players.
- **Dedicated "Test Website" Capability**:
  - Single-click inspection button to verify if a website can be crawled and its media streams detected.
  - Dispatches automated **Test Successful** notification to both the web UI and configured Telegram channel.
- **Telegram Bot Integration & High-Capacity Large File Uploads**:
  - Supports `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, and `TELEGRAM_THREAD_ID`.
  - **Large File Support (> 50MB up to 2 GB)**:
    - **MTProto 2GB Upload Mode**: Utilizing Telethon MTProto client, uploads single files up to 2,000 MB (2 GB) directly to channels.
    - **Automated Lossless Multi-Part Mode**: When using standard Bot API tokens without MTProto credentials, videos exceeding 50 MB (e.g. 295 MB) are automatically and losslessly stream-split with FFmpeg into sequential parts (< 45 MB each) and uploaded part-by-part with full playback support.
- **Instant Termination & Safe File Controls**:
  - **Halt All Operations Button**: Instantly terminates active nonstop downloads, kills child Python/FFmpeg/yt-dlp processes, clears the queue, and removes temporary buffers in real time.
  - **Safe In-App Deletion**: Inline two-step confirmation prevents iframe/browser popup blocks and allows safe, immediate deletion of video files, jobs, and JSON reports.
- **Dual Interface**: Full interactive Web Dashboard + Command-Line Interface (`python3 -m engine.cli`).

---

## 2. Prerequisites & Installation

### Linux / Ubuntu / Debian:

1. **System Packages**:
   ```bash
   sudo apt-get update
   sudo apt-get install -y python3 python3-pip ffmpeg nodejs npm
   ```

2. **Python Dependencies**:
   ```bash
   pip install yt-dlp "scrapling[all]" requests python-dotenv aiohttp curl_cffi browserforge patchright
   python3 -m patchright install chromium
   ```

3. **Node.js Web Applet Dependencies**:
   ```bash
   npm install
   ```

---

## 3. How to Run the Application

### Option A: Interactive Web Console (Recommended)

Start the full-stack server (runs Express backend + Vite client on port 3000):

```bash
npm run dev
```

Open your browser at `http://localhost:3000`.

#### Features in Web UI:
- **Scraper Console**:
  - Paste single or multiple URLs into the textarea.
  - Click **Test Website** to run deep media inspection and dispatch verification alerts.
  - Click **Start Scraping** to extract full resolution and format tables.
  - Select desired resolution (1080p, 720p, 480p, Adaptive) and click **Download MP4**.
  - Use **Bulk Download Selected** for batch operations.
- **Media Queue**:
  - Track real-time download percentage, speed in MB/s, ETA, and FFmpeg remuxing steps.
- **Downloads & Files**:
  - Browse downloaded MP4 files.
  - In-browser HTML5 video player modal with seek controls.
  - Click **Telegram** to dispatch any downloaded video directly to your channel.
  - Click **Report** to inspect the structured JSON report with codecs and timestamps.
- **Telegram Hub**:
  - Enter your Bot Token and Channel ID / Chat ID.
  - Toggle automatic uploads on completion.
  - Click **Verify & Send Test Message** for immediate status checks.
- **Engine Logs**:
  - Live streaming log output for diagnostics.

---

### Option B: Command-Line Interface (CLI)

The Python engine can also be executed completely standalone via `engine.cli`:

#### 1. Test a Website & Media Detection:
```bash
python3 -m engine.cli test "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8"
```
With Telegram notification:
```bash
python3 -m engine.cli test "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8" --token "YOUR_BOT_TOKEN" --chat-id "@YOUR_CHANNEL"
```

#### 2. Batch Scrape Multiple URLs:
```bash
python3 -m engine.cli scrape "https://site1.com/video" "https://site2.com/player" --json
```

#### 3. Download and Remux to MP4:
```bash
python3 -m engine.cli download "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8" --title "big_buck_trailer"
```

#### 4. Test Telegram Bot Connectivity:
```bash
python3 -m engine.cli telegram-test --token "YOUR_BOT_TOKEN" --chat-id "@YOUR_CHANNEL"
```

---

## 4. Telegram Bot Configuration Guide

1. **Obtain Bot Token**:
   - Message `@BotFather` on Telegram.
   - Send `/newbot`, choose a name and username.
   - Copy the HTTP API token provided.

2. **Configure Channel Permissions**:
   - Create or open your target channel.
   - Go to Channel Settings -> Administrators -> Add Administrator.
   - Search for your bot username and add it.
   - Enable the **Post Messages** permission.

3. **Find your Channel ID**:
   - For public channels: use `@your_channel_name`.
   - For private channels: forward a message from the channel to `@userinfobot` or use the numeric ID (e.g. `-100...`).

4. **Add to Application**:
   - Paste your credentials into the **Telegram Hub** tab in the web console, or configure them in your `.env` file:
     ```env
     TELEGRAM_BOT_TOKEN="123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ"
     TELEGRAM_CHAT_ID="@my_channel_username"
     TELEGRAM_API_ID="1234567"
     TELEGRAM_API_HASH="0123456789abcdef0123456789abcdef"
     TELEGRAM_THREAD_ID=""
     AUTO_UPLOAD_TELEGRAM="true"
     ```

---

## 5. Output Organization

- **MP4 Videos**: Saved to `./downloads/{sanitized_title}_{timestamp}.mp4`.
- **JSON Reports**: Saved to `./reports/{job_id}.json` with source URLs, duration, file size, format metadata, and Telegram upload status.
- **Runtime Logs**: Recorded to `./logs/` and displayed in the real-time Diagnostics console.

---

## 6. Storage Efficiency & 2-Link Retention Policy

- **Clean Scraper Console**: Inspecting or scraping a new target URL automatically removes previous links' video results from the console display, ensuring you only see results for the currently targeted site.
- **Automated 2-Link Storage Retention**: To guarantee maximum disk storage efficiency, the system keeps downloaded videos and database reports strictly for the **2 most recent separate links**.
- **Automatic Purging**: After parsing two separate links, parsing a new link will automatically identify older links beyond the 2 most recent, completely deleting their downloaded video files from `./downloads/`, JSON reports from `./reports/`, and job logs from disk.
