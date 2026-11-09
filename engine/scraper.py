import re
import json
import logging
import urllib.parse
import urllib.request
from pathlib import Path
from typing import List, Dict, Any, Optional
from concurrent.futures import ThreadPoolExecutor, as_completed

from scrapling import Fetcher
import yt_dlp


logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("scraper")


class YtDlpQuietLogger:
    """Silence yt-dlp's internal messages."""

    def debug(self, msg):
        pass

    def info(self, msg):
        pass

    def warning(self, msg):
        pass

    def error(self, msg):
        pass


STREAM_REGEXES = [
    re.compile(
        r"""https?://[^\s"'<>]+?\.(?:m3u8|mpd|mp4|webm|mkv|mov)(?:\?[^\s"'<>]*)?""",
        re.IGNORECASE,
    ),
    re.compile(
        r"""["'](https?:\\/\\/[^"'<>]+?\.(?:m3u8|mpd|mp4|webm)[^"'<>]*)["']""",
        re.IGNORECASE,
    ),
    re.compile(
        r"""source\s*:\s*["'](https?://[^"'<>]+)["']""",
        re.IGNORECASE,
    ),
    re.compile(
        r"""file\s*:\s*["'](https?://[^"'<>]+)["']""",
        re.IGNORECASE,
    ),
    re.compile(
        r"""video_url\s*:\s*["'](https?://[^"'<>]+)["']""",
        re.IGNORECASE,
    ),
]

VIDEO_PATH_PATTERNS = [
    re.compile(
        r"/(?:watch|video|videos|v|clip|clips|embed|media|play|player|movie|episode|show|item|post|film|tube)/[^\s\"'<>/?#]+",
        re.IGNORECASE,
    ),
    re.compile(r"[?&](?:v|video|video_id|vid|clip)=[^&\s\"']+", re.IGNORECASE),
    re.compile(r"/archives?/\d+", re.IGNORECASE),
]

COMMON_EMBED_DOMAINS = [
    "youtube.com",
    "youtu.be",
    "vimeo.com",
    "dailymotion.com",
    "bilibili.com",
    "loom.com",
    "streamable.com",
    "twitch.tv",
    "facebook.com",
    "twitter.com",
    "x.com",
    "tiktok.com",
]

# Exclude authentication/checkout pages and non-page assets.
IGNORE_LINK_PATTERNS = [
    re.compile(
        r"/(?:login|signin|signup|register|cart|checkout|privacy-policy|terms-of-service)/?$",
        re.IGNORECASE,
    ),
    re.compile(
        r"\.(?:jpg|jpeg|png|gif|svg|css|js|woff|woff2|ico|pdf|zip|rar|tar|gz)(?:\?.*)?$",
        re.IGNORECASE,
    ),
]


