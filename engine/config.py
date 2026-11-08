import os
import json
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent.parent
DOWNLOADS_DIR = BASE_DIR / "downloads"
REPORTS_DIR = BASE_DIR / "reports"
LOGS_DIR = BASE_DIR / "logs"
SETTINGS_FILE = BASE_DIR / "settings.json"

DOWNLOADS_DIR.mkdir(parents=True, exist_ok=True)
REPORTS_DIR.mkdir(parents=True, exist_ok=True)
LOGS_DIR.mkdir(parents=True, exist_ok=True)

DEFAULT_SETTINGS = {
    "telegram_bot_token": os.getenv("TELEGRAM_BOT_TOKEN", ""),
    "telegram_chat_id": os.getenv("TELEGRAM_CHAT_ID", ""),
    "telegram_api_id": os.getenv("TELEGRAM_API_ID", ""),
    "telegram_api_hash": os.getenv("TELEGRAM_API_HASH", ""),
    "telegram_thread_id": os.getenv("TELEGRAM_THREAD_ID", ""),
    "auto_upload_telegram": os.getenv("AUTO_UPLOAD_TELEGRAM", "true").lower() in ("true", "1", "yes"),
    "max_concurrent_downloads": 3,
    "crawl_depth": 1,
    "max_crawl_videos": 40,
    "default_resolution": "best",
    "ffmpeg_path": "/usr/bin/ffmpeg" if os.path.exists("/usr/bin/ffmpeg") else "ffmpeg",
    "timeout_seconds": 30,
    "retry_attempts": 3,
    "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
}

def load_settings() -> dict:
    if SETTINGS_FILE.exists():
        try:
            with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                merged = {**DEFAULT_SETTINGS, **data}
                return merged
        except Exception:
            return DEFAULT_SETTINGS.copy()
    return DEFAULT_SETTINGS.copy()

def save_settings(new_settings: dict) -> dict:
    current = load_settings()
    current.update(new_settings)
    with open(SETTINGS_FILE, "w", encoding="utf-8") as f:
        json.dump(current, f, indent=2)
    return current
