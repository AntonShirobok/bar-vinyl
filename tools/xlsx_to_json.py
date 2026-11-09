"""Turn the vinyl .xlsx into data/vinyl.json (offline snapshot used when Apps Script is not reachable).
Usage: python tools/xlsx_to_json.py path/to/vinyl.xlsx
"""
import json, re, sys, pathlib
import openpyxl

def main(src):
    wb = openpyxl.load_workbook(src, read_only=True)
    ws = wb.worksheets[0]
    out, shelf_no = [], 0
    for row in ws.iter_rows(min_row=2, values_only=True):
        if not any(c is not None for c in row):
            continue
        num, artist, album, year, genre, bpm, shelf = (list(row) + [None] * 7)[:7]
        if isinstance(num, str) and re.match(r"\s*\d+\.", num) and artist is None:
            shelf_no += 1
            continue
        if artist is None and album is None:
            continue
        out.append({
            "shelfNo": shelf_no, "n": num, "artist": str(artist or "").strip(),
            "album": str(album or "").strip(), "year": year if isinstance(year, int) else None,
            "genre": str(genre or "").strip(), "bpm": str(bpm or "").strip(), "shelf": str(shelf or "").strip(),
        })
    dst = pathlib.Path(__file__).resolve().parent.parent / "data" / "vinyl.json"
    dst.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(len(out), "records ->", dst)

if __name__ == "__main__":
    main(sys.argv[1])
