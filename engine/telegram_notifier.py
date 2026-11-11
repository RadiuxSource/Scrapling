import os
import requests
import json
import logging
import html
import math
import shutil
import subprocess
import asyncio
from pathlib import Path
from typing import Dict, Any, Optional, List
from .config import load_settings, resolve_telegram_delivery

logger = logging.getLogger("telegram_notifier")

class TelegramNotifier:
    """
    Handles Telegram Bot notifications, channel message dispatches,
    and high-capacity video uploads (supporting large files > 50MB up to 2GB)
    via MTProto (Telethon) and automated lossless multi-part FFmpeg streaming.
    """

    def __init__(
        self,
        bot_token: Optional[str] = None,
        chat_id: Optional[str] = None,
        api_id: Optional[str] = None,
        api_hash: Optional[str] = None,
    ):
        settings = load_settings()
        delivery = resolve_telegram_delivery(settings, bot_token=bot_token, chat_id=chat_id)
        self.bot_token = delivery["bot_token"]
        self.chat_id = delivery["chat_id"]
        self.delivery_source = delivery["source"]
        if delivery["source"] == "custom":
            self.api_id = (api_id or delivery.get("api_id") or "").strip()
            self.api_hash = (api_hash or delivery.get("api_hash") or "").strip()
        else:
            self.api_id = ""
            self.api_hash = ""
        self.api_base = f"https://api.telegram.org/bot{self.bot_token}"
        self.session = requests.Session()
        adapter = requests.adapters.HTTPAdapter(pool_connections=10, pool_maxsize=10, max_retries=2)
        self.session.mount("https://", adapter)
        self.session.mount("http://", adapter)

    def is_configured(self) -> bool:
        return bool(self.bot_token and self.chat_id)

    def test_connection(self) -> Dict[str, Any]:
        """
        Tests whether the bot token is valid and whether the bot can post
        to the specified chat_id / channel.
        """
        if not self.bot_token:
            return {"success": False, "error": "Bot token is missing."}
        if not self.chat_id:
            return {"success": False, "error": "Chat ID / Channel ID is missing."}

        try:
            # 1. Verify getMe
            me_resp = self.session.get(f"{self.api_base}/getMe", timeout=10)
            me_data = me_resp.json()
            if not me_data.get("ok"):
                return {
                    "success": False,
                    "error": f"Invalid Bot Token: {me_data.get('description', 'Unknown error')}"
                }

            bot_user = me_data.get("result", {})
            bot_name = bot_user.get("first_name", "Bot")
            bot_username = bot_user.get("username", "")

            # 2. Send test verification message
            has_mtproto = bool(self.api_id and self.api_hash)
            mtproto_badge = "⚡ 2GB MTProto Large Uploads Enabled" if has_mtproto else "📦 Multi-Part Large Video Chunking Enabled"

            test_text = (
                f"✅ <b>Vortex Video Scraper Integration Test</b>\n\n"
                f"🤖 <b>Bot:</b> {html.escape(bot_name)} (@{html.escape(bot_username)})\n"
                f"📡 <b>Status:</b> Connected successfully\n"
                f"🎯 <b>Channel/Chat:</b> <code>{html.escape(self.chat_id)}</code>\n"
                f"🚀 <b>Large File Mode:</b> {mtproto_badge}\n"
                f"⚡ <i>Ready to receive media inspection alerts and downloads of ANY file size.</i>"
            )

            send_resp = self.session.post(
                f"{self.api_base}/sendMessage",
                json={
                    "chat_id": self.chat_id,
                    "text": test_text,
                    "parse_mode": "HTML",
                    "disable_web_page_preview": True
                },
                timeout=12
            )
            send_data = send_resp.json()

            if send_data.get("ok"):
                return {
                    "success": True,
                    "message": "Connection verified! Test message delivered to Telegram.",
                    "bot_name": bot_name,
                    "bot_username": bot_username,
                    "chat_id": self.chat_id,
                    "large_file_support": "MTProto 2GB" if has_mtproto else "Auto-Split 50MB"
                }
            else:
                desc = send_data.get("description", "Failed to send message")
                return {
                    "success": False,
                    "error": f"Bot found, but could not post to chat '{self.chat_id}': {desc}. Please ensure the bot is an Admin in the channel with post permissions."
                }

        except Exception as e:
            return {"success": False, "error": f"Network or API Error: {str(e)}"}

    def send_test_success_notification(
        self,
        site_url: str,
        detected_count: int,
        sample_title: Optional[str] = None,
        protocols: Optional[list] = None
    ) -> Dict[str, Any]:
        """
        Sends the user-requested 'Test Website' successful notification to Telegram.
        """
        if not self.is_configured():
            return {"success": False, "skipped": True, "error": "Telegram credentials not configured."}

        clean_protocols = [p.replace("<", "").replace(">", "") for p in (protocols or ["HTML5 / MP4 / HLS"])]
        proto_str = ", ".join(clean_protocols)
        safe_url = html.escape(site_url)
        safe_proto = html.escape(proto_str)
        text = (
            f"🎯 <b>Website Inspection Test Succeeded!</b>\n\n"
            f"🔗 <b>Tested URL:</b> <code>{safe_url}</code>\n"
            f"🎥 <b>Detected Media Sources:</b> {detected_count} available stream(s)\n"
            f"📦 <b>Detected Types:</b> {safe_proto}\n"
        )
        if sample_title:
            safe_title = html.escape(sample_title[:100])
            text += f"🎬 <b>Sample Video Title:</b> {safe_title}\n"

        text += (
            f"\n⚡ <i>Inspected via Scrapling adaptive DOM parser & stream sniffer. Ready for automated extraction.</i>"
        )

        try:
            resp = self.session.post(
                f"{self.api_base}/sendMessage",
                json={
                    "chat_id": self.chat_id,
                    "text": text,
                    "parse_mode": "HTML",
                    "disable_web_page_preview": True
                },
                timeout=12
            )
            data = resp.json()
            return {"success": data.get("ok", False), "response": data}
        except Exception as e:
            logger.error(f"Failed to send Telegram test notification: {e}")
            return {"success": False, "error": str(e)}

    def send_download_complete(
        self,
        title: str,
        site_url: str,
        file_path: str,
        file_size_bytes: int,
        duration: Optional[int] = None,
        resolution: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Sends download completion report with video upload supporting ANY file size (> 50MB, up to 2GB).
        """
        if not self.is_configured():
            return {"success": False, "skipped": True, "error": "Telegram credentials not configured."}

        size_mb = round(file_size_bytes / (1024 * 1024), 2)
        dur_str = f"{duration // 60}:{duration % 60:02d}" if duration else "Unknown"

        safe_title = html.escape(title[:120])
        safe_url = html.escape(site_url)
        safe_res = html.escape(resolution or "Highest Available")

        caption = (
            f"📥 <b>Video Downloaded Successfully!</b>\n\n"
            f"🎬 <b>Title:</b> {safe_title}\n"
            f"📐 <b>Resolution:</b> {safe_res}\n"
            f"⏱ <b>Duration:</b> {dur_str}\n"
            f"💾 <b>File Size:</b> {size_mb} MB\n"
            f"🔗 <b>Source:</b> <code>{safe_url}</code>\n"
        )

        p = Path(file_path)
        if not p.exists():
            return {"success": False, "error": f"File does not exist: {file_path}"}

        # 1. Standard upload for files <= 49.5 MB
        if size_mb <= 49.5:
            return self.upload_video(file_path, caption)

        # 2. Large File Mode (> 49.5 MB)
        logger.info(f"File size ({size_mb} MB) exceeds standard Bot API 50MB limit. Engaging Large File Pipeline...")
        return self.upload_large_video(file_path, caption, title, size_mb)

    def upload_large_video(self, file_path: str, base_caption: str, title: str, size_mb: float) -> Dict[str, Any]:
        """
        Uploads large video (>50MB up to 2GB):
        - Attempts Telethon MTProto upload first if API_ID & API_HASH are provided.
        - Otherwise, losslessly splits the video into <48MB sequential parts with FFmpeg and uploads all parts.
        """
        p = Path(file_path)
        if not p.exists():
            return {"success": False, "error": f"File not found: {file_path}"}

        # Method A: Try MTProto 2GB upload if api_id and api_hash exist
        if self.api_id and self.api_hash:
            try:
                logger.info(f"Attempting MTProto 2GB upload for {p.name} ({size_mb} MB)...")
                mtproto_res = self._upload_via_telethon(file_path, base_caption)
                if mtproto_res.get("success"):
                    logger.info(f"Telethon MTProto upload completed successfully for {p.name}!")
                    return mtproto_res
                else:
                    logger.warning(f"MTProto upload failed: {mtproto_res.get('error')}. Falling back to multi-part splitting.")
            except Exception as e:
                logger.warning(f"Telethon MTProto exception: {e}. Falling back to multi-part splitting.")

        # Method B: Lossless FFmpeg Multi-Part Video Splitting (< 48MB each)
        logger.info(f"Splitting {p.name} ({size_mb} MB) into <48MB parts with FFmpeg...")
        return self._upload_via_ffmpeg_split(file_path, title, base_caption, size_mb)

    def _upload_via_telethon(self, file_path: str, caption: str) -> Dict[str, Any]:
        """
        Connects directly to Telegram MTProto servers via Telethon with the bot token.
        Uses FastTelethon multi-worker parallel upload with 512KB parts for maximum transfer speed.
        Supports single files up to 2,000 MB (2 GB).
        """
        import random
        from telethon import TelegramClient
        from telethon.sessions import MemorySession
        from telethon.tl.types import InputFileBig
        from telethon.tl.functions.upload import SaveBigFilePartRequest, SaveFilePartRequest

        async def _run_upload():
            client = TelegramClient(MemorySession(), int(self.api_id), str(self.api_hash))
            try:
                await client.start(bot_token=self.bot_token)

                target = self.chat_id
                if target.startswith('-') or target.isdigit():
                    target = int(target)
                entity = await client.get_input_entity(target)

                p = Path(file_path)
                file_size = p.stat().st_size
                part_size = 512 * 1024
                total_parts = max(1, (file_size + part_size - 1) // part_size)
                is_big = file_size > 10 * 1024 * 1024
                file_id = random.randint(1, 2**63 - 1)

                logger.info(
                    "FastTelethon parallel MTProto upload: %s (%s MB, %d parts, 6 concurrent workers)...",
                    p.name, round(file_size / (1024 * 1024), 2), total_parts,
                )

                queue = asyncio.Queue()
                for i in range(total_parts):
                    queue.put_nowait(i)
                uploaded_parts = 0
                last_logged_percent = 0

                async def worker():
                    nonlocal uploaded_parts, last_logged_percent
                    with open(file_path, "rb") as f:
                        while True:
                            try:
                                part_index = queue.get_nowait()
                            except asyncio.QueueEmpty:
                                return
                            try:
                                f.seek(part_index * part_size)
                                chunk = f.read(part_size)
                                if not chunk:
                                    continue
                                for attempt in range(3):
                                    try:
                                        if is_big:
                                            req = SaveBigFilePartRequest(
                                                file_id, part_index, total_parts, chunk
                                            )
                                        else:
                                            req = SaveFilePartRequest(
                                                file_id, part_index, chunk
                                            )
                                        await client(req)
                                        uploaded_parts += 1
                                        percent = int(uploaded_parts * 100 / total_parts)
                                        if percent >= last_logged_percent + 10:
                                            last_logged_percent = percent
                                            logger.info(
                                                "Telegram MTProto upload progress: %d%% (%d/%d parts)",
                                                percent, uploaded_parts, total_parts,
                                            )
                                        break
                                    except Exception as part_err:
                                        if attempt == 2:
                                            logger.error(
                                                "Part %d failed after 3 retries: %s",
                                                part_index, part_err,
                                            )
                                            raise
                                        await asyncio.sleep(0.5 * (attempt + 1))
                            finally:
                                queue.task_done()

                worker_count = min(6, total_parts)
                workers = [asyncio.create_task(worker()) for _ in range(worker_count)]
                try:
                    await asyncio.gather(*workers)
                except Exception:
                    for task in workers:
                        if not task.done():
                            task.cancel()
                    await asyncio.gather(*workers, return_exceptions=True)
                    raise

                if is_big:
                    file_handle = InputFileBig(
                        id=file_id, parts=total_parts, name=p.name
                    )
                else:
                    file_handle = await client.upload_file(file_path)

                msg = await client.send_file(
                    entity,
                    file_handle,
                    caption=caption[:1024],
                    supports_streaming=True,
                )
                return msg.id
            finally:
                # Release the MTProto connection even when startup, part
                # transfer, or the final Telegram send fails.
                try:
                    if client.is_connected():
                        await client.disconnect()
                except Exception as disconnect_error:
                    logger.debug("MTProto disconnect cleanup: %s", disconnect_error)

        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            msg_id = loop.run_until_complete(_run_upload())
            return {
                "success": True,
                "method": "telethon_fast_mtproto",
                "message_id": msg_id,
                "message": "Uploaded full file to Telegram via FastTelethon parallel MTProto (up to 2GB support)"
            }
        except Exception as err:
            return {"success": False, "error": str(err)}
        finally:
            loop.close()
            asyncio.set_event_loop(None)

    def _upload_via_ffmpeg_split(self, file_path: str, title: str, base_caption: str, size_mb: float) -> Dict[str, Any]:
        """
        Splits video into stream-copied lossless parts (< 48MB each) and uploads
        each part sequentially to Telegram with connection pooling.
        """
        p = Path(file_path)
        tmp_split_dir = Path("/tmp") / f"tg_split_{p.stem}_{os.getpid()}"
        if tmp_split_dir.exists():
            shutil.rmtree(tmp_split_dir, ignore_errors=True)
        tmp_split_dir.mkdir(parents=True, exist_ok=True)

        try:
            # 1. Get total video duration
            probe_cmd = [
                "ffprobe", "-v", "error",
                "-show_entries", "format=duration,size",
                "-of", "json", str(file_path)
            ]
            res = subprocess.run(probe_cmd, capture_output=True, text=True)
            info = json.loads(res.stdout)["format"]
            duration = float(info.get("duration", 0))
            file_bytes = int(info.get("size", p.stat().st_size))

            # Target 47.0 MB per chunk to stay reliably under 49.5 MB while minimizing chunk count
            target_chunk_bytes = int(47.0 * 1024 * 1024)
            num_parts = max(2, math.ceil(file_bytes / target_chunk_bytes))
            part_duration = max(1.0, duration / num_parts) if duration > 0 else 60.0

            out_pattern = str(tmp_split_dir / "part_%03d.mp4")
            split_cmd = [
                "ffmpeg", "-y", "-i", str(file_path),
                "-c", "copy", "-map", "0",
                "-f", "segment",
                "-segment_time", str(round(part_duration, 2)),
                "-reset_timestamps", "1",
                out_pattern
            ]

            subprocess.run(split_cmd, capture_output=True, check=True)
            parts = sorted(list(tmp_split_dir.glob("part_*.mp4")))

            if not parts:
                return {"success": False, "error": "FFmpeg failed to generate split parts."}

            logger.info(f"Video {p.name} successfully split into {len(parts)} parts for Telegram upload.")

            # Notify channel that a multi-part upload has commenced
            start_notice = (
                f"📦 <b>Uploading Large Video in {len(parts)} Parts</b>\n\n"
                f"🎬 <b>Title:</b> {html.escape(title[:100])}\n"
                f"💾 <b>Total Size:</b> {size_mb} MB\n"
                f"⚡ <i>Sending all parts sequentially...</i>"
            )
            try:
                self.session.post(
                    f"{self.api_base}/sendMessage",
                    json={"chat_id": self.chat_id, "text": start_notice, "parse_mode": "HTML"},
                    timeout=10
                )
            except Exception:
                pass

            uploaded_count = 0
            for idx, part_file in enumerate(parts, 1):
                part_size_mb = round(part_file.stat().st_size / (1024 * 1024), 2)
                part_caption = (
                    f"🎬 <b>{html.escape(title[:80])}</b> [Part {idx}/{len(parts)}]\n"
                    f"💾 Size: {part_size_mb} MB (Total: {size_mb} MB)\n"
                    f"✅ <i>Seamless stream part {idx} of {len(parts)}</i>"
                )
                logger.info(f"Uploading part {idx}/{len(parts)} ({part_size_mb} MB) to Telegram...")
                upload_res = self.upload_video(str(part_file), part_caption)
                if upload_res.get("success"):
                    uploaded_count += 1
                else:
                    logger.error(f"Failed to upload part {idx}: {upload_res.get('error')}")

            return {
                "success": uploaded_count == len(parts),
                "method": "split_multi_part",
                "total_parts": len(parts),
                "uploaded_parts": uploaded_count,
                "message": f"Successfully uploaded {uploaded_count}/{len(parts)} video parts to Telegram."
            }

        except Exception as e:
            logger.error(f"Error during FFmpeg multi-part upload: {e}")
            return {"success": False, "error": f"Splitting upload failed: {str(e)}"}
        finally:
            shutil.rmtree(tmp_split_dir, ignore_errors=True)

    def upload_video(self, file_path: str, caption: str) -> Dict[str, Any]:
        """
        Uploads a video to the Telegram channel via standard Telegram Bot API.
        """
        p = Path(file_path)
        if not p.exists():
            return {"success": False, "error": f"File not found: {file_path}"}

        try:
            with open(file_path, "rb") as f:
                files = {"video": (p.name, f, "video/mp4")}
                data = {
                    "chat_id": self.chat_id,
                    "caption": caption[:1024],
                    "parse_mode": "HTML",
                    "supports_streaming": "true"
                }
                resp = self.session.post(
                    f"{self.api_base}/sendVideo",
                    data=data,
                    files=files,
                    timeout=240
                )
                res_data = resp.json()
                if res_data.get("ok"):
                    return {"success": True, "message_id": res_data["result"]["message_id"]}
                else:
                    return {"success": False, "error": res_data.get("description", "Upload failed")}
        except Exception as e:
            return {"success": False, "error": str(e)}
