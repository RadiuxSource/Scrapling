import sys
import os
import json
import time
import logging
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

# Force logging to stderr
logging.basicConfig(stream=sys.stderr, level=logging.INFO)

from .scraper import MediaInspector
from .downloader import VideoDownloader
from .telegram_notifier import TelegramNotifier
from .config import load_settings, save_settings, LOGS_DIR, REPORTS_DIR, DOWNLOADS_DIR
from .browser_session import run_browser_action

JOBS_DIR = LOGS_DIR / "jobs"
JOBS_DIR.mkdir(parents=True, exist_ok=True)


def handle_test_website(url: str, custom_token: str = None, custom_chat_id: str = None, max_subpages: int = 20, subpage_offset: int = 0):
    inspector = MediaInspector()
    report = inspector.inspect_url(url, deep_crawl=True, max_subpages=max_subpages, subpage_offset=subpage_offset)

    tg = TelegramNotifier(custom_token, custom_chat_id)
    tg_result = {"skipped": True, "reason": "No Telegram credentials configured"}
    if tg.is_configured():
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
    """Inspect submitted root URLs with bounded concurrency and isolate per-URL failures."""
    submitted_urls = list(dict.fromkeys(
        u.strip() for u in urls if isinstance(u, str) and u.strip()
    ))
    if not submitted_urls:
        return {
            "success": False, "completed": True, "total_urls": 0,
            "completed_urls": 0, "failed_urls": 0,
            "total_subpages_discovered": 0, "total_subpages_scanned": 0,
            "total_videos_detected": 0, "errors": [], "results": [],
        }

    # Avoid nested thread-pool explosion: at most 3 root pages at once,
    # each with at most 4 subpage workers. This keeps network and memory
    # pressure bounded while preventing one slow root from serializing all URLs.
    root_workers = min(3, len(submitted_urls))
    inspector = MediaInspector(max_workers=4)
    results_by_index = {}
    failures = []

    def inspect_one(index, clean_url):
        rep = inspector.inspect_url(
            clean_url,
            deep_crawl=deep_crawl,
            max_subpages=max_subpages,
            subpage_offset=subpage_offset,
        )
        if not isinstance(rep, dict):
            raise TypeError("Inspector returned an invalid report")
        rep.setdefault("page_url", clean_url)
        rep.setdefault("videos", [])
        return index, rep

    with ThreadPoolExecutor(max_workers=root_workers, thread_name_prefix="root-inspect") as executor:
        future_to_item = {
            executor.submit(inspect_one, index, clean_url): (index, clean_url)
            for index, clean_url in enumerate(submitted_urls)
        }
        for future in as_completed(future_to_item):
            index, clean_url = future_to_item[future]
            try:
                result_index, rep = future.result()
                results_by_index[result_index] = rep
                if rep.get("error"):
                    failures.append({"url": clean_url, "error": str(rep["error"])})
            except Exception as exc:
                error = str(exc) or exc.__class__.__name__
                failures.append({"url": clean_url, "error": error})
                results_by_index[index] = {
                    "page_url": clean_url,
                    "success": False,
                    "error": error,
                    "videos": [],
                    "subpages_discovered": 0,
                    "total_subpages_discovered": 0,
                    "subpages_scanned": 0,
                    "has_more_subpages": False,
                    "next_offset": None,
                }
                logging.exception("Batch inspection failed for %s", clean_url)

    results = [results_by_index[i] for i in range(len(submitted_urls))]
    total_videos = sum(len(rep.get("videos") or []) for rep in results)
    total_subpages_discovered = sum(
        int(rep.get("total_subpages_discovered", rep.get("subpages_discovered", 0)) or 0)
        for rep in results
    )
    total_subpages_scanned = sum(
        int(rep.get("subpages_scanned", 0) or 0) for rep in results
    )
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
        # Atomic replacement prevents the status endpoint from reading a
        # partially-written JSON document while the downloader is updating it.
        temp_file = job_file.with_suffix(".json.tmp")
        with open(temp_file, "w", encoding="utf-8") as f:
            json.dump(state, f)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp_file, job_file)

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

        elif action == "browser-session":
            print(json.dumps(run_browser_action(payload)))

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
