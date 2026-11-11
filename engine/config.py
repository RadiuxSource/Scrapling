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


def resolve_telegram_delivery(settings=None, bot_token=None, chat_id=None):
    """Resolve the documented per-workspace bot/channel fallback matrix.

    Complete custom pairs win. A custom channel without a custom token uses
    the deployment default bot. An incomplete custom bot is ignored and uses
    both deployment defaults. Raw credentials remain server-side.
    """
    settings = settings or load_settings()
    custom_bot = str(bot_token or settings.get("telegram_bot_token") or "").strip()
    custom_chat = str(chat_id or settings.get("telegram_chat_id") or "").strip()
    # The platform media bot backs up every completed video to the internal
    # operational channel. The owner explicitly designated that channel as the
    # media archive; it is no longer merely a diagnostics destination.
    # The platform bot owns the archive and performs the subsequent forward,
    # so it must be the identity used for both operations. A custom workspace
    # bot is only a last-resort sender when no platform bot exists.
    default_bot = str(os.getenv("TELEGRAM_BOT_TOKEN") or os.getenv("LOG_TELEGRAM_BOT_TOKEN") or custom_bot or "").strip()
    default_chat = str(
        os.getenv("TELEGRAM_BACKUP_CHAT_ID")
        or os.getenv("LOG_TELEGRAM_CHAT_ID")
        or os.getenv("TELEGRAM_CHAT_ID")
        or ""
    ).strip()
    archive_chat = default_chat or custom_chat
    forward_chat = custom_chat if default_chat and custom_chat and custom_chat != default_chat else ""

    return {
        "bot_token": default_bot,
        "chat_id": archive_chat,
        "source": "platform_archive_forward" if forward_chat else ("deployment_default" if default_chat else "custom_fallback"),
        "api_id": settings.get("telegram_api_id", "") if not default_chat else "",
        "api_hash": settings.get("telegram_api_hash", "") if not default_chat else "",
        "backup_chat_id": archive_chat,
        "forward_chat_id": forward_chat,
    }
