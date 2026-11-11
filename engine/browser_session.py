"""Workspace-isolated Chromium session; login and verification remain human-controlled."""
import base64, ipaddress, json, os, socket
from pathlib import Path
from urllib.parse import urlparse
from patchright.sync_api import sync_playwright
PROFILE = Path(os.environ.get("SCRAPLING_BROWSER_PROFILE_DIR", "data/browser-profile"))
COOKIE = Path(os.environ.get("YTDLP_COOKIES_FILE", "data/youtube-cookies.txt"))
STATE = PROFILE / "session-state.json"

def safe_url(value):
    p = urlparse(value or "")
    if p.scheme not in ("http", "https") or not p.hostname:
        raise ValueError("Only public HTTP(S) websites are supported.")
    host = p.hostname.lower()
    if host in ("localhost", "localhost.localdomain") or host.endswith((".localhost", ".local", ".internal")):
        raise ValueError("Local and internal destinations are blocked.")
    try:
        ips = {ipaddress.ip_address(host)}
    except ValueError:
        try: ips = {ipaddress.ip_address(x[4][0]) for x in socket.getaddrinfo(host, None)}
        except OSError: ips = set()
    if any(not ip.is_global for ip in ips):
        raise ValueError("Private, local and reserved destinations are blocked.")
    return value


def guard_request(route, request):
    parsed = urlparse(request.url)
    if parsed.scheme not in ("http", "https"):
        return route.continue_()
    host = (parsed.hostname or "").lower()
    if host in ("localhost", "localhost.localdomain") or host.endswith((".localhost", ".local", ".internal")):
        return route.abort()
    try:
        addresses = {ipaddress.ip_address(host)}
    except ValueError:
        try:
            addresses = {ipaddress.ip_address(item[4][0]) for item in socket.getaddrinfo(host, None)}
        except OSError:
            return route.abort()
    if not addresses or any(not address.is_global for address in addresses):
        return route.abort()
    return route.continue_()

def export_cookies(context):
    COOKIE.parent.mkdir(parents=True, exist_ok=True)
    lines = ["# Netscape HTTP Cookie File"]
    for c in context.cookies():
        domain, name = c.get("domain", ""), c.get("name", "")
        if not domain or not name: continue
        lines.append("\\t".join([domain, "TRUE" if domain.startswith(".") else "FALSE", c.get("path") or "/", "TRUE" if c.get("secure") else "FALSE", str(int(c.get("expires") or 0)), name, c.get("value", "")]))
    tmp = COOKIE.with_suffix(".tmp")
    tmp.write_text("\\n".join(lines) + "\\n", encoding="utf-8")
    os.chmod(tmp, 0o600)
    tmp.replace(COOKIE)

def run_browser_action(payload):
    action = payload.get("action", "status")
    PROFILE.mkdir(parents=True, exist_ok=True)
    if action == "status":
        last = json.loads(STATE.read_text()).get("url", "") if STATE.exists() else ""
        return {"success": True, "profile_ready": True, "cookies_ready": COOKIE.is_file() and COOKIE.stat().st_size > 40, "last_url": last}
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(str(PROFILE), headless=True, viewport={"width":1280,"height":800}, args=["--no-sandbox","--disable-dev-shm-usage"])
        try:
            page = ctx.pages[0] if ctx.pages else ctx.new_page()
            saved = json.loads(STATE.read_text()) if STATE.exists() else {}
            if action == "open":
                page.goto(safe_url(str(payload.get("url","")).strip()), wait_until="domcontentloaded", timeout=45000)
            elif saved.get("url") and page.url == "about:blank":
                page.goto(safe_url(saved["url"]), wait_until="domcontentloaded", timeout=45000)
            if action == "click":
                x,y=int(payload.get("x",-1)),int(payload.get("y",-1))
                if not (0 <= x <= 1280 and 0 <= y <= 800): raise ValueError("Click coordinates must be within 1280x800.")
                page.mouse.click(x,y); page.wait_for_timeout(350)
            elif action == "type":
                value=str(payload.get("text",""))
                if len(value)>2000: raise ValueError("Text input is limited to 2000 characters.")
                page.keyboard.insert_text(value)
            elif action == "key":
                key=str(payload.get("key",""))
                if key not in {"Enter","Tab","Escape","Backspace","ArrowDown","ArrowUp"}: raise ValueError("Unsupported key.")
                page.keyboard.press(key); page.wait_for_timeout(350)
            elif action == "scroll":
                page.mouse.wheel(0,max(-1200,min(1200,int(payload.get("delta",600))))); page.wait_for_timeout(350)
            elif action not in {"open","screenshot"}: raise ValueError("Unsupported browser action.")
            STATE.write_text(json.dumps({"url":page.url}))
            export_cookies(ctx)
            shot=page.screenshot(type="jpeg",quality=72,full_page=False)
            return {"success":True,"url":page.url,"title":page.title(),"screenshot":base64.b64encode(shot).decode("ascii"),"cookies_ready":COOKIE.is_file() and COOKIE.stat().st_size>40}
        finally: ctx.close()
