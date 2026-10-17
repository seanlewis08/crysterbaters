#!/usr/bin/env python3
"""THE WIRE: post NBA news feeds into the Crysterbaters Discord as clean embeds.

Replaces MonitoRSS so the messages can be shaped properly (boilerplate stripped,
HTML flattened, source and time in the footer, one colour per feed). Runs every
15 minutes from GitHub Actions (.github/workflows/wire.yml) or by hand:

    DISCORD_BOT_TOKEN=... python3 scripts/wire.py            # post new items
    DISCORD_BOT_TOKEN=... python3 scripts/wire.py --dry      # print, post nothing
    python3 scripts/wire.py --dry --max 3                     # limit per feed

Dedupe needs no database: the bot reads the last 100 messages in each channel
and skips any article whose link is already there (embed URL or button URL),
so MonitoRSS's earlier posts count too. Needs: requests, feedparser.
"""
import argparse
import html
import os
import re
import sys
import time
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

import feedparser
import requests

API = "https://discord.com/api/v10"
TOKEN = os.environ.get("DISCORD_BOT_TOKEN", "")
UA = {"User-Agent": "Mozilla/5.0 (compatible; CrysterbatersWire/1.0; +https://crysterbaters.com)"}
# Discord rejects browser-ish user agents from scripts with 40333 "internal network error"
DISCORD_UA = {"User-Agent": "DiscordBot (https://crysterbaters.com, 1.0)"}

FEEDS = [
    {
        "key": "rotowire",
        "name": "RotoWire NBA News",
        "url": "https://www.rotowire.com/rss/news.php?sport=NBA",
        "channel": "1561013442436136971",   # #📰┃nba-news
        "color": 0xE07A3A,
        "strip": [r"\s*Visit RotoWire\.com for more analysis on this update\.?", r"\s*Read more on RotoWire\.com\.?"],
    },
    {
        "key": "hoopsrumors",
        "name": "Hoops Rumors",
        "url": "https://www.hoopsrumors.com/feed",
        "channel": "1561013729267679303",   # #🗣️┃rumor-mill
        "color": 0x1B3F7A,
        "strip": [r"\s*The post .* appeared first on Hoops Rumors\.?", r"\s*Continue reading.*$"],
    },
    {
        "key": "shams",
        "name": "Shams Charania",
        "url": "https://news.google.com/rss/search?q=%22Shams+Charania%22&hl=en-US&gl=US&ceid=US:en",
        "channel": "1561013562137116743",   # #💣┃shams
        "color": 0xCE1141,
        "icon": "https://ssl.gstatic.com/gnews/logo/google_news_192.png",
        "google_news": True,
        "max_age_hours": 36,
        # Google News matches the name anywhere in the article; only keep headlines that are about him
        "title_must_match": r"\b(shams|charania)\b",
        # optional: a role id to ping on each post (set WIRE_SHAMS_ROLE in the workflow if wanted)
        "ping_role": os.environ.get("WIRE_SHAMS_ROLE", ""),
    },
]

TAG_RE = re.compile(r"<[^>]+>")
WS_RE = re.compile(r"[ \t ]+")
MD_LINK_RE = re.compile(r"\[([^\]]+)\]\([^)]+\)")


def clean_text(raw, strips=(), limit=420):
    """HTML → plain text, boilerplate removed, trimmed at a sentence or word."""
    s = html.unescape(raw or "")
    s = re.sub(r"<\s*br\s*/?>|</p>|</li>", "\n", s, flags=re.I)
    s = TAG_RE.sub("", s)
    s = MD_LINK_RE.sub(r"\1", s)
    for pat in strips:
        s = re.sub(pat, "", s, flags=re.I | re.S)
    s = WS_RE.sub(" ", s)
    s = re.sub(r"\s*(\[…\]|\[\.\.\.\]|\(Twitter link\)|\(Twitter links?\))\s*", " ", s)
    s = re.sub(r"\n\s*\n+", "\n\n", s).strip()
    if len(s) > limit:
        cut = s[:limit]
        dot = max(cut.rfind(". "), cut.rfind("! "), cut.rfind("? "))
        s = (cut[: dot + 1] if dot > limit * 0.5 else cut[: cut.rfind(" ")].rstrip(",;:") + "…")
    return s


def entry_time(e):
    for k in ("published_parsed", "updated_parsed"):
        t = e.get(k)
        if t:
            return datetime(*t[:6], tzinfo=timezone.utc)
    for k in ("published", "updated"):
        if e.get(k):
            try:
                return parsedate_to_datetime(e[k]).astimezone(timezone.utc)
            except Exception:
                pass
    return None


