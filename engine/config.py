import os
import json
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent.parent
DOWNLOADS_DIR = Path(os.getenv("SCRAPLING_DOWNLOADS_DIR", str(BASE_DIR / "downloads"))).resolve()
REPORTS_DIR = Path(os.getenv("SCRAPLING_REPORTS_DIR", str(BASE_DIR / "reports"))).resolve()
LOGS_DIR = Path(os.getenv("SCRAPLING_LOGS_DIR", str(BASE_DIR / "logs"))).resolve()
SETTINGS_FILE = Path(os.getenv("SCRAPLING_SETTINGS_FILE", str(BASE_DIR / "settings.json"))).resolve()

DOWNLOADS_DIR.mkdir(parents=True, exist_ok=True)
REPORTS_DIR.mkdir(parents=True, exist_ok=True)
LOGS_DIR.mkdir(parents=True, exist_ok=True)
SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)

# Telegram credentials are deliberately workspace-scoped in settings.json.
# Do not inherit deployment-wide Telegram secrets as defaults: that would make
# every anonymous browser share the same delivery destination.
DEFAULT_SETTINGS = {
    "telegram_bot_token": "",
    "telegram_chat_id": "",
    "telegram_api_id": "",
    "telegram_api_hash": "",
    "telegram_thread_id": "",
    "auto_upload_telegram": False,
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
