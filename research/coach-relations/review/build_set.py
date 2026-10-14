"""Research only. Picks the positions for the reason review and writes review/set.json.

  py research/coach-relations/review/build_set.py           # round 1 -> set.json
  py research/coach-relations/review/build_set.py --r2      # round 2 -> set-r2.json
  py research/coach-relations/review/build_set.py --r3      # round 3 -> set-r3.json

From positions.jsonl: inaccuracies, mistakes and blunders whose played move is not the engine
move, one per game, no game from the v7 spot check (those tuned the enumerator), 45 of each
grade at most, interleaved by grade in a fixed shuffled order, 120 in all. Each item carries both lines move by move and the enumerator's
candidates, which the page shows only after the reviewer has written their own reason.
Round 2 keeps the same positions and ids minus those reviewed in LABELS.json, with candidates
from the current enumerator (round 1 tuned it, so only unseen positions measure it).
Round 3 draws new positions: not in rounds 1-2, not from the v7 spot check, not from the games
whose candidates were printed while tuning round 2 (SEEN), one per game, half of them with no
material or mate candidate (so positional detectors are measured on enough positions), each half
interleaved by grade.
"""
import json
import pathlib
import random
from itertools import zip_longest
import sys

import chess

HERE = pathlib.Path(__file__).parent
sys.path.insert(0, str(HERE.parent))
from enumerate import candidates  # noqa: E402

TOTAL, PER_GRADE = 120, 45
R3_HALF = 18
SEEN = set("""9kHtte6M CWUiHxhc FVAINHA2 IZexjDK9 WEn30u09 fFpgwcvI gxtaeLqK nSvKFzXI ne1TIdVV 1HZPejLy l7zAZuwu
urdHwpWQ dzU99BFv EmEZrcf9 tCCTuCwb nfeAc1Cz DNhhypWP QIrUtZaz BvQR69NU kzO8xpo0 stmk2OCH CWm5CWdm 88wbCaFC
ImxVlfPY MjUb9jcO N3PBJ07V kuUD842n 4q388Xq8 NarEAPFD TfgXBzBK AQsffKvT nTD5VGd6 C9LdNE9h ytCu5VIx""".split())


def line(fen, pv):
    b = chess.Board(fen)
    out = []
    for u in pv:
        m = chess.Move.from_uci(u)
        if m not in b.legal_moves:
            break
        out.append({"san": b.san(m), "uci": u})
        b.push(m)
        out[-1]["fen"] = b.fen()
    return out


def item(pos_id, r):
    b = chess.Board(r["fen"])
    return {"pos_id": pos_id, "card": r["id"], "grade": r["grade"], "fen": r["fen"],
            "side": "white" if b.turn else "black", "move_number": b.fullmove_number,
            "lines": {"played": line(r["fen"], r["played_pv"]), "best": line(r["fen"], r["best_pv"])},
            "candidates": candidates(r)}


def round3(rows):
    done = {p["card"] for f in ("set.json", "set-r2.json") for p in json.loads((HERE / f).read_text(encoding="utf-8"))}
    skip = {r["id"].split("/")[0] for r in rows if r["chk"]} | SEEN
    pool = [r for r in rows if r["grade"] in ("inaccuracy", "mistake", "blunder") and r["played_pv"][:1] != r["best_pv"][:1]
            and r["id"] not in done and r["id"].split("/")[0] not in skip]
    random.Random(20261014).shuffle(pool)
    games, halves = set(), {True: {}, False: {}}
    for r in pool:
        g = r["id"].split("/")[0]
        if g in games:
            continue
        c = item(None, r)
        tactical = any(x["type"] in ("material", "mate", "forced_mate") for x in c["candidates"])
        half = halves[tactical]
        if sum(map(len, half.values())) < R3_HALF:
            games.add(g)
            half.setdefault(r["grade"], []).append(c)
    out = []
    for half in (halves[False], halves[True]):
        out += [c for trio in zip_longest(*half.values()) for c in trio if c]
    random.Random(1).shuffle(out)
    for n, c in enumerate(out, 1):
        c["pos_id"] = f"r3-{n:03d}"
    (HERE / "set-r3.json").write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(len(out), "positions", {t: {g: len(v) for g, v in h.items()} for t, h in halves.items()})


def main():
    rows = [json.loads(l) for l in (HERE.parent / "positions.jsonl").read_text(encoding="utf-8").splitlines()]
    if "--r3" in sys.argv:
        return round3(rows)
    tuned = {r["id"].split("/")[0] for r in rows if r["chk"]}
    pool = [r for r in rows if r["grade"] in ("inaccuracy", "mistake", "blunder")
            and r["played_pv"][:1] != r["best_pv"][:1] and r["id"].split("/")[0] not in tuned]
    rng = random.Random(20261013)
    rng.shuffle(pool)
    games, picked = set(), {"inaccuracy": [], "mistake": [], "blunder": []}
    for r in pool:
        g = r["id"].split("/")[0]
        if g not in games and len(picked[r["grade"]]) < PER_GRADE:
            games.add(g)
            picked[r["grade"]].append(r)
    items = [r for trio in zip_longest(*picked.values()) for r in trio if r][:TOTAL]
    r2 = "--r2" in sys.argv
    seen = {x["pos_id"] for x in json.loads((HERE / "LABELS.json").read_text(encoding="utf-8"))["reviews"]
            if x["submitted_at"]} if r2 else set()
    out = []
    for n, r in enumerate(items, 1):
        if f"rr-{n:03d}" in seen:
            continue
        out.append(item(f"rr-{n:03d}", r))
    (HERE / ("set-r2.json" if r2 else "set.json")).write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(len(out), "positions", {k: len(v) for k, v in picked.items()})


if __name__ == "__main__":
    main()