class MediaInspector:
    """
    Universal video scraper, stream sniffer, and deep website crawler.
    Extracts direct media and discovers/crawls video catalog pages.
    """

    def __init__(self, timeout: int = 25, max_workers: int = 8):
        self.timeout = timeout
        self.max_workers = max_workers

    def inspect_url(
        self,
        url: str,
        deep_crawl: bool = True,
        max_subpages: int = 100,
        subpage_offset: int = 0,
    ) -> Dict[str, Any]:
        """
        Inspect a page, discover video subpages, crawl them, and return media.
        Browser recovery is invoked only if normal extraction finds zero videos.
        """
        clean_url = url.strip()
        if not clean_url.startswith(("http://", "https://")):
            clean_url = "https://" + clean_url

        report = {
            "page_url": clean_url,
            "success": False,
            "status_code": None,
            "page_title": "",
            "is_catalog_page": False,
            "subpages_discovered": 0,
            "total_subpages_discovered": 0,
            "subpage_offset": subpage_offset,
            "subpages_scanned": 0,
            "has_more_subpages": False,
            "next_offset": None,
            "remaining_subpages": 0,
            "detected_players": [],
            "streams_found": [],
            "videos": [],
            "error": None,
        }

        # Handle a URL that directly points to a media file or manifest.
        proto_self = self._classify_stream_type(clean_url)
        clean_path_lower = urllib.parse.urlparse(clean_url).path.lower()
        direct_extensions = [
            ".mp4", ".webm", ".mov", ".mkv", ".m4v", ".flv",
            ".avi", ".ts", ".3gp", ".m3u8", ".mpd",
        ]
        is_direct_media = (
            proto_self in (
                "HLS (M3U8)", "MPEG-DASH (MPD)", "MP4 Direct",
                "WebM", "MOV QuickTime", "MKV Matroska", "Direct Media",
            )
            or any(clean_path_lower.endswith(ext) for ext in direct_extensions)
        )

        if is_direct_media:
            name = Path(urllib.parse.urlparse(clean_url).path).name or "Direct Media Stream"
            report["detected_players"].append(f"Direct Media File ({proto_self})")
            report["streams_found"].append(
                {"url": clean_url, "type": proto_self, "poster": None}
            )
            report["videos"].append(
                self._synthesize_video_item(clean_url, clean_url, name, None)
            )
            report["success"] = True
            report["status_code"] = 200
            report["page_title"] = name
            return report

        html_text = ""
        discovered_video_links = set()

        # Normal, lightweight extraction path.
        try:
            logger.info(
                "Scrapling Fetcher requesting root page with stealth headers: %s",
                clean_url,
            )
            page = Fetcher.get(
                clean_url,
                impersonate="chrome",
                stealthy_headers=True,
                timeout=self.timeout,
            )
            report["status_code"] = getattr(page, "status", 200)
            html_text = getattr(page, "text", "") or ""

            title_nodes = page.css("title::text").getall()
            if title_nodes:
                report["page_title"] = title_nodes[0].strip()

            # HTML5 video elements.
            video_tags = page.css("video")
            if video_tags:
                report["detected_players"].append("HTML5 <video> Player")

            for video_node in video_tags:
                src = video_node.attrib.get("src")
                poster = video_node.attrib.get("poster")

                if src:
                    report["streams_found"].append(
                        {
                            "url": urllib.parse.urljoin(clean_url, src),
                            "type": "direct_video",
                            "poster": urllib.parse.urljoin(clean_url, poster) if poster else None,
                        }
                    )

                for source_node in video_node.css("source"):
                    source_src = source_node.attrib.get("src")
                    source_type = source_node.attrib.get("type", "")
                    if source_src:
                        report["streams_found"].append(
                            {
                                "url": urllib.parse.urljoin(clean_url, source_src),
                                "type": source_type or "source_tag",
                                "poster": urllib.parse.urljoin(clean_url, poster) if poster else None,
                            }
                        )

            # Known-provider iframe embeds.
            for iframe in page.css("iframe"):
                iframe_src = iframe.attrib.get("src") or iframe.attrib.get("data-src")
                if iframe_src:
                    full_iframe = urllib.parse.urljoin(clean_url, iframe_src)
                    iframe_host = urllib.parse.urlparse(full_iframe).netloc.lower()
                    for domain in COMMON_EMBED_DOMAINS:
                        if domain in iframe_host:
                            report["detected_players"].append(
                                f"Embedded Player ({domain})"
                            )
                            report["streams_found"].append(
                                {
                                    "url": full_iframe,
                                    "type": f"iframe_embed_{domain}",
                                    "poster": None,
                                }
                            )
                            break

            # JSON-LD structured data.
            scripts = page.css('script[type="application/ld+json"]::text').getall()
            for script in scripts:
                try:
                    data = json.loads(script)
                    self._extract_jsonld_videos(data, clean_url, report)
                except Exception:
                    pass

            # OpenGraph and Twitter video metadata.
            og_video = page.css(
                'meta[property="og:video"]::attr(content), '
                'meta[property="og:video:url"]::attr(content), '
                'meta[name="twitter:player"]::attr(content)'
            ).getall()

            for video_url in og_video:
                if video_url:
                    report["streams_found"].append(
                        {
                            "url": urllib.parse.urljoin(clean_url, video_url),
                            "type": "og_video_meta",
                            "poster": None,
                        }
                    )

            # Sniff media URLs in the returned HTML.
            for stream_url in self._sniff_streams_from_html(html_text, clean_url):
                report["streams_found"].append(
                    {
                        "url": stream_url,
                        "type": self._classify_stream_type(stream_url),
                        "poster": None,
                    }
                )

            # Discover likely video subpages. Preserve the existing same-site
            # rule in the normal path; the emergency browser path can inspect
            # external video-card links if this path finds nothing.
            all_anchors = page.css("a")
            base_domain = urllib.parse.urlparse(clean_url).netloc

            for anchor in all_anchors:
                raw_href = anchor.attrib.get("href")
                if not raw_href or raw_href.startswith(
                    ("#", "javascript:", "mailto:", "tel:")
                ):
                    continue

                full_href = urllib.parse.urljoin(clean_url, raw_href).split("#")[0]
                parsed_href = urllib.parse.urlparse(full_href)

                is_same_domain = parsed_href.netloc == base_domain
                is_known_video_host = any(
                    domain in parsed_href.netloc.lower()
                    for domain in COMMON_EMBED_DOMAINS
                )
                if not is_same_domain and not is_known_video_host:
                    continue

                if any(pattern.search(parsed_href.path) for pattern in IGNORE_LINK_PATTERNS):
                    continue

                is_video_path = any(
                    pattern.search(full_href) for pattern in VIDEO_PATH_PATTERNS
                )
                classes = anchor.attrib.get("class", "").lower()
                has_video_class = any(
                    word in classes
                    for word in ("video", "thumb", "player", "movie", "clip", "card")
                )
                has_image_child = bool(anchor.css("img"))

                if (
                    is_video_path
                    or has_video_class
                    or (
                        is_same_domain
                        and has_image_child
                        and len(parsed_href.path) > 3
                    )
                ):
                    if full_href not in (clean_url, clean_url + "/"):
                        discovered_video_links.add(full_href)

        except Exception as exc:
            logger.warning("Scrapling fetch encountered issue: %s", exc)
            if not report["error"]:
                report["error"] = str(exc)

        # yt-dlp check for the root URL.
        yt_videos = self._inspect_with_ytdlp(clean_url)
        if yt_videos:
            report["videos"].extend(yt_videos)
            report["detected_players"].append("yt-dlp Extractor Engine")

        # Crawl discovered subpages.
        discovered_list = sorted(discovered_video_links)
        total_discovered = len(discovered_list)
        report["total_subpages_discovered"] = total_discovered
        report["subpages_discovered"] = total_discovered
        report["subpage_offset"] = subpage_offset

        if total_discovered:
            report["is_catalog_page"] = True
            report["detected_players"].append(
                f"Website Video Catalog ({total_discovered} subpages found)"
            )

        if max_subpages <= 0 or max_subpages >= 99999:
            subpages_to_crawl = discovered_list[subpage_offset:]
        else:
            subpages_to_crawl = discovered_list[
                subpage_offset:subpage_offset + max_subpages
            ]

        has_more = (
            subpage_offset + len(subpages_to_crawl)
        ) < total_discovered

        report["has_more_subpages"] = has_more
        report["next_offset"] = (
            subpage_offset + len(subpages_to_crawl) if has_more else None
        )
        report["remaining_subpages"] = max(
            0, total_discovered - (subpage_offset + len(subpages_to_crawl))
        )
        report["subpages_scanned"] = len(subpages_to_crawl)

        if deep_crawl and subpages_to_crawl:
            logger.info(
                "Crawling %d discovered video subpages (offset: %d, total: %d)...",
                len(subpages_to_crawl),
                subpage_offset,
                total_discovered,
            )
            with ThreadPoolExecutor(max_workers=self.max_workers) as executor:
                future_to_url = {
                    executor.submit(self._inspect_single_subpage, sub_url): sub_url
                    for sub_url in subpages_to_crawl
                }
                for future in as_completed(future_to_url):
                    sub_url = future_to_url[future]
                    try:
                        sub_videos = future.result()
                        if sub_videos:
                            report["videos"].extend(sub_videos)
                    except Exception as err:
                        logger.debug(
                            "Subpage inspection failed for %s: %s", sub_url, err
                        )

        # Convert root-page streams into video records if needed.
        if not report["videos"] and report["streams_found"]:
            for item in report["streams_found"][:15]:
                report["videos"].append(
                    self._synthesize_video_item(
                        item["url"],
                        clean_url,
                        report["page_title"],
                        item.get("poster"),
                    )
                )

        # Expensive recovery is strictly zero-video-only. First inspect the
        # already-discovered detail pages for outbound player destinations.
        if len(report["videos"]) == 0 and discovered_list:
            logger.warning(
                "Normal extraction returned ZERO videos. Checking outbound player destinations."
            )
            external_recovered = self._zero_video_external_destination_recovery(
                discovered_list
            )
            if external_recovered:
                report["videos"].extend(external_recovered)
                report["detected_players"].append(
                    "External Destination Recovery"
                )

        # Browser recovery remains the final zero-video-only fallback.
        if len(report["videos"]) == 0:
            logger.warning(
                "Normal extraction returned ZERO videos. "
                "Activating emergency browser recovery."
            )
            recovered = self._zero_video_browser_recovery(
                clean_url, discovered_list
            )
            if recovered:
                report["videos"].extend(recovered)
                report["detected_players"].append(
                    "Emergency Browser Recovery"
                )

        # Deduplicate videos by media URL or page URL.
        unique_videos = []
        seen_urls = set()
        for video in report["videos"]:
            media_url = video.get("media_url") or video.get("page_url")
            if media_url and media_url not in seen_urls:
                seen_urls.add(media_url)
                unique_videos.append(video)
        report["videos"] = unique_videos

        report["success"] = (
            len(report["videos"]) > 0
            or len(report["streams_found"]) > 0
            or report["subpages_discovered"] > 0
        )
        report["detected_players"] = sorted(set(report["detected_players"]))
        return report

    def _resolve_http_redirect(self, target_url: str) -> Optional[str]:
        """Resolve ordinary HTTP redirects; reserved for zero-video fallback."""
        try:
            parsed = urllib.parse.urlparse(target_url)
            if parsed.scheme not in ("http", "https"):
                return None

            request = urllib.request.Request(
                target_url,
                headers={
                    "User-Agent": (
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                        "AppleWebKit/537.36 Chrome/120.0 Safari/537.36"
                    )
                },
            )
            with urllib.request.urlopen(request, timeout=8) as response:
                return response.geturl()

        except Exception as exc:
            logger.debug(
                "Redirect recovery could not resolve %s: %s", target_url, exc
            )
            return None

    def _zero_video_redirect_recovery(
        self,
        root_url: str,
        discovered_urls: List[str],
    ) -> List[Dict[str, Any]]:
        """Resolve redirects and retry extraction; not used on normal success."""
        recovered_videos = []
        candidates = list(dict.fromkeys([root_url] + discovered_urls))

        for original_url in candidates[:12]:
            final_url = self._resolve_http_redirect(original_url)
            if not final_url or final_url == original_url:
                continue

            logger.warning(
                "ZERO-VIDEO FALLBACK: redirect detected: %s -> %s",
                original_url,
                final_url,
            )
            try:
                videos = self._inspect_single_subpage(final_url)
                if videos:
                    recovered_videos.extend(videos)
                    logger.info(
                        "ZERO-VIDEO FALLBACK recovered %d video(s) from %s",
                        len(videos),
                        final_url,
                    )
            except Exception as exc:
                logger.warning(
                    "ZERO-VIDEO FALLBACK failed for %s: %s",
                    final_url,
                    exc,
                )

        return recovered_videos

    def _zero_video_external_destination_recovery(
        self, discovered_urls: List[str],
    ) -> List[Dict[str, Any]]:
        """
        Last-resort, zero-video-only pass for detail pages that link to an
        external player instead of embedding the media in their own HTML.
        It follows ordinary video/player links only; it does not click ads.
        """
        recovered: List[Dict[str, Any]] = []
        root_hosts = {
            (urllib.parse.urlparse(url).hostname or "").lower()
            for url in discovered_urls
        }
        video_words = (
            "watch", "play", "video", "stream", "player",
            "embed", "movie", "view",
        )
        blocked_words = (
            "advert", "sponsor", "banner", "popup",
            "doubleclick", "analytics", "tracking",
        )
        candidates: List[str] = []
        seen_candidates = set()

        # Detail pages are already known from normal catalog discovery.
        # Only revisit a bounded number when normal extraction found nothing.
        for detail_url in discovered_urls[:20]:
            try:
                page = Fetcher.get(
                    detail_url,
                    impersonate="chrome",
                    stealthy_headers=True,
                    timeout=10,
                )
                for anchor in page.css("a"):
                    raw_href = anchor.attrib.get("href")
                    if not raw_href or raw_href.startswith((
                        "#", "javascript:", "mailto:", "tel:",
                    )):
                        continue
                    destination = urllib.parse.urljoin(detail_url, raw_href)
                    parsed = urllib.parse.urlparse(destination)
                    host = (parsed.hostname or "").lower()
                    if parsed.scheme not in ("http", "https") or not host:
                        continue
                    if host in root_hosts:
                        continue
                    description = " ".join([
                        " ".join(anchor.css("::text").getall()),
                        str(anchor.attrib.get("class", "")),
                        str(anchor.attrib.get("title", "")),
                        str(anchor.attrib.get("aria-label", "")),
                        parsed.path,
                    ]).lower()
                    if any(word in destination.lower() for word in blocked_words):
                        continue
                    if any(word in description for word in blocked_words):
                        continue
                    if not any(word in description for word in video_words):
                        continue
                    if destination not in seen_candidates:
                        seen_candidates.add(destination)
                        candidates.append(destination)

                # Some detail pages point to the external player in an iframe.
                for iframe in page.css("iframe"):
                    raw_src = iframe.attrib.get("src") or iframe.attrib.get("data-src")
                    if not raw_src:
                        continue
                    destination = urllib.parse.urljoin(detail_url, raw_src)
                    parsed = urllib.parse.urlparse(destination)
                    host = (parsed.hostname or "").lower()
                    if (
                        parsed.scheme in ("http", "https")
                        and host
                        and host not in root_hosts
                        and not any(word in destination.lower() for word in blocked_words)
                        and destination not in seen_candidates
                    ):
                        seen_candidates.add(destination)
                        candidates.append(destination)
            except Exception as exc:
                logger.debug(
                    "External destination discovery failed for %s: %s",
                    detail_url, exc,
                )

        logger.info(
            "Zero-video external destination pass found %d candidate player URL(s).",
            len(candidates),
        )
        for index, destination in enumerate(candidates[:12], start=1):
            logger.info(
                "Inspecting external player destination %d/12: %s",
                index, destination,
            )
            try:
                videos = self._inspect_single_subpage(destination)
                if videos:
                    recovered.extend(videos)
                    logger.info(
                        "External destination yielded %d video(s): %s",
                        len(videos), destination,
                    )
                    break
            except Exception as exc:
                logger.warning(
                    "External destination inspection failed for %s: %s",
                    destination, exc,
                )
        return recovered
    def _zero_video_browser_recovery(
        self,
        root_url: str,
        discovered_urls: List[str],
    ) -> List[Dict[str, Any]]:
        """
        Domain-independent browser recovery, called only after zero normal results.

        It discovers likely video-card links, including external destinations,
        navigates to those URLs directly, and inspects the resulting pages.
        It does not click advertisements or attempt to defeat access controls.
        """
        recovered: List[Dict[str, Any]] = []

        try:
            from scrapling.fetchers import StealthyFetcher
        except Exception as exc:
            logger.warning("Browser recovery unavailable: %s", exc)
            return recovered

        def register_popup_handler(page):
            def close_popup(popup):
                try:
                    popup.close()
                    logger.info("Recovery closed an unsolicited popup tab.")
                except Exception as exc:
                    logger.debug("Popup close failed: %s", exc)

            page.on("popup", close_popup)

        def inspect_rendered_page(page, source_url):
            found = []
            try:
                final_url = page.url
                title = page.title() or "Detected Video"
                html = page.content()

                video_items = page.locator("video").evaluate_all(
                    """videos => videos.map(v => ({
                        src: v.getAttribute('src'),
                        poster: v.getAttribute('poster'),
                        sources: Array.from(v.querySelectorAll('source'))
                            .map(s => s.getAttribute('src'))
                            .filter(Boolean)
                    }))"""
                )

                for item in video_items:
                    poster = item.get("poster")
                    poster = (
                        urllib.parse.urljoin(final_url, poster)
                        if poster else None
                    )
                    media_urls = []
                    if item.get("src"):
                        media_urls.append(item["src"])
                    media_urls.extend(item.get("sources", []))

                    for media_url in media_urls:
                        absolute_url = urllib.parse.urljoin(
                            final_url, media_url
                        )
                        if absolute_url.startswith(("http://", "https://")):
                            found.append(
                                self._synthesize_video_item(
                                    absolute_url, final_url, title, poster
                                )
                            )

                for media_url in self._sniff_streams_from_html(html, final_url):
                    found.append(
                        self._synthesize_video_item(
                            media_url, final_url, title, None
                        )
                    )

                logger.info(
                    "Inspected destination %s: found %d media candidate(s).",
                    final_url,
                    len(found),
                )
            except Exception as exc:
                logger.warning(
                    "Could not inspect destination %s: %s", source_url, exc
                )
            return found

        def collect_video_links(page):
            links = []
            try:
                anchors = page.locator("a").evaluate_all(
                    """items => items.map(a => ({
                        href: a.href,
                        text: (a.innerText || '').trim(),
                        className: a.className || '',
                        title: a.getAttribute('title') || '',
                        aria: a.getAttribute('aria-label') || '',
                        hasImage: !!a.querySelector('img, picture'),
                        hasVideo: !!a.querySelector('video')
                    }))"""
                )

                for item in anchors:
                    href = (item.get("href") or "").strip()
                    if not href.startswith(("http://", "https://")):
                        continue

                    parsed = urllib.parse.urlparse(href)
                    if parsed.scheme not in ("http", "https"):
                        continue

                    description = " ".join(
                        [
                            item.get("text", ""),
                            str(item.get("className", "")),
                            item.get("title", ""),
                            item.get("aria", ""),
                        ]
                    ).lower()

                    blocked_words = (
                        "advert", "sponsor", "banner", "popup",
                        "doubleclick", "analytics", "tracking",
                    )
                    if any(word in href.lower() for word in blocked_words):
                        continue
                    if any(word in description for word in blocked_words):
                        continue

                    video_indicators = (
                        "video", "watch", "play", "movie",
                        "episode", "clip", "player", "film",
                    )
                    looks_like_video = (
                        any(word in description for word in video_indicators)
                        or any(
                            pattern.search(href)
                            for pattern in VIDEO_PATH_PATTERNS
                        )
                        or item.get("hasVideo")
                        or item.get("hasImage")
                    )
                    if looks_like_video:
                        links.append(href)

            except Exception as exc:
                logger.warning("Video-link discovery failed: %s", exc)

            return list(dict.fromkeys(links))

        def browser_recovery_action(page):
            page.wait_for_timeout(1200)

            candidates = collect_video_links(page)
            candidates.extend(discovered_urls)
            candidates = list(dict.fromkeys(candidates))

            logger.info(
                "Browser recovery discovered %d candidate video links.",
                len(candidates),
            )

            recovered.extend(inspect_rendered_page(page, root_url))

            for index, candidate in enumerate(candidates[:12], start=1):
                if recovered:
                    break

                logger.warning(
                    "Browser recovery attempt %d/12: %s", index, candidate
                )
                try:
                    response = page.goto(
                        candidate,
                        wait_until="domcontentloaded",
                        timeout=15000,
                    )
                    status = (
                        response.status if response is not None else None
                    )
                    logger.info(
                        "Destination attempt %d returned HTTP %s; browser URL: %s",
                        index,
                        status,
                        page.url,
                    )

                    page.wait_for_timeout(1500)
                    recovered.extend(
                        inspect_rendered_page(page, candidate)
                    )

                    if not recovered:
                        try:
                            extracted = self._inspect_with_ytdlp(page.url)
                            if extracted:
                                recovered.extend(extracted)
                                logger.info(
                                    "yt-dlp recovered %d video(s) from %s",
                                    len(extracted),
                                    page.url,
                                )
                        except Exception as extract_error:
                            logger.debug(
                                "yt-dlp destination inspection failed: %s",
                                extract_error,
                            )

                except Exception as exc:
                    logger.warning(
                        "Destination attempt %d failed for %s: %s",
                        index,
                        candidate,
                        exc,
                    )
            return page

        try:
            logger.warning(
                "Starting zero-video browser recovery for %s", root_url
            )
            browser_response = StealthyFetcher.fetch(
                root_url,
                headless=True,
                # Keep this last-resort attempt bounded; avoid three full retries.
                timeout=12000,
                retries=1,
                retry_delay=0,
                network_idle=False,
                disable_resources=False,
                page_setup=register_popup_handler,
                page_action=browser_recovery_action,
            )

            if browser_response is not None and not recovered:
                final_url = getattr(browser_response, "url", None) or root_url
                html = getattr(browser_response, "text", "") or ""
                title_nodes = browser_response.css("title::text").getall()
                title = (
                    title_nodes[0].strip()
                    if title_nodes else "Detected Video"
                )
                for media_url in self._sniff_streams_from_html(
                    html, final_url
                ):
                    recovered.append(
                        self._synthesize_video_item(
                            media_url, final_url, title, None
                        )
                    )

        except Exception as exc:
            logger.warning("Emergency browser recovery failed: %s", exc)

        unique = []
        seen_media = set()
        for video in recovered:
            media_url = video.get("media_url") or video.get("page_url")
            if media_url and media_url not in seen_media:
                seen_media.add(media_url)
                unique.append(video)

        logger.info(
            "Emergency browser recovery finished: %d video(s) recovered.",
            len(unique),
        )
        return unique

    def _inspect_single_subpage(
        self, sub_url: str
    ) -> List[Dict[str, Any]]:
        """Inspect an individual discovered video page."""
        videos = self._inspect_with_ytdlp(sub_url)
        if videos:
            return videos

        results = []
        try:
            page = Fetcher.get(
                sub_url,
                impersonate="chrome",
                stealthy_headers=True,
                timeout=12,
            )
            html = getattr(page, "text", "") or ""
            title_nodes = page.css("title::text").getall()
            title = (
                title_nodes[0].strip()
                if title_nodes
                else Path(urllib.parse.urlparse(sub_url).path).name
            )

            for video_node in page.css("video"):
                src = video_node.attrib.get("src")
                poster = video_node.attrib.get("poster")
                if src:
                    full_src = urllib.parse.urljoin(sub_url, src)
                    results.append(
                        self._synthesize_video_item(
                            full_src, sub_url, title, poster
                        )
                    )

                for source_node in video_node.css("source"):
                    source_src = source_node.attrib.get("src")
                    if source_src:
                        full_source = urllib.parse.urljoin(
                            sub_url, source_src
                        )
                        results.append(
                            self._synthesize_video_item(
                                full_source, sub_url, title, poster
                            )
                        )

            for stream_url in self._sniff_streams_from_html(html, sub_url)[:3]:
                results.append(
                    self._synthesize_video_item(
                        stream_url, sub_url, title, None
                    )
                )

            for iframe in page.css("iframe"):
                iframe_src = iframe.attrib.get("src") or iframe.attrib.get("data-src")
                if iframe_src:
                    full_iframe = urllib.parse.urljoin(sub_url, iframe_src)
                    iframe_host = urllib.parse.urlparse(full_iframe).netloc.lower()
                    if any(domain in iframe_host for domain in COMMON_EMBED_DOMAINS):
                        embedded = self._inspect_with_ytdlp(full_iframe)
                        if embedded:
                            results.extend(embedded)

        except Exception as exc:
            logger.debug("Subpage parse error for %s: %s", sub_url, exc)

        return results

    def _extract_jsonld_videos(
        self, data: Any, base_url: str, report: Dict[str, Any]
    ):
        if isinstance(data, list):
            for item in data:
                self._extract_jsonld_videos(item, base_url, report)

        elif isinstance(data, dict):
            item_type = data.get("@type")
            if item_type == "VideoObject" or "video" in str(item_type).lower():
                content_url = data.get("contentUrl") or data.get("embedUrl")
                if content_url:
                    full_url = urllib.parse.urljoin(base_url, content_url)
                    report["detected_players"].append("JSON-LD VideoObject")
                    thumbnail_data = data.get("thumbnail")
                    if isinstance(thumbnail_data, list):
                        thumbnail_data = (
                            thumbnail_data[0] if thumbnail_data else None
                        )

                    report["videos"].append(
                        {
                            "id": f"jsonld_{abs(hash(full_url)) % 1000000}",
                            "title": (
                                data.get("name")
                                or report.get("page_title")
                                or "Embedded Media Video"
                            ),
                            "media_url": full_url,
                            "page_url": base_url,
                            "thumbnail": data.get("thumbnailUrl") or thumbnail_data,
                            "duration": self._parse_iso_duration(
                                data.get("duration")
                            ),
                            "resolution": "Auto (Manifest/Direct)",
                            "format": "MP4/Stream",
                            "protocol": self._classify_stream_type(full_url),
                            "formats_available": [
                                {
                                    "format_id": "direct",
                                    "resolution": "Original",
                                    "ext": "mp4",
                                    "note": "Direct stream",
                                }
                            ],
                        }
                    )

            for value in data.values():
                if isinstance(value, (dict, list)):
                    self._extract_jsonld_videos(value, base_url, report)

    def _parse_iso_duration(self, iso_str: Optional[str]) -> Optional[int]:
        if not iso_str or not isinstance(iso_str, str):
            return None
        match = re.match(
            r"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", iso_str
        )
        if match:
            hours = int(match.group(1) or 0)
            minutes = int(match.group(2) or 0)
            seconds = int(match.group(3) or 0)
            return hours * 3600 + minutes * 60 + seconds
        return None

    def _sniff_streams_from_html(
        self, html: str, base_url: str
    ) -> List[str]:
        found = set()
        for regex in STREAM_REGEXES:
            for match in regex.findall(html):
                raw_url = match if isinstance(match, str) else match[0]
                clean_url = raw_url.replace(r"\/", "/")
                if clean_url.startswith("//"):
                    clean_url = "https:" + clean_url
                elif clean_url.startswith("/"):
                    clean_url = urllib.parse.urljoin(base_url, clean_url)
                if clean_url.startswith(("http://", "https://")):
                    found.add(clean_url)
        return list(found)

    def _classify_stream_type(self, url: str) -> str:
        clean_url = url.lower().split("?")[0].split("#")[0]
        if ".m3u8" in clean_url:
            return "HLS (M3U8)"
        if ".mpd" in clean_url:
            return "MPEG-DASH (MPD)"
        if ".mp4" in clean_url:
            return "MP4 Direct"
        if ".webm" in clean_url:
            return "WebM"
        if ".mov" in clean_url:
            return "MOV QuickTime"
        if ".mkv" in clean_url:
            return "MKV Matroska"
        if any(
            clean_url.endswith(ext)
            for ext in (".ts", ".flv", ".avi", ".m4v", ".3gp")
        ):
            return "Direct Media"
        return "Stream/Media"

    def _inspect_with_ytdlp(
        self, target_url: str
    ) -> List[Dict[str, Any]]:
        clean_url = target_url.lower().split("?")[0]
        direct_extensions = (
            ".m3u8", ".mpd", ".mp4", ".webm", ".mov", ".mkv", ".ts"
        )
        if any(clean_url.endswith(ext) for ext in direct_extensions):
            return [
                self._synthesize_video_item(
                    target_url,
                    target_url,
                    Path(urllib.parse.urlparse(target_url).path).name
                    or "Direct Media Stream",
                    None,
                )
            ]

        ydl_options = {
            "quiet": True,
            "no_warnings": True,
            "skip_download": True,
            "extract_flat": "in_playlist",
            "socket_timeout": 15,
            "ignoreerrors": True,
            "logger": YtDlpQuietLogger(),
        }

        results = []
        try:
            with yt_dlp.YoutubeDL(ydl_options) as ydl:
                info = ydl.extract_info(target_url, download=False)
                if not info:
                    return []

                entries = info.get("entries") if "entries" in info else [info]

                for entry in entries:
                    if not entry:
                        continue

                    video_id = entry.get("id") or str(
                        abs(hash(entry.get("webpage_url", target_url))) % 1000000
                    )
                    title = entry.get("title") or "Discovered Media Stream"
                    duration = entry.get("duration")
                    thumbnail = entry.get("thumbnail")
                    formats = entry.get("formats", [])

                    format_options = []
                    best_resolution = None

                    for item in formats:
                        height = item.get("height")
                        width = item.get("width")
                        ext = item.get("ext", "mp4")
                        format_id = item.get("format_id", "")
                        video_codec = item.get("vcodec", "none")
                        audio_codec = item.get("acodec", "none")
                        filesize = item.get("filesize") or item.get("filesize_approx")
                        filesize_mb = (
                            round(filesize / (1024 * 1024), 1)
                            if filesize else None
                        )

                        resolution = (
                            f"{height}p"
                            if height
                            else (
                                f"{width}x{height}"
                                if width and height else "Auto"
                            )
                        )

                        if height and (
                            best_resolution is None
                            or height > int(best_resolution.replace("p", ""))
                        ):
                            best_resolution = f"{height}p"

                        format_options.append(
                            {
                                "format_id": format_id,
                                "resolution": resolution,
                                "ext": ext,
                                "vcodec": video_codec,
                                "acodec": audio_codec,
                                "filesize_mb": filesize_mb,
                                "note": item.get("format_note")
                                or f"{resolution} ({ext})",
                            }
                        )

                    if not format_options:
                        format_options.append(
                            {
                                "format_id": "best",
                                "resolution": "Original",
                                "ext": "mp4",
                                "note": "Highest Available Quality",
                            }
                        )

                    media_url = entry.get("url") or target_url
                    results.append(
                        {
                            "id": str(video_id),
                            "title": title,
                            "media_url": media_url,
                            "page_url": entry.get("webpage_url") or target_url,
                            "thumbnail": thumbnail,
                            "duration": int(duration) if duration else None,
                            "resolution": best_resolution or "Auto",
                            "format": entry.get("ext", "mp4").upper(),
                            "protocol": self._classify_stream_type(media_url),
                            "formats_available": format_options[:15],
                            "uploader": entry.get("uploader") or entry.get("channel"),
                            "subtitles": list((entry.get("subtitles") or {}).keys()),
                        }
                    )

        except Exception as exc:
            logger.debug("yt-dlp probe info: %s", exc)

        return results

    def _synthesize_video_item(
        self,
        media_url: str,
        page_url: str,
        page_title: str,
        poster: Optional[str] = None,
    ) -> Dict[str, Any]:
        name = Path(urllib.parse.urlparse(media_url).path).name
        clean_title = (
            name
            if name and "." in name
            else (page_title or "Detected Video Stream")
        )
        protocol = self._classify_stream_type(media_url)

        return {
            "id": f"vid_{abs(hash(media_url)) % 1000000}",
            "title": clean_title,
            "media_url": media_url,
            "page_url": page_url,
            "thumbnail": poster,
            "duration": None,
            "resolution": "Adaptive / Best",
            "format": "MP4",
            "protocol": protocol,
            "formats_available": [
                {
                    "format_id": "best",
                    "resolution": "Original / Adaptive",
                    "ext": "mp4",
                    "note": f"{protocol} Stream",
                }
            ],
            "uploader": None,
            "subtitles": [],
        }
