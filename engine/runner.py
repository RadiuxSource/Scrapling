import sys
import os
import json
import time
import logging
from pathlib import Path

# Force logging to stderr
logging.basicConfig(stream=sys.stderr, level=logging.INFO)

from .scraper import MediaInspector
from .downloader import VideoDownloader
from .telegram_notifier import TelegramNotifier
from .config import load_settings, save_settings, LOGS_DIR, REPORTS_DIR, DOWNLOADS_DIR

JOBS_DIR = LOGS_DIR / "jobs"
JOBS_DIR.mkdir(parents=True, exist_ok=True)

def handle_test_website(url: str, custom_token: str = None, custom_chat_id: str = None, max_subpages: int = 20, subpage_offset: int = 0):
    inspector = MediaInspector()
    report = inspector.inspect_url(url, deep_crawl=True, max_subpages=max_subpages, subpage_offset=subpage_offset)
    
    settings = load_settings()
    token = custom_token or settings.get("telegram_bot_token")
    chat_id = custom_chat_id or settings.get("telegram_chat_id")
    
    tg_result = {"skipped": True, "reason": "No Telegram credentials configured"}
    if token and chat_id:
        tg = TelegramNotifier(token, chat_id)
        sample = report["videos"][0]["title"] if report["videos"] else None
        count_to_report = len(report["videos"]) if len(report["videos"]) > 0 else report.get("subpages_discovered", 0)
        tg_result = tg.send_test_success_notification(
            site_url=url,
            detected_count=count_to_report,
            sample_title=sample,
            protocols=report["detected_players"]
        )

    output = {
        "success": report["success"],
        "inspection": report,
        "telegram_notification": tg_result
    }
    return output

def handle_scrape_batch(urls: list, deep_crawl: bool = True, max_subpages: int = 100, subpage_offset: int = 0):
    """Inspect every submitted URL and preserve partial results if one URL fails."""
    inspector = MediaInspector()
    results = []
    failures = []
    total_videos = 0
    total_subpages_discovered = 0
    total_subpages_scanned = 0
    submitted_urls = [u.strip() for u in urls if isinstance(u, str) and u.strip()]

    for clean_u in submitted_urls:
        try:
            rep = inspector.inspect_url(
                clean_u,
                deep_crawl=deep_crawl,
                max_subpages=max_subpages,
                subpage_offset=subpage_offset,
            )
            if not isinstance(rep, dict):
                raise TypeError("Inspector returned an invalid report")

            videos = rep.get("videos") or []
            rep.setdefault("page_url", clean_u)
            rep.setdefault("videos", [])
            results.append(rep)
            total_videos += len(videos)
            total_subpages_discovered += int(rep.get("total_subpages_discovered", rep.get("subpages_discovered", 0)) or 0)
            total_subpages_scanned += int(rep.get("subpages_scanned", 0) or 0)

            if rep.get("error"):
                failures.append({"url": clean_u, "error": str(rep["error"])})
        except Exception as exc:
            error = str(exc) or exc.__class__.__name__
            failures.append({"url": clean_u, "error": error})
            results.append({
                "page_url": clean_u,
                "success": False,
                "error": error,
                "videos": [],
                "subpages_discovered": 0,
                "total_subpages_discovered": 0,
                "subpages_scanned": 0,
                "has_more_subpages": False,
                "next_offset": None,
            })
            logging.exception("Batch inspection failed for %s", clean_u)

    completed_urls = len(results)
    return {
        "success": completed_urls == len(submitted_urls) and not failures,
        "completed": True,
        "total_urls": len(submitted_urls),
        "completed_urls": completed_urls,
        "failed_urls": len(failures),
        "total_subpages_discovered": total_subpages_discovered,
        "total_subpages_scanned": total_subpages_scanned,
        "total_videos_detected": total_videos,
        "errors": failures,
        "results": results,
    }

def handle_download_job(job_id: str, media_url: str, title: str, format_id: str = None):
    job_file = JOBS_DIR / f"{job_id}.json"
    
    def on_progress(state):
        with open(job_file, "w", encoding="utf-8") as f:
            json.dump(state, f)
            
    downloader = VideoDownloader()
    result = downloader.download_video(
        media_url=media_url,
        title=title,
        format_id=format_id,
        job_id=job_id,
        progress_callback=on_progress
    )
    return result

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No action specified"}))
        sys.exit(1)

    action = sys.argv[1]
    raw_payload = sys.stdin.read()
    payload = {}
    if raw_payload.strip():
        try:
            payload = json.loads(raw_payload)
        except Exception as e:
            print(json.dumps({"error": f"Invalid JSON payload: {e}"}))
            sys.exit(1)

    try:
        if action == "test-website":
            res = handle_test_website(
                url=payload.get("url", ""),
                custom_token=payload.get("telegram_bot_token"),
                custom_chat_id=payload.get("telegram_chat_id"),
                max_subpages=payload.get("max_subpages", 20),
                subpage_offset=payload.get("subpage_offset", 0)
            )
            print(json.dumps(res))

        elif action == "scrape-batch":
            res = handle_scrape_batch(
                urls=payload.get("urls", []),
                deep_crawl=payload.get("deep_crawl", True),
                max_subpages=payload.get("max_subpages", 100),
                subpage_offset=payload.get("subpage_offset", 0)
            )
            print(json.dumps(res))

        elif action == "download-job":
            res = handle_download_job(
                job_id=payload.get("job_id", f"job_{int(time.time()*1000)}"),
                media_url=payload.get("media_url", ""),
                title=payload.get("title", "video"),
                format_id=payload.get("format_id")
            )
            print(json.dumps(res))

        elif action == "telegram-test":
            settings = load_settings()
            token = payload.get("telegram_bot_token") or settings.get("telegram_bot_token")
            chat_id = payload.get("telegram_chat_id") or settings.get("telegram_chat_id")
            api_id = payload.get("telegram_api_id") or settings.get("telegram_api_id")
            api_hash = payload.get("telegram_api_hash") or settings.get("telegram_api_hash")
            tg = TelegramNotifier(
                bot_token=token,
                chat_id=chat_id,
                api_id=api_id,
                api_hash=api_hash
            )
            res = tg.test_connection()
            print(json.dumps(res))

        elif action == "telegram-upload":
            settings = load_settings()
            token = payload.get("telegram_bot_token") or settings.get("telegram_bot_token")
            chat_id = payload.get("telegram_chat_id") or settings.get("telegram_chat_id")
            api_id = payload.get("telegram_api_id") or settings.get("telegram_api_id")
            api_hash = payload.get("telegram_api_hash") or settings.get("telegram_api_hash")
            tg = TelegramNotifier(
                bot_token=token,
                chat_id=chat_id,
                api_id=api_id,
                api_hash=api_hash
            )
            res = tg.send_download_complete(
                title=payload.get("title", "Video"),
                site_url=payload.get("site_url", ""),
                file_path=payload.get("file_path", ""),
                file_size_bytes=payload.get("file_size_bytes", 0),
                duration=payload.get("duration")
            )
            print(json.dumps(res))

        else:
            print(json.dumps({"error": f"Unknown action: {action}"}))
            sys.exit(1)

    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)

if __name__ == "__main__":
    main()
