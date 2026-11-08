import re
import json
import logging
import urllib.parse
import urllib.request
from pathlib import Path
from typing import List, Dict, Any, Optional, Set
from concurrent.futures import ThreadPoolExecutor, as_completed
from scrapling import Fetcher
import yt_dlp

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("scraper")

class YtDlpQuietLogger:
    """Silences yt-dlp internal stderr logs for non-extractor URLs handled by Scrapling."""
    def debug(self, msg):
        pass
    def info(self, msg):
        pass
    def warning(self, msg):
        pass
    def error(self, msg):
        # Silence generic unsupported URL or extractor errors so user is not confused
        pass

STREAM_REGEXES = [
    re.compile(r'https?://[^\s"\'<>]+\.(?:m3u8|mpd|mp4|webm|mkv|mov)(?:\?[^\s"\'<>]*)?', re.IGNORECASE),
    re.compile(r'["\'](https?:\\?/\\?/[^\s"\'<>]+\.(?:m3u8|mpd|mp4|webm)[^\s"\'<>]*)["\']', re.IGNORECASE),
    re.compile(r'source\s*:\s*["\'](https?://[^\s"\'<>]+)["\']', re.IGNORECASE),
    re.compile(r'file\s*:\s*["\'](https?://[^\s"\'<>]+)["\']', re.IGNORECASE),
    re.compile(r'video_url\s*:\s*["\'](https?://[^\s"\'<>]+)["\']', re.IGNORECASE)
]

VIDEO_PATH_PATTERNS = [
    re.compile(r'/(?:watch|video|videos|v|clip|clips|embed|media|play|player|movie|episode|show|item|post|film|tube)/[^\s"\'<>/?#]+', re.IGNORECASE),
    re.compile(r'[?&](?:v|video|video_id|vid|clip)=[^&\s"\']+', re.IGNORECASE),
    re.compile(r'/archives?/\d+', re.IGNORECASE)
]

COMMON_EMBED_DOMAINS = [
    "youtube.com", "youtu.be", "vimeo.com", "dailymotion.com",
    "bilibili.com", "loom.com", "streamable.com", "twitch.tv",
    "facebook.com", "twitter.com", "x.com", "tiktok.com"
]

# Only exclude true auth/checkout dead ends; keep category, tag, author, topic feeds so all videos can be scraped
IGNORE_LINK_PATTERNS = [
    re.compile(r'/(?:login|signin|signup|register|cart|checkout|privacy-policy|terms-of-service)/?$', re.IGNORECASE),
    re.compile(r'\.(?:jpg|jpeg|png|gif|svg|css|js|woff|woff2|ico|pdf|zip|rar|tar|gz)(?:\?.*)?$', re.IGNORECASE)
]

