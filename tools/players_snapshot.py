#!/usr/bin/env python3
"""Build players.json for the Players page.

Stats come from ESPN's public NBA feed; salaries from Basketball-Reference's
contracts page (one request, non-commercial use, credited on the page), with
ESPN's contract feed as a fallback for anyone missing there.

    python3 tools/players_snapshot.py            # stats for the latest season with games, salaries for the cap season
    python3 tools/players_snapshot.py 2026 2027  # stats season (2026 = 2025-26), salary season (2027 = 2026-27)

Writes players.json next to index.html. The page loads that file first (instant),
then refreshes stats from ESPN in the browser. Run this again whenever salaries
should be refreshed (after free agency, trades) — takes about a minute.
No key, no login. ESPN's endpoints are unofficial; if they change, the page
keeps working from the last players.json.
"""
import json, sys, os, re, time, html, unicodedata, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor

STATS = "https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/statistics/byathlete?region=us&lang=en&contentorigin=espn&isqualified=false&limit=1000&seasontype=2&season={season}"
CONTRACT = "https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/athletes/{id}/contracts/{season}?lang=en&region=us"
BBR = "https://www.basketball-reference.com/contracts/players.html"
BBR_PG = "https://www.basketball-reference.com/leagues/NBA_{season}_per_game.html"
FBA = ("https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/{season}"
       "/players?scoringPeriodId=0&view=players_wl")
HDR = {"User-Agent": "Mozilla/5.0 (crysterbaters league site)"}

def norm(name):
    n = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower()
    n = re.sub(r"[^a-z ]", "", n.replace(".", "").replace("'", ""))
    return " ".join(w for w in n.split() if w not in ("jr", "sr", "ii", "iii", "iv"))

def bbr_contracts():
    """{normalized name: [salary y1, years on the books, guaranteed remaining, y2]} from Basketball-Reference."""
    try:
        with urllib.request.urlopen(urllib.request.Request(BBR, headers=HDR), timeout=40) as r:
            page = r.read().decode("utf-8", "ignore")
    except Exception as e:
        print("Basketball-Reference unavailable:", e)
        return {}, None
    season = re.search(r'data-stat="y1"[^>]*>(\d{4}-\d{2})', page)
    out = {}
    for row in page.split("<tr")[1:]:
        if 'data-stat="team_id"' not in row or 'data-stat="player"' not in row:
            continue
        def cell(k):
            m = re.search(r'data-stat="' + k + r'"([^>]*)>(.*?)</t[dh]>', row, re.S)
            if not m:
                return "", ""
            csk = re.search(r'csk="([^"]*)"', m.group(1))
            return html.unescape(re.sub(r"<[^>]+>", "", m.group(2))).strip(), (csk.group(1) if csk else "")
        name = cell("player")[0]
        if not name or name == "Player":
            continue
        years = [cell("y%d" % i) for i in range(1, 7)]
        vals = [int(v[1]) if v[1].isdigit() else 0 for v in years]
        yrs = sum(1 for v in vals if v > 0)
        gtd = cell("remain_gtd")[1]
        out[norm(name)] = [vals[0], yrs, int(gtd) if gtd.isdigit() else 0, vals[1], name, cell("team_id")[0]]
    return out, (season.group(1) if season else None)

# ESPN's fantasy game is the one public feed that says which positions a player is
# *eligible* at, not just the one he's listed at. Slots 0-4 are the real positions;
# everything above them (G, F, G/F, UTIL, BE, IR) is derived from those.
FBA_SLOT = {0: "PG", 1: "SG", 2: "SF", 3: "PF", 4: "C"}
COARSE = {"PG": "G", "SG": "G", "SF": "F", "PF": "F", "C": "C"}

def fba_eligibility(season):
    """{norm name: ["PF", "C"]} for the coming season, falling back to the one before."""
    out = {}
    for yr in (season, season - 1):
        try:
            req = urllib.request.Request(FBA.format(season=yr), headers=dict(
                HDR, **{"x-fantasy-filter": json.dumps({"players": {"limit": 4000, "offset": 0}})}))
            with urllib.request.urlopen(req, timeout=60) as r:
                data = json.load(r)
        except Exception as e:
            print("  ESPN fantasy", yr, "failed:", e)
            continue
        for p in data:
            e = [FBA_SLOT[s] for s in p.get("eligibleSlots", []) if s in FBA_SLOT]
            if e:
                out.setdefault(norm(p["fullName"]), e)
        if out:
            return out, yr
    return out, None

