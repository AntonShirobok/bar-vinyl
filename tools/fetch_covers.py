"""Find album covers for data/vinyl.json and save them to data/covers.json.
Tries iTunes first, then Deezer. Keeps covers that are already found; re-run after adding records.
Usage: python tools/fetch_covers.py
"""
import json, re, time, pathlib, unicodedata, urllib.parse, urllib.request
from difflib import SequenceMatcher

ROOT = pathlib.Path(__file__).resolve().parent.parent
VINYL, COVERS = ROOT / "data" / "vinyl.json", ROOT / "data" / "covers.json"

def key(r):
    return f"{r['artist']}|{r['album']}"

def norm(s):
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode() or s
    s = s.lower()
    s = re.sub(r"\((?:\d{4} )?remaster(?:ed)?\)|deluxe|edition|expanded|\bthe\b|&|\band\b", " ", s)
    return re.sub(r"[^\w]+", " ", s).strip()

def clean_album(a):
    a = re.sub(r"\([^)]*(изд|сингл|сборник|12\"|ost|ep|s/t|мелодия|balkanton|японское|дебютный|уточнить)[^)]*\)", "", a, flags=re.I)
    return a.strip(" -")

ALIASES = {
    "ELO": "Electric Light Orchestra", "Ye (Kanye West)": "Kanye West", "Rolling Stones": "The Rolling Stones",
    "Wings (Paul McCartney)": "Wings", "Duo Katz (Дуэт Кац)": "Дуэт Кац", "Боббисокс": "Bobbysocks",
    "АукцЫон": "Аукцыон", "The Velvet Underground & Nico": "The Velvet Underground",
}

def clean_artist(a):
    a = ALIASES.get(a, a)
    a = re.sub(r"\(.*?\)", "", a)
    return a.split(" × ")[0].strip()

def sim(a, b):
    a, b = norm(a), norm(b)
    if not a or not b:
        return SequenceMatcher(None, a, b).ratio()
    if a in b or b in a:
        return 0.9
    return SequenceMatcher(None, a, b).ratio()

def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "vinyl-catalog/1.0"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)

def pick(cands, artist, album, self_titled):
    best, best_s = None, 0
    for c_artist, c_album, art in cands:
        sa = sim(artist, c_artist)
        sb = sim(album, c_album) if album else 0.6
        if artist.lower() in ("various artists", "various"):
            sa = 0.8
        s = sa * 0.45 + sb * 0.55
        if sa >= 0.6 and sb >= 0.55 and s > best_s:
            best, best_s = art, s
    return best

def itunes(artist, album):
    q = urllib.parse.quote(f"{artist} {album}".strip())
    d = get(f"https://itunes.apple.com/search?term={q}&entity=album&limit=15")
    return [(r.get("artistName", ""), r.get("collectionName", ""),
             r.get("artworkUrl100", "").replace("100x100bb", "600x600bb")) for r in d.get("results", [])]

def deezer(artist, album):
    q = urllib.parse.quote(f'artist:"{artist}" album:"{album}"' if album else f'artist:"{artist}"')
    d = get(f"https://api.deezer.com/search/album?q={q}&limit=15")
    res = d.get("data", [])
    if not res:
        d = get(f"https://api.deezer.com/search/album?q={urllib.parse.quote(artist + ' ' + album)}&limit=15")
        res = d.get("data", [])
    return [(r.get("artist", {}).get("name", ""), r.get("title", ""), r.get("cover_xl") or r.get("cover_big", "")) for r in res]

def main():
    import sys; sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
    records = json.loads(VINYL.read_text(encoding="utf-8"))
    covers = json.loads(COVERS.read_text(encoding="utf-8")) if COVERS.exists() else {}
    for r in records:
        k = key(r)
        if covers.get(k) or "уточнить" in r["album"] or r["artist"] == "?":
            continue
        artist, album = clean_artist(r["artist"]), clean_album(r["album"])
        self_titled = "s/t" in r["album"]
        if self_titled:
            album = artist
        art = None
        for src in (itunes, deezer):
            try:
                art = pick(src(artist, album), artist, album, self_titled)
            except Exception as e:
                print("  !", src.__name__, e)
            time.sleep(1.2)
            if art:
                break
        covers[k] = art or ""
        print(("OK  " if art else "--  ") + k)
        COVERS.write_text(json.dumps(covers, ensure_ascii=False, indent=1), encoding="utf-8")
    found = sum(1 for v in covers.values() if v)
    print(f"done: {found}/{len(records)} covers")

if __name__ == "__main__":
    main()