class MediaInspector:
    """
    Universal Video Scraper, Stream Sniffer, and Deep Website Crawler.
    Extracts direct media on single pages AND discovers/crawls whole website catalogs,
    channel feeds, playlists, and video articles nonstop with pagination support.
    """

    def __init__(self, timeout: int = 25, max_workers: int = 8):
        self.timeout = timeout
        self.max_workers = max_workers

    def inspect_url(
        self,
        url: str,
        deep_crawl: bool = True,
        max_subpages: int = 100,
        subpage_offset: int = 0
    ) -> Dict[str, Any]:
        """
        Comprehensive inspection:
        1. Analyzes the target website page for direct media (<video>, stream regexes, JSON-LD, embeds).
        2. Detects if the page is a video listing / catalog / channel / index with linked video subpages.
        3. If deep_crawl is True (or root page has no direct media), discovers all video subpages on the website.
        4. Concurrently crawls the discovered subpages to extract their playable media streams (MP4/HLS/DASH).
        5. Deduplicates and returns all processable video sources.
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
            "error": None
        }

        # Check if URL itself is a direct media stream
        proto_self = self._classify_stream_type(clean_url)
        clean_path_lower = urllib.parse.urlparse(clean_url).path.lower()
        is_direct_media = (
            proto_self in ("HLS (M3U8)", "MPEG-DASH (MPD)", "MP4 Direct", "WebM", "MOV QuickTime", "MKV Matroska", "Direct Media")
            or any(clean_path_lower.endswith(ext) for ext in [".mp4", ".webm", ".mov", ".mkv", ".m4v", ".flv", ".avi", ".ts", ".3gp", ".m3u8", ".mpd"])
        )

        if is_direct_media:
            p_name = Path(urllib.parse.urlparse(clean_url).path).name or "Direct Media Stream"
            report["detected_players"].append(f"Direct Media File ({proto_self})")
            report["streams_found"].append({"url": clean_url, "type": proto_self, "poster": None})
            report["videos"].append(self._synthesize_video_item(
                clean_url, clean_url, p_name, None
            ))
            report["success"] = True
            report["status_code"] = 200
            report["page_title"] = p_name
            return report

        # Step 1: Scrapling fetch root page with Chrome TLS impersonation
        html_text = ""
        discovered_video_links = set()
        try:
            logger.info(f"Scrapling Fetcher requesting root page with stealth headers: {clean_url}")
            page = Fetcher.get(clean_url, impersonate="chrome", stealthy_headers=True, timeout=self.timeout)
            report["status_code"] = getattr(page, "status", 200)
            html_text = getattr(page, "text", "") or ""

            # Extract title
            title_nodes = page.css("title::text").getall()
            if title_nodes:
                report["page_title"] = title_nodes[0].strip()

            # Inspect DOM for direct HTML5 <video> elements
            video_tags = page.css("video")
            if video_tags:
                report["detected_players"].append("HTML5 <video> Player")
                for v in video_tags:
                    src = v.attrib.get("src")
                    poster = v.attrib.get("poster")
                    if src:
                        full_src = urllib.parse.urljoin(clean_url, src)
                        report["streams_found"].append({
                            "url": full_src,
                            "type": "direct_video",
                            "poster": urllib.parse.urljoin(clean_url, poster) if poster else None
                        })
                    sources = v.css("source")
                    for s in sources:
                        s_src = s.attrib.get("src")
                        s_type = s.attrib.get("type", "")
                        if s_src:
                            report["streams_found"].append({
                                "url": urllib.parse.urljoin(clean_url, s_src),
                                "type": s_type or "source_tag",
                                "poster": urllib.parse.urljoin(clean_url, poster) if poster else None
                            })

            # Inspect <iframe> embeds
            iframes = page.css("iframe")
            for iframe in iframes:
                i_src = iframe.attrib.get("src") or iframe.attrib.get("data-src")
                if i_src:
                    full_iframe = urllib.parse.urljoin(clean_url, i_src)
                    for domain in COMMON_EMBED_DOMAINS:
                        if domain in full_iframe:
                            report["detected_players"].append(f"Embedded Player ({domain})")
                            report["streams_found"].append({
                                "url": full_iframe,
                                "type": f"iframe_embed_{domain}",
                                "poster": None
                            })

            # Inspect JSON-LD Structured Data
            scripts = page.css('script[type="application/ld+json"]::text').getall()
            for s in scripts:
                try:
                    data = json.loads(s)
                    self._extract_jsonld_videos(data, clean_url, report)
                except Exception:
                    pass

            # Inspect OpenGraph & Twitter video meta tags
            og_video = page.css('meta[property="og:video"]::attr(content), meta[property="og:video:url"]::attr(content), meta[name="twitter:player"]::attr(content)').getall()
            for v_url in og_video:
                if v_url:
                    report["streams_found"].append({
                        "url": urllib.parse.urljoin(clean_url, v_url),
                        "type": "og_video_meta",
                        "poster": None
                    })

            # Sniff raw stream URLs
            sniffed_streams = self._sniff_streams_from_html(html_text, clean_url)
            for st in sniffed_streams:
                report["streams_found"].append({
                    "url": st,
                    "type": self._classify_stream_type(st),
                    "poster": None
                })

            # Step 2: Whole Website Link Discovery
            # Scan all <a> anchors for video watch links, articles, and cards
            all_anchors = page.css("a")
            parsed_origin = urllib.parse.urlparse(clean_url)
            base_domain = parsed_origin.netloc

            for a in all_anchors:
                raw_href = a.attrib.get("href")
                if not raw_href or raw_href.startswith(("#", "javascript:", "mailto:", "tel:")):
                    continue

                full_href = urllib.parse.urljoin(clean_url, raw_href).split("#")[0]
                href_parsed = urllib.parse.urlparse(full_href)

                # Skip external unrelated domains unless they are known video hosts
                is_same_domain = href_parsed.netloc == base_domain
                is_known_video_host = any(d in href_parsed.netloc for d in COMMON_EMBED_DOMAINS)
                if not is_same_domain and not is_known_video_host:
                    continue

                # Check if ignored path
                if any(p.search(href_parsed.path) for p in IGNORE_LINK_PATTERNS):
                    continue

                # Check if matches video path regex
                is_video_path = any(p.search(full_href) for p in VIDEO_PATH_PATTERNS)

                # Check anchor classes or children (e.g. contains img thumbnail or video badge)
                classes = a.attrib.get("class", "").lower()
                has_video_class = any(k in classes for k in ["video", "thumb", "player", "movie", "clip", "card"])
                has_img_child = bool(a.css("img"))

                if is_video_path or has_video_class or (is_same_domain and has_img_child and len(href_parsed.path) > 3):
                    # Exclude the root page itself
                    if full_href != clean_url and full_href != clean_url + "/":
                        discovered_video_links.add(full_href)

        except Exception as e:
            logger.warning(f"Scrapling fetch encountered issue: {e}")
            if not report["error"]:
                report["error"] = str(e)

        # Step 3: Check yt-dlp on root URL (e.g. playlists, channels, feeds)
        yt_videos = self._inspect_with_ytdlp(clean_url)
        if yt_videos:
            report["videos"].extend(yt_videos)
            report["detected_players"].append("yt-dlp Extractor Engine")

        # Step 4: Process discovered video subpages (The Whole-Website Crawl with Pagination)
        discovered_list = sorted(list(discovered_video_links))
        total_discovered = len(discovered_list)
        report["total_subpages_discovered"] = total_discovered
        report["subpages_discovered"] = total_discovered
        report["subpage_offset"] = subpage_offset

        if total_discovered > 0:
            report["is_catalog_page"] = True
            report["detected_players"].append(f"Website Video Catalog ({total_discovered} subpages found)")

        # Determine subpages to crawl based on offset and limit
        if max_subpages <= 0 or max_subpages >= 99999:
            subpages_to_crawl = discovered_list[subpage_offset:]
        else:
            subpages_to_crawl = discovered_list[subpage_offset : subpage_offset + max_subpages]

        has_more = (subpage_offset + len(subpages_to_crawl)) < total_discovered
        report["has_more_subpages"] = has_more
        report["next_offset"] = (subpage_offset + len(subpages_to_crawl)) if has_more else None
        report["remaining_subpages"] = max(0, total_discovered - (subpage_offset + len(subpages_to_crawl)))
        report["subpages_scanned"] = len(subpages_to_crawl)

        # If deep_crawl is requested or root has no/few videos, crawl discovered subpages
        if deep_crawl and subpages_to_crawl:
            logger.info(f"Crawling {len(subpages_to_crawl)} discovered video subpages in parallel (offset: {subpage_offset}, total: {total_discovered})...")
            with ThreadPoolExecutor(max_workers=self.max_workers) as executor:
                future_to_url = {
                    executor.submit(self._inspect_single_subpage, sub_url): sub_url
                    for sub_url in subpages_to_crawl
                }
                for future in as_completed(future_to_url):
                    sub_url = future_to_url[future]
                    try:
                        sub_vids = future.result()
                        if sub_vids:
                            report["videos"].extend(sub_vids)
                    except Exception as err:
                        logger.debug(f"Subpage inspection failed for {sub_url}: {err}")

        # If still no videos but streams were sniffed on the root page, synthesize them
        if not report["videos"] and report["streams_found"]:
            for item in report["streams_found"][:15]:
                report["videos"].append(self._synthesize_video_item(
                    item["url"], clean_url, report["page_title"], item.get("poster")
                ))

        # ---------------------------------------------------------
        # EMERGENCY FALLBACK: ONLY WHEN NORMAL EXTRACTION FINDS ZERO
        # ---------------------------------------------------------
        if len(report["videos"]) == 0:
            logger.warning(
                "Normal extraction returned ZERO videos. "
                "Activating emergency browser recovery."
            )

            recovered = self._zero_video_browser_recovery(
                clean_url,
                discovered_list
            )

            if recovered:
                report["videos"].extend(recovered)
                report["detected_players"].append(
                    "Emergency Browser Recovery"
                )

        # Deduplicate videos by media_url and title
        unique_videos = []
        seen_urls = set()
        for v in report["videos"]:
            u = v.get("media_url") or v.get("page_url")
            if u and u not in seen_urls:
                seen_urls.add(u)
                unique_videos.append(v)
        report["videos"] = unique_videos

        # Mark success if either videos, playable streams, or subpages were found
        report["success"] = len(report["videos"]) > 0 or len(report["streams_found"]) > 0 or report["subpages_discovered"] > 0
        report["detected_players"] = sorted(list(set(report["detected_players"])))

        return report
    def _resolve_http_redirect(self, target_url: str) -> Optional[str]:
        """
        Resolve ordinary HTTP redirects.
        Called only by the zero-video recovery fallback.
        """
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
                }
            )

            with urllib.request.urlopen(request, timeout=8) as response:
                return response.geturl()

        except Exception as e:
            logger.debug(
                f"Redirect recovery could not resolve {target_url}: {e}"
            )
            return None

    def _zero_video_redirect_recovery(
        self,
        root_url: str,
        discovered_urls: List[str]
    ) -> List[Dict[str, Any]]:
        """
        Emergency fallback: resolve redirects and retry extraction.
        Never called when normal extraction finds videos.
        """
        recovered_videos = []
        candidates = list(dict.fromkeys([root_url] + discovered_urls))

        # Keep emergency recovery limited.
        for original_url in candidates[:12]:
            final_url = self._resolve_http_redirect(original_url)

            if not final_url or final_url == original_url:
                continue

            logger.warning(
                f"ZERO-VIDEO FALLBACK: redirect detected: "
                f"{original_url} -> {final_url}"
            )

            try:
                videos = self._inspect_single_subpage(final_url)

                if videos:
                    recovered_videos.extend(videos)
                    logger.info(
                        f"ZERO-VIDEO FALLBACK recovered "
                        f"{len(videos)} video(s) from {final_url}"
                    )

            except Exception as e:
                logger.warning(
                    f"ZERO-VIDEO FALLBACK failed for {final_url}: {e}"
                )

        return recovered_videos
    def _zero_video_browser_recovery(
        self,
        root_url: str,
        discovered_urls: List[str]
    ) -> List[Dict[str, Any]]:
        """
        Browser-only emergency recovery.

        This runs only after the normal extraction path returns zero videos.
        It renders JavaScript and inspects the resulting DOM. It does NOT click
        video links or advertising elements. Automatically opened pop-up tabs
        are closed so the original page remains available for inspection.
        """
        recovered: List[Dict[str, Any]] = []

        try:
            # Import lazily so normal scraping does not require browser startup.
            from scrapling.fetchers import StealthyFetcher
        except Exception as exc:
            logger.warning(
                "Emergency browser recovery unavailable: "
                "Scrapling StealthyFetcher is not installed (%s)", exc
            )
            return recovered

        def register_popup_handler(page):
            def close_popup(popup):
                try:
                    popup.close()
                    logger.info("Emergency recovery closed an unsolicited pop-up tab.")
                except Exception as popup_error:
                    logger.debug("Could not close pop-up tab: %s", popup_error)

            page.on("popup", close_popup)

        def allow_page_to_settle(page):
            # A short, bounded wait for player scripts and DOM mutations.
            page.wait_for_timeout(1200)
            return page

        try:
            logger.warning(
                "Emergency browser recovery: rendering original page once: %s",
                root_url
            )

            browser_response = StealthyFetcher.fetch(
                root_url,
                headless=True,
                timeout=max(15000, min(self.timeout * 1000, 30000)),
                network_idle=False,
                disable_resources=False,
                page_setup=register_popup_handler,
                page_action=allow_page_to_settle
            )

            status = getattr(browser_response, "status", None)
            final_url = getattr(browser_response, "url", None) or root_url

            if status == 403:
                logger.warning(
                    "Emergency browser recovery also received HTTP 403 for %s. "
                    "Stopping this fallback attempt.",
                    final_url
                )
                return recovered

            html = getattr(browser_response, "text", "") or ""
            title_nodes = browser_response.css("title::text").getall()
            title = title_nodes[0].strip() if title_nodes else (
                Path(urllib.parse.urlparse(final_url).path).name or "Detected Video"
            )

            # Extract direct HTML5 video and source elements from the rendered DOM.
            for video_node in browser_response.css("video"):
                poster = video_node.attrib.get("poster")
                video_src = video_node.attrib.get("src")
                if video_src:
                    media_url = urllib.parse.urljoin(final_url, video_src)
                    recovered.append(
                        self._synthesize_video_item(media_url, final_url, title, poster)
                    )

                for source_node in video_node.css("source"):
                    source_url = source_node.attrib.get("src")
                    if source_url:
                        media_url = urllib.parse.urljoin(final_url, source_url)
                        recovered.append(
                            self._synthesize_video_item(media_url, final_url, title, poster)
                        )

            # Inspect media URLs inserted into the DOM or player scripts.
            for media_url in self._sniff_streams_from_html(html, final_url):
                recovered.append(
                    self._synthesize_video_item(media_url, final_url, title, None)
                )

            # Inspect embedded player URLs. Only known video providers are sent
            # to yt-dlp; arbitrary advertising destinations are not followed.
            for iframe in browser_response.css("iframe"):
                iframe_src = iframe.attrib.get("src") or iframe.attrib.get("data-src")
                if not iframe_src:
                    continue

                iframe_url = urllib.parse.urljoin(final_url, iframe_src)
                if any(domain in urllib.parse.urlparse(iframe_url).netloc
                       for domain in COMMON_EMBED_DOMAINS):
                    embedded = self._inspect_with_ytdlp(iframe_url)
                    if embedded:
                        recovered.extend(embedded)

            # If the rendered page is a catalog, inspect a small number of
            # same-site candidate pages using the existing non-clicking parser.
            base_host = urllib.parse.urlparse(final_url).netloc.lower()
            candidates = list(discovered_urls)

            for anchor in browser_response.css("a"):
                href = anchor.attrib.get("href")
                if not href:
                    continue
                candidate = urllib.parse.urljoin(final_url, href.split("#")[0])
                parsed_candidate = urllib.parse.urlparse(candidate)
                if parsed_candidate.scheme not in ("http", "https"):
                    continue
                if parsed_candidate.netloc.lower() != base_host:
                    continue
                if candidate != final_url:
                    candidates.append(candidate)

            seen_candidates = set()
            checked = 0
            for candidate in candidates:
                if candidate in seen_candidates:
                    continue
                seen_candidates.add(candidate)

                if urllib.parse.urlparse(candidate).netloc.lower() != base_host:
                    continue

                if any(pattern.search(urllib.parse.urlparse(candidate).path)
                       for pattern in IGNORE_LINK_PATTERNS):
                    continue

                if checked >= 6 or recovered:
                    break

                checked += 1
                try:
                    candidate_videos = self._inspect_single_subpage(candidate)
                    if candidate_videos:
                        recovered.extend(candidate_videos)
                        logger.info(
                            "Emergency browser recovery found %d video(s) on %s",
                            len(candidate_videos), candidate
                        )
                        break
                except Exception as candidate_error:
                    logger.debug(
                        "Emergency candidate inspection failed for %s: %s",
                        candidate, candidate_error
                    )

        except Exception as exc:
            logger.warning("Emergency browser recovery failed: %s", exc)

        # Deduplicate this fallback's results before returning them.
        unique = []
        seen_media = set()
        for video in recovered:
            media_url = video.get("media_url") or video.get("page_url")
            if media_url and media_url not in seen_media:
                seen_media.add(media_url)
                unique.append(video)

        logger.info(
            "Emergency browser recovery finished with %d video(s).",
            len(unique)
        )
        return unique

    def _inspect_single_subpage(self, sub_url: str) -> List[Dict[str, Any]]:
        """
        Inspects an individual discovered video subpage to extract playable media.
        """
        # Try yt-dlp first for robust extractors
        videos = self._inspect_with_ytdlp(sub_url)
        if videos:
            return videos

        # Otherwise fetch with Scrapling and sniff streams/HTML5 video
        results = []
        try:
            page = Fetcher.get(sub_url, impersonate="chrome", stealthy_headers=True, timeout=12)
            html = getattr(page, "text", "") or ""
            title_nodes = page.css("title::text").getall()
            title = title_nodes[0].strip() if title_nodes else Path(urllib.parse.urlparse(sub_url).path).name

            # Look for <video>
            v_nodes = page.css("video")
            for v in v_nodes:
                src = v.attrib.get("src")
                poster = v.attrib.get("poster")
                if src:
                    full_src = urllib.parse.urljoin(sub_url, src)
                    results.append(self._synthesize_video_item(full_src, sub_url, title, poster))
                for s in v.css("source"):
                    s_src = s.attrib.get("src")
                    if s_src:
                        full_s = urllib.parse.urljoin(sub_url, s_src)
                        results.append(self._synthesize_video_item(full_s, sub_url, title, poster))

            # Sniff streams in scripts
            streams = self._sniff_streams_from_html(html, sub_url)
            for st in streams[:3]:
                results.append(self._synthesize_video_item(st, sub_url, title, None))

            # Check iframes
            iframes = page.css("iframe")
            for ifr in iframes:
                ifr_src = ifr.attrib.get("src") or ifr.attrib.get("data-src")
                if ifr_src:
                    full_ifr = urllib.parse.urljoin(sub_url, ifr_src)
                    if any(d in full_ifr for d in COMMON_EMBED_DOMAINS):
                        sub_embed = self._inspect_with_ytdlp(full_ifr)
                        if sub_embed:
                            results.extend(sub_embed)

        except Exception as e:
            logger.debug(f"Subpage parse error for {sub_url}: {e}")

        return results

    def _extract_jsonld_videos(self, data: Any, base_url: str, report: Dict[str, Any]):
        if isinstance(data, list):
            for item in data:
                self._extract_jsonld_videos(item, base_url, report)
        elif isinstance(data, dict):
            t = data.get("@type")
            if t == "VideoObject" or "video" in str(t).lower():
                c_url = data.get("contentUrl") or data.get("embedUrl")
                if c_url:
                    full_url = urllib.parse.urljoin(base_url, c_url)
                    report["detected_players"].append("JSON-LD VideoObject")
                    report["videos"].append({
                        "id": f"jsonld_{abs(hash(full_url)) % 1000000}",
                        "title": data.get("name") or report.get("page_title") or "Embedded Media Video",
                        "media_url": full_url,
                        "page_url": base_url,
                        "thumbnail": data.get("thumbnailUrl") or (data.get("thumbnail", [None])[0] if isinstance(data.get("thumbnail"), list) else None),
                        "duration": self._parse_iso_duration(data.get("duration")),
                        "resolution": "Auto (Manifest/Direct)",
                        "format": "MP4/Stream",
                        "protocol": self._classify_stream_type(full_url),
                        "formats_available": [
                            {"format_id": "direct", "resolution": "Original", "ext": "mp4", "note": "Direct stream"}
                        ]
                    })
            for v in data.values():
                if isinstance(v, (dict, list)):
                    self._extract_jsonld_videos(v, base_url, report)

    def _parse_iso_duration(self, iso_str: Optional[str]) -> Optional[int]:
        if not iso_str or not isinstance(iso_str, str):
            return None
        match = re.match(r'PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?', iso_str)
        if match:
            h = int(match.group(1) or 0)
            m = int(match.group(2) or 0)
            s = int(match.group(3) or 0)
            return h * 3600 + m * 60 + s
        return None

    def _sniff_streams_from_html(self, html: str, base_url: str) -> List[str]:
        found = set()
        for regex in STREAM_REGEXES:
            for match in regex.findall(html):
                raw_url = match if isinstance(match, str) else match[0]
                clean = raw_url.replace(r"\/", "/")
                if clean.startswith("//"):
                    clean = "https:" + clean
                elif clean.startswith("/"):
                    clean = urllib.parse.urljoin(base_url, clean)
                if clean.startswith("http"):
                    found.add(clean)
        return list(found)

    def _classify_stream_type(self, url: str) -> str:
        u_clean = url.lower().split("?")[0].split("#")[0]
        if ".m3u8" in u_clean:
            return "HLS (M3U8)"
        elif ".mpd" in u_clean:
            return "MPEG-DASH (MPD)"
        elif ".mp4" in u_clean:
            return "MP4 Direct"
        elif ".webm" in u_clean:
            return "WebM"
        elif ".mov" in u_clean:
            return "MOV QuickTime"
        elif ".mkv" in u_clean:
            return "MKV Matroska"
        elif any(u_clean.endswith(ext) for ext in [".ts", ".flv", ".avi", ".m4v", ".3gp"]):
            return "Direct Media"
        return "Stream/Media"

    def _inspect_with_ytdlp(self, target_url: str) -> List[Dict[str, Any]]:
        # If target URL directly points to media stream, synthesize directly
        u_clean = target_url.lower().split("?")[0]
        if any(u_clean.endswith(ext) for ext in [".m3u8", ".mpd", ".mp4", ".webm", ".mov", ".mkv", ".ts"]):
            return [self._synthesize_video_item(
                target_url,
                target_url,
                Path(urllib.parse.urlparse(target_url).path).name or "Direct Media Stream",
                None
            )]

        ydl_opts = {
            "quiet": True,
            "no_warnings": True,
            "skip_download": True,
            "extract_flat": "in_playlist",
            "socket_timeout": 15,
            "ignoreerrors": True,
            "logger": YtDlpQuietLogger()
        }
        results = []
        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(target_url, download=False)
                if not info:
                    return []

                entries = info.get("entries") if "entries" in info else [info]

                for entry in entries:
                    if not entry:
                        continue
                    v_id = entry.get("id") or str(abs(hash(entry.get("webpage_url", target_url))) % 1000000)
                    title = entry.get("title") or "Discovered Media Stream"
                    duration = entry.get("duration")
                    thumbnail = entry.get("thumbnail")
                    formats = entry.get("formats", [])

                    format_options = []
                    best_res = None
                    for f in formats:
                        height = f.get("height")
                        width = f.get("width")
                        ext = f.get("ext", "mp4")
                        f_id = f.get("format_id", "")
                        vcodec = f.get("vcodec", "none")
                        acodec = f.get("acodec", "none")
                        filesize = f.get("filesize") or f.get("filesize_approx")
                        filesize_mb = round(filesize / (1024 * 1024), 1) if filesize else None

                        res_str = f"{height}p" if height else (f"{width}x{height}" if width and height else "Auto")
                        if height and (best_res is None or height > (int(best_res.replace("p", "")) if "p" in best_res else 0)):
                            best_res = f"{height}p"

                        format_options.append({
                            "format_id": f_id,
                            "resolution": res_str,
                            "ext": ext,
                            "vcodec": vcodec,
                            "acodec": acodec,
                            "filesize_mb": filesize_mb,
                            "note": f.get("format_note") or f"{res_str} ({ext})"
                        })

                    if not format_options:
                        format_options.append({
                            "format_id": "best",
                            "resolution": "Original",
                            "ext": "mp4",
                            "note": "Highest Available Quality"
                        })

                    results.append({
                        "id": str(v_id),
                        "title": title,
                        "media_url": entry.get("url") or target_url,
                        "page_url": entry.get("webpage_url") or target_url,
                        "thumbnail": thumbnail,
                        "duration": int(duration) if duration else None,
                        "resolution": best_res or "Auto",
                        "format": entry.get("ext", "mp4").upper(),
                        "protocol": self._classify_stream_type(entry.get("url") or target_url),
                        "formats_available": format_options[:15],
                        "uploader": entry.get("uploader") or entry.get("channel"),
                        "subtitles": list((entry.get("subtitles") or {}).keys())
                    })
        except Exception as e:
            logger.debug(f"yt-dlp probe info: {e}")

        return results

    def _synthesize_video_item(
        self,
        media_url: str,
        page_url: str,
        page_title: str,
        poster: Optional[str] = None
    ) -> Dict[str, Any]:
        p_name = Path(urllib.parse.urlparse(media_url).path).name
        clean_title = p_name if p_name and "." in p_name else (page_title or "Detected Video Stream")
        proto = self._classify_stream_type(media_url)

        return {
            "id": f"vid_{abs(hash(media_url)) % 1000000}",
            "title": clean_title,
            "media_url": media_url,
            "page_url": page_url,
            "thumbnail": poster,
            "duration": None,
            "resolution": "Adaptive / Best",
            "format": "MP4",
            "protocol": proto,
            "formats_available": [
                {"format_id": "best", "resolution": "Original / Adaptive", "ext": "mp4", "note": f"{proto} Stream"}
            ],
            "uploader": None,
            "subtitles": []
        }