def build_embed(feed, e):
    title = html.unescape(e.get("title", "")).strip()
    link = e.get("link", "")
    desc = clean_text(e.get("summary") or e.get("description") or "", feed.get("strip", ()))
    author = {"name": feed["name"]}
    if feed.get("icon"):
        author["icon_url"] = feed["icon"]
    if feed.get("google_news"):
        # Google News titles are "Headline - Source"; the source also comes as <source>
        src = (e.get("source") or {}).get("title") or ""
        m = re.match(r"^(.*?)\s+-\s+([^-]{2,40})$", title)
        if m:
            title, src = m.group(1).strip(), src or m.group(2).strip()
        author = {"name": src or "Google News", "icon_url": feed.get("icon")}
        desc = ""  # Google News summaries are just the headline again
    embed = {
        "title": title[:256],
        "url": link,
        "color": feed["color"],
        "author": author,
        "footer": {"text": feed["name"]},
    }
    if desc and desc.lower() != title.lower():
        embed["description"] = desc[:4096]
    ts = entry_time(e)
    if ts:
        embed["timestamp"] = ts.isoformat()
    return embed


# ---------- Discord ----------
def dc(method, path, **kw):
    for attempt in range(5):
        r = requests.request(method, API + path, headers={"Authorization": "Bot " + TOKEN, **DISCORD_UA}, timeout=20, **kw)
        if r.status_code == 429:
            time.sleep(float(r.json().get("retry_after", 1)) + 0.2)
            continue
        if r.status_code >= 400:
            raise RuntimeError(f"{method} {path} → {r.status_code} {r.text[:300]}")
        return r.json() if r.text else None
    raise RuntimeError("rate limited too long: " + path)


def seen_links(channel_id):
    """Links already posted in the channel (embed urls, button urls, bare urls), plus the
    newest message time. Note: other bots' message bodies are only visible when the app has
    the Message Content intent (Developer Portal → Bot); our own posts are always visible.
    The newest-message time is the fallback: anything published well before it is assumed
    to have been posted already."""
    links, before, newest = set(), None, None
    for _ in range(2):
        msgs = dc("GET", f"/channels/{channel_id}/messages", params={"limit": 50, "with_components": "true", **({"before": before} if before else {})})
        if not msgs:
            break
        for m in msgs:
            if newest is None:
                newest = datetime.fromisoformat(m["timestamp"].replace("Z", "+00:00"))
            for em in m.get("embeds", []):
                if em.get("url"):
                    links.add(em["url"])
            stack = list(m.get("components", []))
            while stack:
                c = stack.pop()
                if c.get("url"):
                    links.add(c["url"])
                stack.extend(c.get("components", []))
                if c.get("accessory"):
                    stack.append(c["accessory"])
            links.update(re.findall(r"https?://[^\s<>)\]]+", m.get("content", "")))
        before = msgs[-1]["id"]
        if len(msgs) < 50:
            break
    return links, newest


def norm_link(u):
    return re.sub(r"[?#].*$", "", u or "").rstrip("/")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--max", type=int, default=8, help="max new posts per feed per run")
    ap.add_argument("--only", help="comma list of feed keys")
    args = ap.parse_args()
    if not TOKEN and not args.dry:
        sys.exit("DISCORD_BOT_TOKEN is not set")

    total = 0
    for feed in FEEDS:
        if args.only and feed["key"] not in args.only.split(","):
            continue
        try:
            resp = requests.get(feed["url"], headers=UA, timeout=25)
            resp.raise_for_status()
            parsed = feedparser.parse(resp.content)
        except Exception as ex:
            print(f"[{feed['key']}] fetch failed: {ex}")
            continue
        entries = [e for e in parsed.entries if e.get("link") and e.get("title")]
        if feed.get("title_must_match"):
            entries = [e for e in entries if re.search(feed["title_must_match"], e["title"], re.I)]
        if feed.get("max_age_hours"):
            cutoff = datetime.now(timezone.utc).timestamp() - feed["max_age_hours"] * 3600
            entries = [e for e in entries if not entry_time(e) or entry_time(e).timestamp() >= cutoff]
        entries.sort(key=lambda e: (entry_time(e) or datetime.min.replace(tzinfo=timezone.utc)))
        seen, newest = (set(), None) if args.dry and not TOKEN else seen_links(feed["channel"])
        seen = {norm_link(u) for u in seen}
        floor = newest.timestamp() - 25 * 60 if newest else None
        new = [e for e in entries if norm_link(e["link"]) not in seen
               and not (floor and entry_time(e) and entry_time(e).timestamp() < floor)]
        new = new[-args.max:]  # oldest→newest, keep the newest N
        print(f"[{feed['key']}] {len(entries)} in feed, {len(new)} new")
        for e in new:
            embed = build_embed(feed, e)
            body = {"embeds": [embed], "allowed_mentions": {"parse": [], "roles": [feed["ping_role"]] if feed.get("ping_role") else []}}
            if feed.get("ping_role"):
                body["content"] = f"<@&{feed['ping_role']}>"
            if args.dry:
                print("   ·", embed["title"], "|", (embed.get("description") or "")[:90].replace("\n", " "))
            else:
                dc("POST", f"/channels/{feed['channel']}/messages", json=body)
                total += 1
                time.sleep(0.6)
    print(f"done: {total} posted" if not args.dry else "dry run complete")


if __name__ == "__main__":
    main()
