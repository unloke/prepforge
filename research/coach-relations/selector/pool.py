"""Pool cards with the current Coach's candidate reasons, from cached Stockfish reads only.

ranked(row): the candidates explain.explain ranks for its first sentence (after its filters), in
rank order; alone(row, c): the card the Coach would write with c as its only reason.
"""
import json
import sys
from pathlib import Path
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
BENCH = ROOT.parents[1] / "artifacts/benchmarks/coach-relations-20261014"
sys.path.insert(0, str(ROOT))
import explain  # noqa: E402
import tactics  # noqa: E402
from make_ab import row as card_row  # noqa: E402

ERR = ("inaccuracy", "mistake", "blunder")


def jsonl(p):
    with open(p, encoding="utf-8") as f:
        return [json.loads(l) for l in f if l.strip()]


class CacheMiss(Exception):
    pass


def setup():
    files = sorted((BENCH / "prod-depth/out").glob("fresh*/cards.jsonl"))
    reads = [p.parent / "sf_cache.jsonl" for p in files] + sorted(BENCH.glob("explain-*/*/explain/sf_cache-*.jsonl"))
    cache = {r["fen"]: r for p in [*reads, tactics.CACHE] if p.exists() for r in jsonl(p)}

    def cached(board):
        if board.fen() not in cache:
            raise CacheMiss(board.fen())
        return cache[board.fen()]
    tactics.analyse = cached
    cards = {}
    for p in files:
        for c in jsonl(p):
            if c.get("code") in ERR:
                cards[c["id"]] = c
    return cards


def row(card):
    r = card_row(card)
    if not r["played_pv"] or not r["best_pv"] or r["played_pv"][0] == r["best_pv"][0]:
        return None
    return r


def ranked(r):
    got = {}
    real = explain.rank

    def keep(cands, mover):
        out = real(cands, mover)
        got.setdefault("ranked", out)
        return out
    with patch.object(explain, "rank", keep):
        e = explain.explain(r)
    return got.get("ranked", []), e


def alone(r, c):
    return explain.explain(r, cands=[c])["text"]
