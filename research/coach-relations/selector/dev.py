"""Development-tempo audit; cached PVs only. Run with py -B selector/dev.py."""
import argparse
from collections import Counter
import json
from pathlib import Path
import random
import sys
import time

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(HERE), str(HERE / "prod-depth")]
import chess
import positional
import tactics
from explain import explain
from explain_cards import row
from make_ab import jsonl, san_line

READS = HERE.parents[1] / "artifacts/benchmarks/coach-relations-20261014/prod-depth/out"
ERRORS = {"inaccuracy", "mistake", "blunder"}
NAMED = {"88cl0uaw/21", "joGFmaEx/13"}


def counts(fen, pv, history=()):
    """Track actual men, including captures/castling, across the game prefix and PV."""
    b = chess.Board(fen)
    ids = {s: s for s in b.piece_map()}
    left, wasted, reasons = {}, Counter(), []
    queens, castled = Counter(), set()
    start = chess.Board()
    for i, u in enumerate([*history, *pv], 1):
        m = chess.Move.from_uci(u)
        if m not in b.legal_moves:
            raise ValueError(f"illegal PV/prefix: {b.fen()} {u}")
        c, p, man = b.turn, b.piece_at(m.from_square), ids[m.from_square]
        tags = []
        if p.piece_type != chess.PAWN:
            if (man, m.to_square) in left and i - left[man, m.to_square] <= 4:
                tags.append("round_trip")
            if b.move_stack:
                prev = b.copy(stack=1)
                prev.pop()
                cheaper = lambda x: {a for a in x.attackers(not c, m.from_square)
                                     if positional.VAL[x.piece_type_at(a)] < positional.VAL[p.piece_type]}
                if (cheaper(b) - cheaper(prev) and not b.is_capture(m) and not b.gives_check(m)
                        and positional.rel(m.to_square, c) < positional.rel(m.from_square, c)):
                    tags.append("retreat")
            left[man, m.from_square] = i
        if p.piece_type == chess.QUEEN and b.ply() < 12:
            queens[c] += 1
            if queens[c] > 1:
                tags.append("extra_queen")
        if b.is_castling(m):
            castled.add(c)
            rank = 0 if c else 7
            rf = chess.square(7 if m.to_square > m.from_square else 0, rank)
            rt = chess.square(5 if m.to_square > m.from_square else 3, rank)
            ids[rt] = ids.pop(rf)
        ids.pop(m.to_square, None)
        ids[m.to_square] = ids.pop(m.from_square)
        if b.is_en_passant(m):
            ids.pop(m.to_square - 8 if c else m.to_square + 8)
        reasons.extend({"ply": b.ply() + 1, "side": "white" if c else "black", "san": b.san(m),
                        "kind": tag, "in_line": i > len(history)} for tag in tags)
        wasted[c] += len(tags)
        b.push(m)
    out = {}
    for c in chess.COLORS:
        home = [chess.square_name(s) for s, p in b.piece_map().items()
                if p.color == c and p.piece_type in (chess.KNIGHT, chess.BISHOP)
                and start.piece_at(s) == p]
        lost = not b.has_castling_rights(c) and c not in castled
        out["white" if c else "black"] = {"home": home, "lost_castling": int(lost),
                                             "undeveloped": len(home) + int(lost), "wasted": wasted[c]}
    return b, out, reasons


def development(count, mover):
    total = {c: v["undeveloped"] + v["wasted"] for c, v in count.items()}
    return total["black" if mover else "white"] - total["white" if mover else "black"]


def events(r, ends, cs):
    """Contrast adverse played / favorable best events, without engine probes."""
    mover = chess.Board(r["fen"]).turn
    nodes = {k: positional.walk(r["fen"], r[k + "_pv"]) for k in ends}
    entries = {}
    for k, ns in nodes.items():
        entries[k] = set()
        for i, ((before, _), (after, m)) in enumerate(zip(ns, ns[1:]), 1):
            p = before.piece_at(m.from_square)
            king = before.king(not p.color)
            if (p.piece_type not in (chess.PAWN, chess.KING) and chess.square_distance(m.to_square, king) <= 2
                    and chess.square_distance(m.from_square, king) > 2):
                entries[k].add((p.color, p.piece_type, chess.square_name(m.to_square), i))
    out = []
    for k, other in (("played", "best"), ("best", "played")):
        victim = mover if k == "played" else not mover
        color = "white" if victim else "black"
        if cs[k][color]["lost_castling"] and not cs[other][color]["lost_castling"]:
            # Both ends without rights may mean the other line already castled.
            if chess.Board(r["fen"]).has_castling_rights(victim):
                out.append({"line": k, "kind": "lost_castling", "side": color})
        for sq in chess.SquareSet(ends[k].occupied_co[victim] & ~ends[k].pawns & ~ends[k].kings):
            pt = ends[k].piece_type_at(sq)
            if (positional.restricted(ends[k], sq)
                    and not any(positional.restricted(ends[other], s) for s in ends[other].pieces(pt, victim))):
                out.append({"line": k, "kind": "no_safe_square", "side": color,
                            "piece": chess.piece_name(pt), "square": chess.square_name(sq)})
        for c, pt, sq, ply in sorted(entries[k]):
            if c != victim and not any(x[:2] == (c, pt) for x in entries[other]):
                out.append({"line": k, "kind": "king_zone_entry", "side": color,
                            "piece": chess.piece_name(pt), "square": sq, "ply": ply})
    return out


