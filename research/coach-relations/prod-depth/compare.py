"""Production depth (lite 12/16, the v5 kernel) against the coach-v5 depth-22 reads, same moves.

  py research/coach-relations/prod-depth/compare.py <v5-kernel-out-dir> [<more kernel out-dirs> ...]

Reports, on the 860 positions.jsonl moves:
- grades: depth-22 grade against production's own code;
- reads: PV length of the before/after reads, cut lines shorter than make_cards' 4-ply minimum,
  lines that stop mid-exchange (Stockfish's tail continues with captures);
- explain.py on both, on moves both call an error: lead fact kind, a reason at all (fact or quiet
  sentence) or bare, and whether the material claim (line, net, pieces) matches depth 22.
Every kernel's sf_cache.jsonl is merged into a scratch cache so nothing is searched twice; the
tail searches still run at tactics.py's screen-depth settings.
"""
import json
import pathlib
import statistics
import sys
import tempfile
from collections import Counter

import chess

HERE = pathlib.Path(__file__).resolve().parent
sys.path[:0] = [str(HERE.parent), str(HERE)]
import tactics  # noqa: E402

ERRORS = ("inaccuracy", "mistake", "blunder")
V5 = HERE.parents[1] / "sft/experiment/coach-v5-20261011"


def jsonl(p):
    return [json.loads(l) for l in pathlib.Path(p).read_text(encoding="utf-8").splitlines() if l.strip()]


def kind(e):
    if e["facts"]:
        f = e["facts"][0]
        return "mate" if f in ("mate", "mate_threat", "forced_mate") else f
    return "bare" if "is not the best move" in e["text"] and e["text"].endswith(" was the move.") else "quiet only"


def claim(e):
    """The material claims as comparable tuples."""
    return sorted((f["line"], f.get("net"), tuple(sorted(f.get("won", []))), tuple(sorted(f.get("lost", []))))
                  for f in e["chosen"] if f["type"] == "material")


def q(xs):
    xs = sorted(xs)
    return f"median {statistics.median(xs):g}, p10 {xs[len(xs) // 10]}, p90 {xs[9 * len(xs) // 10]}" if xs else "-"


def main():
    outs = [pathlib.Path(p) for p in sys.argv[1:]]
    cache = pathlib.Path(tempfile.gettempdir()) / "prod-depth-sf-cache.jsonl"
    rows = {}
    for p in [HERE.parent / "sf_cache.jsonl"] + [o / "sf_cache.jsonl" for o in outs]:
        if p.exists():
            rows.update({r["fen"]: r for r in jsonl(p)})
    cache.write_text("".join(json.dumps(r) + "\n" for r in rows.values()), encoding="utf-8")
    tactics.CACHE = cache
    from explain import explain  # noqa: E402  (after the cache is set)
    from explain_cards import row  # noqa: E402

    d22 = {(r["fen"], chess.Board(r["fen"]).parse_san(r["san"]).uci()): r for r in jsonl(HERE.parent / "positions.jsonl")}
    reads22 = {}
    for f in V5.glob("reads/shard*.out.jsonl"):
        reads22.update({r["id"]: r for r in jsonl(f)})
    cards = {(c["fen"], c["uci"]): c for c in jsonl(outs[0] / "cards.jsonl")}
    both = [(d22[k], cards[k]) for k in d22 if k in cards]
    print(f"moves: {len(d22)} depth-22 cards, {len(both)} found in the production-depth run\n")

    g = Counter((a["grade"], c["code"]) for a, c in both)
    err22, errp = sum(v for (a, _), v in g.items() if a in ERRORS), sum(v for (_, b), v in g.items() if b in ERRORS)
    same = sum(v for (a, b), v in g.items() if a == b)
    print(f"grades: same {same}/{len(both)}; error at depth 22 {err22}, at production depth {errp}")
    for a in ERRORS:
        print(f"  depth-22 {a}: " + ", ".join(f"{b} {v}" for (x, b), v in g.most_common() if x == a))

    print("\nreads (plies):")
    for side in ("before", "after"):
        lp = [len(c[side]["pv"]) for _, c in both if c[side]]
        l22 = [len((reads22[a["id"]].get(side) or {}).get("pv", [])) for a, _ in both if a["id"] in reads22]
        print(f"  {side} PV: production {q(lp)}; depth 22 {q(l22)}")
    depth = Counter(c[s]["depth"] for _, c in both for s in ("before", "after") if c[s])
    print(f"  read depth at production: {dict(sorted(depth.items()))}")

    pairs = [(a, c) for a, c in both if a["grade"] in ERRORS and c["code"] in ERRORS]
    stats, mat, examples = Counter(), Counter(), []
    for a, c in pairs:
        r = row(c)
        for name, x in (("22", a), ("prod", r)):
            for ln in ("played_pv", "best_pv"):
                b = chess.Board(x["fen"])
                for u in x[ln]:
                    b.push(chess.Move.from_uci(u))
                stats[name, "short"] += len(x[ln]) < 4 and not b.is_game_over()
                stats[name, "mid-exchange"] += not b.is_game_over() and bool(tactics.tail(b, chess.Board(x["fen"]).turn)[0])
                stats[name, "lines"] += 1
        e22, ep = explain(a), explain(r)
        stats["22", kind(e22)] += 1
        stats["prod", kind(ep)] += 1
        stats["same lead"] += kind(e22) == kind(ep)
        c22, cp = claim(e22), claim(ep)
        if c22 or cp:
            k = "same" if c22 == cp else "production only" if not c22 else "depth 22 only" if not cp else "different"
            mat[k] += 1
            if k != "same" and len(examples) < 12:
                examples.append((a["id"], k, e22["text"], ep["text"]))
    tactics.close()
    n = len(pairs)
    print(f"\nlines of the {n} moves both call an error ({stats['22', 'lines']} lines each side):")
    for k in ("short", "mid-exchange"):
        print(f"  {k}: depth 22 {stats['22', k]}, production {stats['prod', k]}")
    print("\nexplain.py lead:")
    for k in sorted({k[1] for k in stats if k[0] in ('22', 'prod') and k[1] not in ('short', 'mid-exchange', 'lines')}):
        print(f"  {k}: depth 22 {stats['22', k]} ({stats['22', k] / n:.0%}), production {stats['prod', k]} ({stats['prod', k] / n:.0%})")
    print(f"  same lead kind: {stats['same lead']}/{n}")
    print(f"\nmaterial claims (moves where either side makes one): {dict(mat)}")
    for i, k, t22, tp in examples:
        print(f"\n{i} [{k}]\n  22:   {t22}\n  prod: {tp}")


if __name__ == "__main__":
    main()