def eligible(fine, listed):
    """Fine positions, widened by the position the stats feed lists him at when that
       bucket is missing (ESPN's two feeds disagree - Wembanyama is C in one, F in the
       other, and Yahoo has him at both). Returns e.g. "PF/C", "C/F", "G"."""
    bucket = "G" if listed.endswith("G") else "C" if listed == "C" else "F" if listed.endswith("F") else ""
    out = list(fine)
    if bucket and bucket not in [COARSE[x] for x in fine]:
        out.append(bucket)
    return "/".join(out)

def bbr_pergame(season):
    """{normalized name: [oreb, dreb, games started]} — ESPN's bulk feed has total
    rebounds only, and no games started, so the Yahoo categories OREB/DREB/GS come
    from Basketball-Reference's per-game table (one request)."""
    try:
        with urllib.request.urlopen(urllib.request.Request(BBR_PG.format(season=season), headers=HDR), timeout=40) as r:
            page = r.read().decode("utf-8", "ignore")
    except Exception as e:
        print("Basketball-Reference per-game unavailable:", e)
        return {}
    out = {}
    for row in page.split("<tr")[1:]:
        def cell(k):
            m = re.search(r'data-stat="' + k + r'"[^>]*>(.*?)</t[dh]>', row, re.S)
            return html.unescape(re.sub(r"<[^>]+>", "", m.group(1))).strip() if m else ""
        name = cell("name_display") or cell("player")
        if not name or name == "Player":
            continue
        def num(k):
            v = cell(k)
            try: return float(v)
            except ValueError: return 0.0
        g = num("games")
        rec = [num("orb_per_g"), num("drb_per_g"), int(num("games_started")), g]
        prev = out.get(norm(name))
        # a traded player has one row per team plus a combined 2TM row: keep the fullest
        if not prev or g > prev[3]:
            out[norm(name)] = rec
    return {k: v[:3] for k, v in out.items()}

# Basketball-Reference team codes that differ from ESPN's
BBR_TEAM = {"BRK": "BKN", "CHO": "CHA", "PHO": "PHX", "GSW": "GS", "SAS": "SA", "NYK": "NY", "NOP": "NO", "UTA": "UTAH", "WAS": "WSH"}

def get(url, tries=3):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=HDR), timeout=30) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            time.sleep(1 + i)
        except Exception:
            time.sleep(1 + i)
    return None

def pick(cat, names, key):
    i = names.index(key)
    return cat["values"][i]

def stats(season):
    d = get(STATS.format(season=season))
    if not d or not d.get("athletes"):
        return None, d
    cats = {c["name"]: c["names"] for c in d["categories"]}
    out = []
    for a in d["athletes"]:
        at = a["athlete"]
        byname = {c["name"]: c for c in a["categories"]}
        g, o, df = byname["general"], byname["offensive"], byname["defensive"]
        gn, on, dn = cats["general"], cats["offensive"], cats["defensive"]
        gp = pick(g, gn, "gamesPlayed")
        row = [
            int(at["id"]), at["displayName"], at.get("teamShortName") or "FA",
            (at.get("position") or {}).get("abbreviation") or "", at.get("age") or 0,
            int(gp), pick(g, gn, "avgMinutes"),
            pick(o, on, "avgPoints"), pick(g, gn, "avgRebounds"), pick(o, on, "avgAssists"),
            pick(df, dn, "avgSteals"), pick(df, dn, "avgBlocks"),
            pick(o, on, "avgThreePointFieldGoalsMade"), pick(o, on, "avgThreePointFieldGoalsAttempted"),
            pick(o, on, "avgFieldGoalsMade"), pick(o, on, "avgFieldGoalsAttempted"),
            pick(o, on, "avgFreeThrowsMade"), pick(o, on, "avgFreeThrowsAttempted"),
            pick(o, on, "avgTurnovers"), pick(g, gn, "doubleDouble"), pick(g, gn, "tripleDouble"),
        ]
        out.append([round(v, 3) if isinstance(v, float) else v for v in row])
    return out, d

def salary(pid, season):
    c = get(CONTRACT.format(id=pid, season=season))
    if not c:
        return None
    return [c.get("salary") or 0, c.get("yearsRemaining") or 0, c.get("optionType") or 0]