def cached_only(reads):
    paths = ([d / "sf_cache.jsonl" for d in reads.glob("fresh*")]
             + sorted(reads.parents[1].glob("explain-*/*/explain/sf_cache-*.jsonl")) + [tactics.CACHE])
    cache = {r["fen"]: r for p in paths if p.exists() for r in jsonl(p)}
    misses = set()

    def analyse(b):
        fen = b.fen()
        if fen not in cache:
            misses.add(fen)
            raise LookupError("missing cached FEN: " + fen)
        return cache[fen]

    tactics.analyse = analyse  # No code path can launch an engine or write its cache.
    return paths, misses


def audit(reads):
    paths, misses = cached_only(reads)
    pool, prefixes, excluded = {}, {}, Counter()
    for d in sorted(reads.glob("fresh*")):
        eligible = {e["id"] for e in jsonl(d / "explain.jsonl") if "text" in e}
        games = {}
        for c in jsonl(d / "cards.jsonl"):
            games.setdefault(c["id"].split("/")[0], []).append(c)
        for cards in games.values():
            cards.sort(key=lambda c: int(c["id"].split("/")[1]))
            prefix = []
            for c in cards:
                if c["code"] in ERRORS:
                    if c["id"] in eligible:
                        pool[c["id"]] = row(c)
                        prefixes[c["id"]] = (cards[0]["fen"], prefix.copy())
                    else:
                        excluded[c["code"]] += 1
                prefix.append(c["uci"])
    results, t0 = [], time.monotonic()
    for n, (ident, r) in enumerate(sorted(pool.items()), 1):
        fen, prefix = prefixes[ident]
        root = chess.Board(fen)
        for u in prefix:
            root.push_uci(u)
        assert root.fen() == r["fen"], ident
        ends, cs, wasted = {}, {}, {}
        for k in ("played", "best"):
            ends[k], cs[k], wasted[k] = counts(fen, r[k + "_pv"], prefix)
        ds = {k: development(cs[k], root.turn) for k in ends}
        opening = root.ply() + 1 <= 30
        same = positional.material(ends["played"], root.turn) == positional.material(ends["best"], root.turn)
        swing = ds["best"] - ds["played"]
        ev, facts, missing = [], None, None
        # The expensive board/event and current-selector checks only affect this subset.
        if (opening and same and swing >= 2) or ident in NAMED:
            ev = events(r, ends, cs)
            try:
                facts = explain(r)["facts"]
            except LookupError as err:
                missing = str(err)
        results.append({**r, "ply": root.ply() + 1, "counts": cs, "wasted_events": wasted, "D": ds,
                        "swing": swing, "opening": opening, "same_material": same,
                        "material": {k: positional.material(b, root.turn) for k, b in ends.items()},
                        "events": ev, "facts": facts, "cache_miss": missing,
                        "pass": opening and same and swing >= 2 and bool(ev) and facts == []})
        if n % 2000 == 0:
            print(f"{n}/{len(pool)} cards, {time.monotonic() - t0:.1f}s", flush=True)
    return results, {"pool": len(pool), "excluded": dict(excluded), "cache_files": len(paths),
                     "cache_misses": len(misses), "seconds": round(time.monotonic() - t0, 2)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reads", type=Path, default=READS)
    parser.add_argument("--seed", type=int, default=20261015)
    args = parser.parse_args()
    results, meta = audit(args.reads)
    checks = [lambda r: r["opening"], lambda r: r["same_material"], lambda r: r["swing"] >= 2,
              lambda r: bool(r["events"]), lambda r: r["facts"] == []]
    eligible, funnel = results, []
    for check in checks:
        eligible = [r for r in eligible if check(r)]
        funnel.append(len(eligible))
    sample = random.Random(args.seed).sample(sorted(eligible, key=lambda r: r["id"]), min(20, len(eligible)))
    gated = [r for r in results if r["opening"] and r["same_material"] and r["swing"] >= 2]
    retained = {r["id"] for r in sample} | NAMED
    out = {"meta": meta, "seed": args.seed, "swing_distribution": dict(sorted(Counter(r["swing"] for r in results).items())),
           "independent": {"opening": sum(r["opening"] for r in results),
                           "same_material": sum(r["same_material"] for r in results),
                           "swing_ge_2": sum(r["swing"] >= 2 for r in results)},
           "event_cards_after_first_three_gates": dict(Counter(e for r in gated for e in {e["kind"] for e in r["events"]})),
           "chosen_after_event_gate": dict(Counter(("unavailable" if r["facts"] is None else "+".join(r["facts"]) or "none")
                                                   for r in gated if r["events"])),
           "funnel": funnel, "eligible_ids": [r["id"] for r in eligible],
           "sample": [r["id"] for r in sample], "cards": [r for r in results if r["id"] in retained]}
    (HERE / "selector/dev-results.json").write_text(json.dumps(out, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({k: v for k, v in out.items() if k not in ("cards", "eligible_ids")}, indent=2))


if __name__ == "__main__":
    main()
