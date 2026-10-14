"""The games for the production-depth reads (round 6 and later A/B rounds), from datasnaek/chess.

  py research/coach-relations/prod-depth/games.py <games.csv> <out-dir>

v5.json   the 337 games behind positions.jsonl (the coach-v5 depth-22 cards), for the depth check.
freshN    rated games of 20-200 plies that no coach file names (no card, review, A/B, SFT row),
          in sha256("coach-r6:" + id) order, 500 per shard, four shards.
Each game is {id, moves: [uci, ...]}.
"""
import csv
import hashlib
import json
import pathlib
import re
import sys

import chess

ROOT = pathlib.Path(__file__).resolve().parents[3]
HERE = pathlib.Path(__file__).resolve().parent
SHARD, SHARDS = 500, 4
# Every place a coach card, review or A/B names a game (as "<8-char id>/<ply>").
COACH = ["research/sft", "research/coach-relations", "research/coach-prod-v2", "research/coach-ab-review",
         *[str(p.relative_to(ROOT)) for p in (ROOT / "artifacts/benchmarks").glob("coach-*")]]


def coach_ids():
    pat, seen = re.compile(rb"([A-Za-z0-9]{8})/\d{1,3}"), set()
    for d in COACH:
        for p in (ROOT / d).rglob("*"):
            if p.is_file() and p.suffix in {".json", ".jsonl", ".md", ".txt", ".csv"} and "prod-depth" not in p.parts:
                seen |= {m.decode() for m in pat.findall(p.read_bytes())}
    return seen


def ucis(sans):
    b, out = chess.Board(), []
    for s in sans.split():
        m = b.parse_san(s)
        out.append(m.uci())
        b.push(m)
    return out


def main():
    src, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)
    rows = {r["id"]: r for r in csv.DictReader(src.open(encoding="utf-8"))}
    v5 = sorted({json.loads(l)["id"].split("/")[0] for l in (HERE.parent / "positions.jsonl").open(encoding="utf-8")})
    used = coach_ids() | set(v5)
    pool = [i for i, r in rows.items() if i not in used and r["rated"].upper() == "TRUE" and 20 <= int(r["turns"]) <= 200]
    pool.sort(key=lambda i: hashlib.sha256(f"coach-r6:{i}".encode()).hexdigest())
    sets = {"v5": v5, **{f"fresh{k + 1}": pool[k * SHARD:(k + 1) * SHARD] for k in range(SHARDS)}}
    for name, ids in sets.items():
        (out / f"{name}.json").write_text(json.dumps([{"id": i, "moves": ucis(rows[i]["moves"])} for i in ids]), encoding="utf-8")
    print(json.dumps({"csv_games": len(rows), "coach_named": len(used & rows.keys()), "pool": len(pool),
                      **{k: len(v) for k, v in sets.items()}}))


if __name__ == "__main__":
    main()
