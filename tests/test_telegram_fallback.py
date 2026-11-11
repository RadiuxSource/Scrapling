import os
import sys
import types
import unittest
from unittest.mock import patch

# The CI workflow compiles the engine without installing optional runtime deps.
# config.py only needs dotenv's no-op loader for these pure routing tests.
try:
    import dotenv  # noqa: F401
except ModuleNotFoundError:
    dotenv_stub = types.ModuleType('dotenv')
    dotenv_stub.load_dotenv = lambda: None
    sys.modules['dotenv'] = dotenv_stub

from engine.config import resolve_telegram_delivery


class TelegramFallbackTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {
            "LOG_TELEGRAM_BOT_TOKEN": "DEFAULT_BOT_TOKEN",
            "LOG_TELEGRAM_CHAT_ID": "-100DEFAULT",
            "TELEGRAM_BOT_TOKEN": "",
            "TELEGRAM_CHAT_ID": "",
        }, clear=False)
        self.env.start()

    def tearDown(self):
        self.env.stop()

    def test_custom_bot_and_channel_use_custom_pair(self):
        result = resolve_telegram_delivery({
            "telegram_bot_token": "CUSTOM_TOKEN",
            "telegram_chat_id": "@custom_channel",
            "telegram_api_id": "123",
            "telegram_api_hash": "custom_hash",
        })
        self.assertEqual(result["source"], "custom")
        self.assertEqual(result["bot_token"], "CUSTOM_TOKEN")
        self.assertEqual(result["chat_id"], "@custom_channel")
        self.assertEqual(result["api_id"], "123")

    def test_channel_only_uses_default_bot_and_custom_channel(self):
        result = resolve_telegram_delivery({"telegram_bot_token": "", "telegram_chat_id": "@custom_channel"})
        self.assertEqual(result["source"], "default_bot_custom_channel")
        self.assertEqual(result["bot_token"], "DEFAULT_BOT_TOKEN")
        self.assertEqual(result["chat_id"], "@custom_channel")
        self.assertEqual(result["api_id"], "")

    def test_bot_only_uses_default_pair(self):
        result = resolve_telegram_delivery({"telegram_bot_token": "IGNORED_CUSTOM", "telegram_chat_id": ""})
        self.assertEqual(result["source"], "deployment_default")
        self.assertEqual(result["bot_token"], "DEFAULT_BOT_TOKEN")
        self.assertEqual(result["chat_id"], "-100DEFAULT")

    def test_neither_uses_default_pair(self):
        result = resolve_telegram_delivery({"telegram_bot_token": "", "telegram_chat_id": ""})
        self.assertEqual(result["source"], "deployment_default")
        self.assertEqual(result["bot_token"], "DEFAULT_BOT_TOKEN")
        self.assertEqual(result["chat_id"], "-100DEFAULT")


if __name__ == "__main__":
    unittest.main()
