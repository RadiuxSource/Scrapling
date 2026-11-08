import sys
import argparse
import json
from pathlib import Path

# Add project root to sys.path so running directly works
project_root = Path(__file__).resolve().parent.parent
if str(project_root) not in sys.path:
    sys.path.insert(0, str(project_root))

try:
    from .scraper import MediaInspector
    from .downloader import VideoDownloader
    from .telegram_notifier import TelegramNotifier
    from .config import load_settings, save_settings
except ImportError:
    from engine.scraper import MediaInspector
    from engine.downloader import VideoDownloader
    from engine.telegram_notifier import TelegramNotifier
    from engine.config import load_settings, save_settings

def cmd_test(args):
    url = args.url
    print(f"\n[+] Testing Website Inspection with Scrapling: {url}")
    inspector = MediaInspector()
    report = inspector.inspect_url(url)

    print(f"[*] HTTP Status: {report['status_code']}")
    print(f"[*] Page Title: {report['page_title']}")
    print(f"[*] Detected Players: {', '.join(report['detected_players']) or 'None'}")
    print(f"[*] Discovered Streams/Links: {len(report['streams_found'])}")
    print(f"[*] Total Processable Videos: {len(report['videos'])}")

    if report["videos"]:
        print("\n--- Detected Video Sources ---")
        for idx, v in enumerate(report["videos"], 1):
            dur = f"{v['duration']}s" if v.get("duration") else "Stream"
            print(f"{idx}. [{v['protocol']}] {v['title'][:60]} | Res: {v['resolution']} | Dur: {dur}")
            print(f"   URL: {v['media_url'][:90]}...")

    settings = load_settings()
    token = args.token or settings.get("telegram_bot_token")
    chat_id = args.chat_id or settings.get("telegram_chat_id")

    if token and chat_id:
        print("\n[+] Dispatching Test Succeeded Notification to Telegram...")
        tg = TelegramNotifier(token, chat_id)
        sample = report["videos"][0]["title"] if report["videos"] else None
        tg_res = tg.send_test_success_notification(
            site_url=url,
            detected_count=len(report["videos"]),
            sample_title=sample,
            protocols=report["detected_players"]
        )
        if tg_res.get("success"):
            print("[✓] Telegram notification sent successfully!")
        else:
            print(f"[!] Telegram notification failed: {tg_res.get('error')}")

    print("\n[✓] Website inspection test finished.")

def cmd_scrape(args):
    urls = args.urls
    print(f"\n[+] Batch Scraping {len(urls)} URL(s)...")
    inspector = MediaInspector()
    all_results = []
    for u in urls:
        print(f"\n--> Inspecting: {u}")
        res = inspector.inspect_url(u)
        all_results.append(res)
        print(f"    Found {len(res['videos'])} video(s), {len(res['streams_found'])} stream(s)")

    if args.json:
        print(json.dumps(all_results, indent=2))
    else:
        print(f"\n[✓] Scraping complete across {len(urls)} website(s).")

def cmd_download(args):
    url = args.url
    title = args.title or "video"
    print(f"\n[+] Downloading: {url}")
    print(f"[*] Target Title: {title}")
    downloader = VideoDownloader()

    def on_prog(st):
        if st.get("status") == "downloading":
            pct = st.get("progress_percent", 0)
            spd = st.get("speed_mbps", 0)
            print(f"\rDownloading: {pct}% at {spd} MB/s", end="", flush=True)

    res = downloader.download_video(url, title=title, format_id=args.format, progress_callback=on_prog)
    print("\n")
    if res["status"] == "completed":
        print(f"[✓] Download and MP4 FFmpeg conversion succeeded!")
        print(f"    Saved: {res['output_file']}")
        print(f"    File size: {round(res['file_size_bytes'] / (1024*1024), 2)} MB")
    else:
        print(f"[!] Download failed: {res.get('error')}")

def cmd_telegram_test(args):
    settings = load_settings()
    token = args.token or settings.get("telegram_bot_token")
    chat_id = args.chat_id or settings.get("telegram_chat_id")
    print(f"\n[+] Testing Telegram connection (Chat ID: {chat_id})...")
    tg = TelegramNotifier(token, chat_id)
    res = tg.test_connection()
    if res["success"]:
        print(f"[✓] Connected: {res['message']} (Bot: @{res.get('bot_username')})")
    else:
        print(f"[!] Telegram test failed: {res.get('error')}")

def main():
    parser = argparse.ArgumentParser(description="Vortex Video Scraping and Downloading CLI")
    sub = parser.add_subparsers(dest="command")

    # test
    p_test = sub.add_parser("test", help="Test website inspection & stream detection")
    p_test.add_argument("url", help="Target website URL")
    p_test.add_argument("--token", help="Telegram Bot Token", default=None)
    p_test.add_argument("--chat-id", help="Telegram Channel/Chat ID", default=None)

    # scrape
    p_scrape = sub.add_parser("scrape", help="Batch inspect websites")
    p_scrape.add_argument("urls", nargs="+", help="One or more website URLs")
    p_scrape.add_argument("--json", action="store_true", help="Output raw JSON")

    # download
    p_dl = sub.add_parser("download", help="Download video and convert to MP4")
    p_dl.add_argument("url", help="Media or page URL")
    p_dl.add_argument("--title", help="Custom video title", default="video")
    p_dl.add_argument("--format", help="Target format ID", default=None)

    # telegram-test
    p_tg = sub.add_parser("telegram-test", help="Verify Telegram Bot credentials")
    p_tg.add_argument("--token", help="Bot Token", default=None)
    p_tg.add_argument("--chat-id", help="Chat/Channel ID", default=None)

    args = parser.parse_args()
    if args.command == "test":
        cmd_test(args)
    elif args.command == "scrape":
        cmd_scrape(args)
    elif args.command == "download":
        cmd_download(args)
    elif args.command == "telegram-test":
        cmd_telegram_test(args)
    else:
        parser.print_help()

if __name__ == "__main__":
    main()