def main():
    stats_season = int(sys.argv[1]) if len(sys.argv) > 1 else None
    cap_season = int(sys.argv[2]) if len(sys.argv) > 2 else None
    if stats_season is None:
        probe = get(STATS.format(season=2000) )  # any season: the response says what "current" is
        cur = (probe or {}).get("currentSeason", {}).get("year") or 2026
        rows, d = stats(cur)
        if not rows or all(r[5] == 0 for r in rows):
            cur -= 1
            rows, d = stats(cur)
        stats_season = cur
    else:
        rows, d = stats(stats_season)
    if cap_season is None:
        cap_season = ((d or {}).get("currentSeason") or {}).get("year") or stats_season
    print(f"stats {stats_season-1}-{str(stats_season)[2:]}: {len(rows)} players; salaries for {cap_season-1}-{str(cap_season)[2:]}")
    bbr, bbr_season = bbr_contracts()
    print(f"Basketball-Reference: {len(bbr)} contracts, first column {bbr_season}")
    hits, missing = 0, []
    for r in rows:
        c = bbr.get(norm(r[1]))
        if c:
            r.extend([c[0], c[1], c[2], "bbr"]); hits += 1
        else:
            missing.append(r)
    print(f"matched {hits} by name; trying ESPN contracts for {len(missing)}")
    with ThreadPoolExecutor(max_workers=12) as ex:
        sal = list(ex.map(lambda r: salary(r[0], cap_season), missing))
    for r, s in zip(missing, sal):
        r.extend([s[0], s[1], 0, "espn"] if s else [0, 0, 0, ""])
    print(f"ESPN filled {sum(1 for s in sal if s)}; no salary for {sum(1 for s in sal if not s)}")
    # players under contract who didn't play last season (injured, 2026 rookies): keep them, without stats
    have = {norm(r[1]) for r in rows}
    extra = 0
    for k, c in bbr.items():
        if k in have or c[0] <= 0:
            continue
        rows.append([0, c[4], BBR_TEAM.get(c[5], c[5]), "", 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, c[0], c[1], c[2], "bbr"])
        extra += 1
    print(f"added {extra} players under contract with no games last season")
    # the rest of the Yahoo categories: fouls and friends from ESPN, rebound splits and GS from BBR
    espn_extra = {}
    for a in (d or {}).get("athletes", []):
        byname = {c["name"]: c for c in a["categories"]}
        gn = {c["name"]: c["names"] for c in d["categories"]}["general"]
        espn_extra[int(a["athlete"]["id"])] = [
            pick(byname["general"], gn, "avgFouls"), pick(byname["general"], gn, "technicalFouls"),
            pick(byname["general"], gn, "flagrantFouls"), pick(byname["general"], gn, "ejections")]
    pg = bbr_pergame(stats_season)
    print(f"Basketball-Reference per-game: {len(pg)} players (OREB / DREB / GS)")
    pg_hits = 0
    for r in rows:
        e = espn_extra.get(r[0], [0, 0, 0, 0])
        s2 = pg.get(norm(r[1]))
        if s2: pg_hits += 1
        r.extend([round(e[0], 3), e[1], e[2], e[3]] + (s2 if s2 else ([None, None, None] if r[5] else [0, 0, 0])))
    print(f"matched {pg_hits} of {len(rows)} for rebound splits")
    fba, fba_year = fba_eligibility(cap_season)
    print(f"ESPN fantasy {fba_year}: {len(fba)} players with position eligibility")
    el_hits = 0
    for r in rows:
        fine = fba.get(norm(r[1]))
        if fine: el_hits += 1
        r.append(eligible(fine or [], r[3] or ""))
    print(f"matched {el_hits} of {len(rows)} for multi-position eligibility")
    out = {
        "built": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "statsSeason": stats_season, "salarySeason": cap_season,
        "cols": ["id","name","team","pos","age","gp","min","pts","reb","ast","stl","blk","tpm","tpa","fgm","fga","ftm","fta","to","dd","td","salary","yrs","gtd","src","pf","tech","ff","ejct","oreb","dreb","gs","elig"],
        "players": rows,
    }
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "players.json")
    with open(path, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    print("wrote", os.path.normpath(path), os.path.getsize(path), "bytes")

if __name__ == "__main__":
    main()
