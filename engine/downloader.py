import os
import re
import sys
import json
import time
import urllib.parse
import requests
import subprocess
import shutil
import logging
from pathlib import Path
from typing import Dict, Any, Optional, Callable
import yt_dlp
from .config import DOWNLOADS_DIR, REPORTS_DIR, load_settings
from .telegram_notifier import TelegramNotifier

logger = logging.getLogger("downloader")

class YtDlpDownloaderLogger:
    """Silences noisy yt-dlp stderr messages during fallback operations."""
    def debug(self, msg):
        pass
    def info(self, msg):
        pass
    def warning(self, msg):
        logger.warning("yt-dlp: %s", msg)
    def error(self, msg):
        logger.warning("yt-dlp: %s", msg)

DIRECT_MEDIA_EXTENSIONS = (
    ".mp4", ".webm", ".mov", ".mkv", ".m4v", ".flv", ".avi", ".ts", ".3gp", ".m3u8", ".mpd"
)

def sanitize_filename(name: str) -> str:
    cleaned = re.sub(r'[\\/*?:"<>|]', "", name)
    cleaned = cleaned.strip().replace(" ", "_")
    return cleaned[:100] or "video"

class VideoDownloader:
    """
    Universal Video Downloader with dual engines:
    1. Direct Stream Downloader: for direct media files (MOV, WEBM, MP4, MKV) and CDN
       links (Wikimedia, Cloudflare, direct storage) with browser impersonation headers.
    2. yt-dlp Extractor Engine: for complex streaming platforms (HLS, DASH, embedded players).
    3. FFmpeg Remuxer/Converter: converts all streams into standard H.264 / AAC MP4.
    """

    def __init__(self, output_dir: Optional[Path] = None):
        self.output_dir = output_dir or DOWNLOADS_DIR
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.ffmpeg_path = "/usr/bin/ffmpeg" if os.path.exists("/usr/bin/ffmpeg") else "ffmpeg"
        self.settings = load_settings()

    def download_video(
        self,
        media_url: str,
        title: str = "video",
        format_id: Optional[str] = None,
        job_id: Optional[str] = None,
        progress_callback: Optional[Callable[[Dict[str, Any]], None]] = None
    ) -> Dict[str, Any]:
        """
        Executes download and conversion pipeline with automatic fallback.
        """
        job_id = job_id or f"job_{int(time.time() * 1000)}"
        safe_title = sanitize_filename(title)
        timestamp = time.strftime("%Y%m%d_%H%M%S")
        target_filename = f"{safe_title}_{timestamp}.mp4"
        final_filepath = self.output_dir / target_filename

        progress_state = {
            "job_id": job_id,
            "title": title,
            "media_url": media_url,
            "status": "starting",
            "progress_percent": 0.0,
            "speed_mbps": 0.0,
            "eta_seconds": 0,
            "total_bytes": 0,
            "output_path": str(final_filepath),
            "output_filename": target_filename,
            "error": None,
            "completed": False
        }

        def report_progress(state_update: dict):
            progress_state.update(state_update)
            if progress_callback:
                progress_callback(progress_state)

        report_data = {
            "job_id": job_id,
            "title": title,
            "source_url": media_url,
            "format_id": format_id,
            "status": "in_progress",
            "start_time": time.time(),
            "end_time": None,
            "duration_seconds": None,
            "file_size_bytes": 0,
            "output_file": str(final_filepath),
            "output_filename": target_filename,
            "telegram_uploaded": False,
            "error": None
        }

        report_progress({"status": "downloading", "progress_percent": 3.0})

        # Platform watch pages are not direct media URLs.
        parsed_media = urllib.parse.urlparse(media_url)
        media_host = (parsed_media.hostname or "").lower().removeprefix("www.")
        is_youtube = media_host == "youtu.be" or media_host == "youtube.com" or media_host.endswith(".youtube.com")
        url_lower = media_url.lower().split("?")[0]
        is_direct = not is_youtube and (any(url_lower.endswith(ext) for ext in DIRECT_MEDIA_EXTENSIONS) or "wikimedia.org" in url_lower)

        download_success = False
        direct_attempted = False

        # Attempt 1: Direct stream download if recognized as direct media file
        if is_direct:
            direct_attempted = True
            logger.info(f"Direct media file detected: {media_url}. Using streaming downloader.")
            try:
                self._download_direct_stream(
                    media_url=media_url,
                    safe_title=safe_title,
                    timestamp=timestamp,
                    final_filepath=final_filepath,
                    report_progress=report_progress
                )
                download_success = True
            except Exception as direct_err:
                logger.warning(f"Direct stream download failed: {direct_err}. Trying yt-dlp engine...")

        # Attempt 2: If not direct, or if direct failed, use yt-dlp
        if not download_success:
            try:
                self._download_via_ytdlp(
                    media_url=media_url,
                    title=title,
                    format_id=format_id,
                    safe_title=safe_title,
                    timestamp=timestamp,
                    final_filepath=final_filepath,
                    report_progress=report_progress,
                    report_data=report_data
                )
                download_success = True
            except Exception as ytdlp_err:
                logger.warning(f"yt-dlp engine failed: {ytdlp_err}.")
                # Never curl a YouTube watch page: it returns HTML challenge
                # content, not a media stream, and can create corrupt tiny MP4s.
                if is_youtube:
                    report_data["status"] = "failed"
                    report_data["error"] = str(ytdlp_err)
                    report_data["end_time"] = time.time()
                    report_progress({"status": "failed", "completed": False, "error": str(ytdlp_err)})
                # A direct URL has already gone through the direct-stream
                # pipeline above. Repeating the same transfer is unnecessary.
                elif not direct_attempted:
                    try:
                        self._download_direct_stream(
                            media_url=media_url,
                            safe_title=safe_title,
                            timestamp=timestamp,
                            final_filepath=final_filepath,
                            report_progress=report_progress
                        )
                        download_success = True
                    except Exception as final_err:
                        logger.error(f"All download attempts failed for {media_url}: {final_err}")
                        report_data["status"] = "failed"
                        report_data["error"] = str(final_err)
                        report_data["end_time"] = time.time()
                        report_progress({
                            "status": "failed",
                            "completed": False,
                            "error": str(final_err)
                        })
                else:
                    report_data["status"] = "failed"
                    report_data["error"] = str(ytdlp_err)
                    report_data["end_time"] = time.time()
                    report_progress({
                        "status": "failed",
                        "completed": False,
                        "error": str(ytdlp_err)
                    })

        # Final verification: size alone cannot prove that the response is media.
        if download_success and final_filepath.exists():
            if not self._is_valid_video_file(final_filepath):
                final_filepath.unlink(missing_ok=True)
                raise RuntimeError("Downloaded response is not a valid playable video; the source may have returned an HTML challenge or login page.")
            file_size = final_filepath.stat().st_size
            report_data["file_size_bytes"] = file_size
            report_data["status"] = "completed"
            report_data["end_time"] = time.time()
            report_data["output_file"] = str(final_filepath)
            report_data["output_filename"] = final_filepath.name

            report_progress({
                "status": "completed",
                "progress_percent": 100.0,
                "completed": True,
                "output_path": str(final_filepath),
                "output_filename": final_filepath.name,
                "total_bytes": file_size
            })

            # Every completed download is archived to the deployment's
            # internal Telegram channel. A workspace channel, when present,
            # receives a forward of that same Telegram message (not a second upload).
            settings = load_settings()
            tg = TelegramNotifier(
                settings.get("telegram_bot_token"),
                settings.get("telegram_chat_id")
            )
            if tg.is_configured():
                report_progress({"status": "uploading_telegram"})
                tg_res = tg.send_download_complete(
                    title=report_data["title"],
                    site_url=media_url,
                    file_path=str(final_filepath),
                    file_size_bytes=file_size,
                    duration=report_data.get("duration_seconds")
                )
            else:
                tg_res = {
                    "success": False,
                    "skipped": True,
                    "error": "Internal Telegram backup is not configured. Set TELEGRAM_BOT_TOKEN (or LOG_TELEGRAM_BOT_TOKEN) and TELEGRAM_BACKUP_CHAT_ID (or LOG_TELEGRAM_CHAT_ID)."
                }
            report_data["telegram_uploaded"] = bool(tg_res.get("success"))
            report_data["telegram_result"] = tg_res
            if not report_data["telegram_uploaded"]:
                logger.error("Telegram backup/forward failed for %s: %s", final_filepath.name, tg_res.get("error") or "No error details returned")

        # Save JSON Report
        report_file = REPORTS_DIR / f"{job_id}.json"
        with open(report_file, "w", encoding="utf-8") as f:
            json.dump(report_data, f, indent=2)

        return report_data

    def _download_direct_stream(
        self,
        media_url: str,
        safe_title: str,
        timestamp: str,
        final_filepath: Path,
        report_progress: Callable
    ):
        """
        Multi-Tier 403-Bypass Direct Media Downloader:
        Tier 1: Multi-profile streaming with origin referer and range headers (eliminates 403 Forbidden).
        Tier 2: System curl subprocess with native HTTP/2 & ALPN cipher negotiation.
        Tier 3: FFmpeg native direct stream ingestion and MP4 remuxing.
        """
        parsed = urllib.parse.urlparse(media_url)
        origin = f"{parsed.scheme}://{parsed.netloc}/"
        ref = "https://en.wikipedia.org/" if "wikimedia.org" in media_url else origin

        # Determine temporary extension from URL
        url_clean = media_url.split("?")[0]
        ext = Path(url_clean).suffix or ".mp4"
        temp_download_path = self.output_dir / f"{safe_title}_{timestamp}.tmp{ext}"

        logger.info(f"Initiating resilient direct stream download for: {media_url}")
        start_time = time.time()
        stream_success = False

        # Tier 1: Multi-profile requests streaming
        header_profiles = [
            # Profile 1: Genuine Chrome with origin referer (no cross-site flags)
            {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
                "Referer": ref,
                "Accept": "*/*",
                "Accept-Language": "en-US,en;q=0.9",
            },
            # Profile 2: Clean direct request without referer (bypasses anti-hotlinking firewalls)
            {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
                "Accept": "*/*",
                "Range": "bytes=0-",
            },
            # Profile 3: Native Video Player Client (bypasses CDN anti-scraping filters)
            {
                "User-Agent": "Lavf/60.16.100",
                "Accept": "*/*",
                "Range": "bytes=0-",
            }
        ]

        for p_idx, h in enumerate(header_profiles, 1):
            profile_started_at = time.time()
            try:
                logger.info(f"[Tier 1] Trying header profile {p_idx} for direct stream...")
                with requests.get(
                    media_url,
                    headers={**h, "Accept-Encoding": "identity"},
                    stream=True,
                    timeout=(12, 45),
                ) as r:
                    if r.status_code in (200, 206):
                        content_type = (r.headers.get("content-type") or "").lower()
                        if "text/html" in content_type or "application/json" in content_type:
                            logger.warning(
                                "[Tier 1] Profile %d returned non-media content (%s); skipping.",
                                p_idx, content_type,
                            )
                            continue
                        total_bytes = int(r.headers.get("content-length", 0))
                        if not total_bytes:
                            content_range = r.headers.get("content-range", "")
                            match = re.search(r"/(\d+)$", content_range)
                            if match:
                                total_bytes = int(match.group(1))
                        downloaded = 0

                        with open(temp_download_path, "wb") as f:
                            for chunk in r.iter_content(chunk_size=1024 * 1024):
                                if chunk:
                                    f.write(chunk)
                                    downloaded += len(chunk)

                                    elapsed = max(0.1, time.time() - profile_started_at)
                                    speed_mb = round((downloaded / (1024 * 1024)) / elapsed, 2)
                                    pct = round((downloaded / total_bytes) * 90.0, 1) if total_bytes > 0 else 5.0
                                    eta = int((total_bytes - downloaded) / (downloaded / elapsed)) if total_bytes > downloaded and downloaded > 0 else 0

                                    report_progress({
                                        "status": "downloading",
                                        "progress_percent": min(92.0, max(5.0, pct)),
                                        "speed_mbps": speed_mb,
                                        "eta_seconds": eta,
                                        "total_bytes": total_bytes or downloaded
                                    })

                        if self._looks_like_media_file(temp_download_path):
                            stream_success = True
                            logger.info(f"[Tier 1] Header profile {p_idx} succeeded ({temp_download_path.stat().st_size} bytes downloaded).")
                            break
                    else:
                        logger.warning(f"[Tier 1] Profile {p_idx} received HTTP status {r.status_code}")
            except Exception as tier1_err:
                logger.warning(f"[Tier 1] Profile {p_idx} failed: {tier1_err}")

        # Tier 2: System curl subprocess with native HTTP/2 & ALPN
        if not stream_success:
            logger.info("[Tier 2] Engaging system curl HTTP/2 downloader to bypass 403 Forbidden...")
            try:
                cmd = [
                    "curl", "-sSL", "-L", "--fail",
                    "--retry", "3", "--retry-all-errors", "--retry-delay", "1",
                    "-A", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
                    "-e", ref,
                    "--connect-timeout", "15",
                    "--speed-time", "45",
                    "--speed-limit", "1024",
                    "-o", str(temp_download_path),
                    media_url
                ]
                proc = subprocess.Popen(cmd)
                while proc.poll() is None:
                    time.sleep(0.5)
                    if temp_download_path.exists():
                        cur_sz = temp_download_path.stat().st_size
                        elapsed = max(0.1, time.time() - start_time)
                        speed_mb = round((cur_sz / (1024 * 1024)) / elapsed, 2)
                        report_progress({
                            "status": "downloading",
                            "progress_percent": 60.0,
                            "speed_mbps": speed_mb,
                            "total_bytes": cur_sz
                        })
                if proc.returncode == 0 and self._looks_like_media_file(temp_download_path):
                    stream_success = True
                    logger.info(f"[Tier 2] System curl succeeded ({temp_download_path.stat().st_size} bytes downloaded).")
            except Exception as curl_err:
                logger.warning(f"[Tier 2] System curl failed: {curl_err}")

        # Tier 3: System FFmpeg native stream demuxing
        if not stream_success:
            logger.info("[Tier 3] Engaging FFmpeg native direct stream ingestion...")
            try:
                headers_str = f"User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36\r\nReferer: {ref}\r\n"
                cmd = [
                    self.ffmpeg_path, "-y",
                    "-headers", headers_str,
                    "-rw_timeout", "30000000",
                    "-reconnect", "1",
                    "-reconnect_streamed", "1",
                    "-reconnect_delay_max", "5",
                    "-i", media_url,
                    "-c", "copy",
                    "-movflags", "+faststart",
                    str(final_filepath)
                ]
                res = subprocess.run(cmd, capture_output=True, text=True)
                if res.returncode == 0 and final_filepath.exists() and final_filepath.stat().st_size > 1000:
                    logger.info("[Tier 3] FFmpeg direct stream copy succeeded.")
                    return
                if res.stderr:
                    logger.warning("[Tier 3] FFmpeg rejected the source: %s", res.stderr[-1200:].strip())
            except Exception as ffmpeg_err:
                logger.warning(f"[Tier 3] FFmpeg stream copy failed: {ffmpeg_err}")

        if not stream_success or not temp_download_path.exists() or temp_download_path.stat().st_size == 0:
            temp_download_path.unlink(missing_ok=True)
            raise RuntimeError(
                "Direct media download failed: the source did not provide a downloadable media response. "
                "The URL may require authorization, a valid source session, or may be protected by the host."
            )

        report_progress({"status": "processing_ffmpeg", "progress_percent": 95.0})
        # Convert/remux the downloaded raw stream into standard MP4
        self._convert_to_mp4(temp_download_path, final_filepath)

        # Remove temp file
        if temp_download_path.exists():
            temp_download_path.unlink(missing_ok=True)

    def _download_via_ytdlp(
        self,
        media_url: str,
        title: str,
        format_id: Optional[str],
        safe_title: str,
        timestamp: str,
        final_filepath: Path,
        report_progress: Callable,
        report_data: dict
    ):
        """
        Download with yt-dlp. YouTube gets bounded public-client retries only
        after its default extractor path fails; other sites retain one attempt.
        """
        def ydl_hook(d):
            if d.get("status") == "downloading":
                total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
                downloaded = d.get("downloaded_bytes") or 0
                speed = d.get("speed") or 0.0
                eta = d.get("eta") or 0
                pct = round((downloaded / total * 90.0), 1) if total > 0 else 0.0
                speed_mb = round(speed / (1024 * 1024), 2)
                report_progress({
                    "status": "downloading",
                    "progress_percent": min(92.0, max(5.0, pct)),
                    "speed_mbps": speed_mb,
                    "eta_seconds": eta,
                    "total_bytes": total
                })
            elif d.get("status") == "finished":
                report_progress({
                    "status": "processing_ffmpeg",
                    "progress_percent": 95.0
                })

        format_rule = "bestvideo+bestaudio/best"
        if format_id and format_id not in ("best", "auto", "direct"):
            if format_id.startswith("height:"):
                requested_height = int(format_id.split(":", 1)[1])
                format_rule = f"bestvideo[height<={requested_height}]+bestaudio/best[height<={requested_height}]/best"
            else:
                format_rule = f"{format_id}+bestaudio/best"

        parsed = urllib.parse.urlparse(media_url)
        origin = f"{parsed.scheme}://{parsed.netloc}/"
        host = (parsed.hostname or "").lower().removeprefix("www.")
        is_youtube = host == "youtu.be" or host == "youtube.com" or host.endswith(".youtube.com")
        referer = "https://en.wikipedia.org/" if "wikimedia.org" in media_url else origin

        ydl_opts = {
            "format": format_rule,
            "outtmpl": str(self.output_dir / f"{safe_title}_{timestamp}.%(ext)s"),
            "ffmpeg_location": self.ffmpeg_path,
            "merge_output_format": "mp4",
            "http_headers": {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
                "Referer": referer,
                "Accept": "*/*",
            },
            "postprocessors": [
                {"key": "FFmpegVideoRemuxer", "preferedformat": "mp4"}
            ],
            "progress_hooks": [ydl_hook],
            "quiet": True,
            "no_warnings": True,
            "ignoreerrors": False,
            "retries": 2,
            "fragment_retries": 3,
            "concurrent_fragment_downloads": 6,
            "buffersize": 1024 * 1024,
            "socket_timeout": 25,
            "extractor_retries": 3,
            "file_access_retries": 3,
            "remote_components": ["ejs:github"],
            "logger": YtDlpDownloaderLogger()
        }
        deno_path = shutil.which("deno")
        if deno_path:
            ydl_opts["js_runtimes"] = {"deno": {"path": deno_path}}

        # Optional authorized session support. No cookie is generated or
        # required for the public-client fallback sequence below.
        cookie_file = os.environ.get("YTDLP_COOKIES_FILE")
        if cookie_file:
            cookie_path = Path(cookie_file).expanduser()
            if cookie_path.is_file():
                ydl_opts["cookiefile"] = str(cookie_path)
                logger.info("yt-dlp authorized cookie file is configured.")
            else:
                raise RuntimeError("Configured YTDLP_COOKIES_FILE is not readable.")
        browser_cookies = os.environ.get("YTDLP_COOKIES_FROM_BROWSER", "").strip()
        if browser_cookies:
            ydl_opts["cookiesfrombrowser"] = tuple(
                part or None for part in browser_cookies.split(":")
            )

        # These are public YouTube player clients supported by yt-dlp. The
        # default client set is always tried first. The extra profiles are
        # deliberately YouTube-only and bounded so normal sites incur no cost.
        youtube_fallback_clients = (
            "mweb",
            "tv",
            "android_vr",
            "web_embedded",
            "web_safari",
        )
        attempts = [None] + (list(youtube_fallback_clients) if is_youtube else [])
        last_error = None
        info = None

        for attempt_index, player_client in enumerate(attempts, start=1):
            attempt_opts = dict(ydl_opts)
            if is_youtube:
                # BgUtils generates fresh video-bound PO tokens on demand.
                attempt_opts["extractor_args"] = {
                    "youtube": (
                        {"player_client": [player_client]} if player_client else {}
                    )
                }
            if player_client:
                logger.warning(
                    "YouTube default extraction failed; retrying with public player client '%s' (%d/%d).",
                    player_client,
                    attempt_index - 1,
                    len(attempts) - 1,
                )

            try:
                with yt_dlp.YoutubeDL(attempt_opts) as ydl:
                    info = ydl.extract_info(media_url, download=True)
                if info:
                    report_data["title"] = info.get("title") or title
                    report_data["duration_seconds"] = info.get("duration")
                    break
                last_error = RuntimeError("yt-dlp returned no video information.")
            except Exception as exc:
                last_error = exc
                logger.warning(
                    "yt-dlp attempt %d/%d failed%s: %s",
                    attempt_index,
                    len(attempts),
                    f" using {player_client}" if player_client else "",
                    exc,
                )

            # Remove only incomplete fragments before trying another client.
            # Never remove a completed output produced by an earlier attempt.
            if is_youtube and attempt_index < len(attempts):
                for partial in self.output_dir.glob(f"{safe_title}_{timestamp}.*"):
                    if partial.name.endswith((".part", ".ytdl")):
                        partial.unlink(missing_ok=True)

        if not info and last_error:
            raise last_error

        # Normalize yt-dlp's actual output to the filename expected by the
        # job tracker. A remuxed output may use a different extension.
        if not final_filepath.exists():
            candidates = sorted(
                (
                    item for item in self.output_dir.glob(f"{safe_title}_{timestamp}.*")
                    if ".tmp." not in item.name
                    and not item.name.endswith((".part", ".ytdl"))
                ),
                key=lambda item: item.stat().st_mtime,
                reverse=True,
            )
            if candidates:
                cand = candidates[0]
                if cand.resolve() != final_filepath.resolve():
                    if cand.suffix.lower() == ".mp4":
                        os.replace(cand, final_filepath)
                    else:
                        self._convert_to_mp4(cand, final_filepath)
                        cand.unlink(missing_ok=True)

        if not final_filepath.exists() or final_filepath.stat().st_size <= 1000:
            raise RuntimeError(
                "yt-dlp finished without producing a valid output video file."
            )

    @staticmethod
    def _looks_like_media_file(file_path: Path) -> bool:
        try:
            if not file_path.exists() or file_path.stat().st_size < 64 * 1024:
                return False
            with open(file_path, "rb") as stream:
                header = stream.read(512).lstrip().lower()
            if header.startswith((b"<!doctype html", b"<html", b"{", b"[")):
                return False
            return b"ftyp" in header[:64] or header.startswith(b"\x1aE\xdf\xa3") or header.startswith(b"\x47") or b"#extm3u" in header or b"<?xml" in header
        except OSError:
            return False

    def _is_valid_video_file(self, file_path: Path) -> bool:
        if not self._looks_like_media_file(file_path):
            return False
        try:
            probe = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type", "-of", "json", str(file_path)], capture_output=True, text=True, timeout=20)
            metadata = json.loads(probe.stdout or "{}")
            return probe.returncode == 0 and any(stream.get("codec_type") == "video" for stream in metadata.get("streams", []))
        except Exception as exc:
            logger.warning("Video validation failed: %s", exc)
            return False

    def _convert_to_mp4(self, input_file: Path, output_file: Path):
        """
        Invokes FFmpeg to remux or encode to standard H.264 / AAC MP4.
        """
        logger.info(f"Running FFmpeg remux: {input_file} -> {output_file}")
        
        # Step 1: Pure stream copy is the fastest lossless path. Only
        # transcode if the source codecs/container cannot be muxed into MP4.
        cmd = [
            self.ffmpeg_path,
            "-y",
            "-i", str(input_file),
            "-c", "copy",
            "-movflags", "+faststart",
            str(output_file)
        ]
        res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        
        # Step 2: If copy fails (e.g. VP9 or MPEG4 in MOV container), transcode to standard H.264
        if res.returncode != 0 or not output_file.exists() or output_file.stat().st_size == 0:
            logger.info("Direct stream copy not supported for this codec. Transcoding to H.264/AAC...")
            cmd_transcode = [
                self.ffmpeg_path,
                "-y",
                "-i", str(input_file),
                "-c:v", "libx264",
                "-preset", "veryfast",
                "-crf", "22",
                "-c:a", "aac",
                "-b:a", "192k",
                "-movflags", "+faststart",
                str(output_file)
            ]
            subprocess.run(cmd_transcode, check=True)
