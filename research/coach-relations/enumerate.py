"""Research only. Lists relations that differ between the played and best lines.

  py research/coach-relations/enumerate.py

For each card in positions.jsonl, walks the played and best engine lines and records events:
- enter: a piece lands deep in the enemy half, off enemy pawn attacks;
- shield: a shield pawn of a king on a wing (the three files around it, up to two ranks ahead)
  is pushed or taken while the enemy keeps a queen or two heavy pieces;
- open_file: at the last ply both lines reach, one side has a rook or queen on an open file that
  sees into the enemy's home ranks, the other side has none there but has one elsewhere, and in
  either line a rook or queen moved on that file or a pawn left it;
  material won by the opponent in the best line is dropped (an unfinished sacrifice), and material
  and enter in a line with mate or forced_mate (part of the mate), then shield, open_file and the
  positional.py facts other than draw_risk are dropped from a card with a material, mate or
  forced_mate fact, and draw_risk from a card with mate or forced_mate;
- outpost, piece_harassed, pawn_weakness, draw_risk from positional.py;
- tactical and material relations from tactics.py: fork, mate_threat, mate,
  material (an exchange one side wins), and between lines forced_mate, king_exposed and trades
  (two or more pieces more off over the plies both lines reach, of about equal worth for both
  sides, listed for both lines, with the material lead). A mate threat is dropped when the reply takes the threatening piece, and king_exposed
  from a card with material but no mate.
Pieces are named by their square in the root position. A candidate is an event (type, piece)
found in one line and not the other. enter, fork and mate_threat are kept only for the side the
line favours (the opponent in the played line, the mover in the best line), and an entry that
captures without check or a fork with check is dropped from a line that reports material or mate.
Writes candidates.jsonl and reports, on the v7 misses in
gold.jsonl, whether the reason the reviewer named is among the candidates.
"""
import json
import pathlib
import statistics
from collections import Counter

import chess

import positional
import tactics

HERE = pathlib.Path(__file__).parent
VALUE = {chess.KNIGHT: 3, chess.BISHOP: 3, chess.ROOK: 5, chess.QUEEN: 9}
ORDER = ["mate", "forced_mate", "mate_threat", "material", "fork", "king_exposed",
         "shield", "trades", "open_file", "enter", "outpost", "piece_harassed", "pawn_weakness", "draw_risk"]
HEAVY = (chess.ROOK, chess.QUEEN)


def walk(fen, pv):
    """Boards along the line, each with {square: root-square id} and the move that led there."""
    b = chess.Board(fen)
    ids = {sq: chess.square_name(sq) for sq in b.piece_map()}
    nodes = [(b.copy(), ids, None)]
    for u in pv:
        m = chess.Move.from_uci(u)
        if m not in b.legal_moves:
            break
        ids = dict(ids)
        moved = ids.pop(m.from_square)
        ids.pop(m.to_square, None)
        if b.is_en_passant(m):
            ids.pop(m.to_square - 8 if b.turn else m.to_square + 8, None)
        if b.is_castling(m):
            rank = chess.square_rank(m.from_square)
            rf, rt = (7, 5) if b.is_kingside_castling(m) else (0, 3)
            ids[chess.square(rt, rank)] = ids.pop(chess.square(rf, rank))
        b.push(m)
        ids[m.to_square] = moved
        nodes.append((b.copy(), ids, m))
    return nodes


def in_shield(b, sq):
    """True when the pawn on sq shields its own king on a wing of the king's back two ranks."""
    c = b.color_at(sq)
    k = b.king(c)
    f, r = chess.square_file(k), chess.square_rank(k)
    ahead = (chess.square_rank(sq) - r) * (1 if c else -1)
    return (r if c else 7 - r) <= 1 and f not in (3, 4) and abs(chess.square_file(sq) - f) <= 1 and 0 <= ahead <= 2


def reaches(b, sq, sqs):
    """True when the piece on sq sees along the file into the enemy's three home ranks, onto an
    empty square or an undefended enemy man."""
    c = b.color_at(sq)
    return any((chess.square_rank(s) >= 5 if c else chess.square_rank(s) <= 2)
               and (b.piece_at(s) is None or b.color_at(s) != c and not b.is_attacked_by(not c, s))
               for s in b.attacks(sq) & sqs)


def touched(pb, m):
    """Files a rook or queen moves on, onto or off, or a pawn leaves by capturing, or a pawn,
    rook or queen dies on."""
    out, p, x = set(), pb.piece_at(m.from_square), pb.piece_at(m.to_square)
    ff, tf = chess.square_file(m.from_square), chess.square_file(m.to_square)
    if p.piece_type in HEAVY:
        out |= {ff, tf}
    elif p.piece_type == chess.PAWN and ff != tf:
        out.add(ff)
    if x and x.piece_type in HEAVY + (chess.PAWN,):
        out.add(tf)
    return out


def file_owner(b, f):
    """(color, square of its rook or queen) when only that side holds open file f, else None."""
    sqs = chess.SquareSet(chess.BB_FILES[f])
    if sqs & b.pieces_mask(chess.PAWN, chess.WHITE) | sqs & b.pieces_mask(chess.PAWN, chess.BLACK):
        return None
    on = {c: [s for s in sqs if b.piece_type_at(s) in HEAVY and b.color_at(s) == c and reaches(b, s, sqs)]
          for c in chess.COLORS}
    for c in chess.COLORS:
        rival = [s for t in HEAVY for s in b.pieces(t, not c)]
        if on[c] and not any(b.color_at(s) == (not c) and b.piece_type_at(s) in HEAVY for s in sqs) and rival:
            return c, on[c][0]
    return None


def events(fen, pv):
    nodes = walk(fen, pv)
    at = [{pid: chess.square_name(sq) for sq, pid in ids.items()} for _, ids, _ in nodes]
    out = []

    def add(kind, piece, ply, **extra):
        names = [piece] + ([extra["other"]] if "other" in extra else [])
        extra.setdefault("at", [at[ply].get(n) or at[ply - 1].get(n) for n in names])
        out.append({"type": kind, "piece": piece, "ply": ply, **extra})

    for i in range(1, len(nodes)):
        (pb, pids, _), (b, ids, m) = nodes[i - 1], nodes[i]
        moved = ids[m.to_square]
        tactics.move_events(pb, b, m, ids, add, i)
        # a shield pawn moves (pushed or capturing) or is taken
        for sq in (m.from_square, m.to_square):
            p = pb.piece_at(sq)
            if p and p.piece_type == chess.PAWN and (sq == m.from_square) == (p.color == pb.turn) and in_shield(pb, sq):
                if b.pieces(chess.QUEEN, not p.color) or len([s for t in HEAVY for s in b.pieces(t, not p.color)]) >= 2:
                    add("shield", pids[sq], i, other=pids[pb.king(p.color)], how="pushed" if sq == m.from_square else "taken")
        p = b.piece_at(m.to_square)
        rel = chess.square_rank(m.to_square) if p.color else 7 - chess.square_rank(m.to_square)
        if p.piece_type in VALUE and rel >= 5 and not any(
                b.piece_at(s) == chess.Piece(chess.PAWN, not p.color) for s in b.attackers(not p.color, m.to_square)):
            add("enter", moved, i, square=chess.square_name(m.to_square), capture=pb.is_capture(m), check=b.is_check())
    # a mate threat answered by taking the threatening piece was never a threat
    out = [e for e in out if not (e["type"] == "mate_threat" and e["ply"] + 1 < len(nodes)
                                  and nodes[e["ply"] + 1][2].to_square == nodes[e["ply"]][2].to_square)]
    b, ids, m = nodes[-1]
    if b.is_checkmate():
        add("mate", ids[m.to_square], len(nodes) - 1, at=[chess.square_name(m.to_square)])
    root = chess.Board(fen).turn
    more, mate = ([], None) if b.is_game_over() else tactics.tail(b, root)
    tactics.exchanges(walk(fen, pv[:len(nodes) - 1] + more), len(nodes) - 1, add)
    line = {"kz": [{ids[k]: n for k, n in tactics.king_zone(nb).items()} for nb, ids, _ in nodes], "mate": mate,
            "gone": [tactics.pieces_gone(nodes[0][0], nb) for nb, _, _ in nodes],
            "files": [{"abcdefgh"[f]: ("white" if own[0] else "black", nids[own[1]], chess.square_name(own[1]))
                       for f in range(8) for own in [file_owner(nb, f)] if own} for nb, nids, _ in nodes],
            "touched": [set().union(*[touched(nodes[j - 1][0], nodes[j][2]) for j in range(1, i + 1)])
                        for i in range(len(nodes))],
            "last": len(nodes) - 1}
    return out, at, line


def fewer(a, b, at, kind):
    """Pieces with at least two fewer of a per-ply count on average in line a than in line b,
    over the plies both reach or over the first two of them."""
    out = []
    for pid in a[0]:
        plies = [i for i in range(1, min(len(a), len(b))) if pid in a[i] and pid in b[i]]
        if plies:
            d = max(sum(b[i][pid] - a[i][pid] for i in span) / len(span) for span in (plies, plies[:2]))
            if d >= 2:
                # the ply with the widest gap, for a count the reader can check on the board
                w = max(plies, key=lambda i: b[i][pid] - a[i][pid])
                out.append({"type": kind, "piece": pid, "ply": plies[0], "fewer": round(d, 1), "worst": w,
                            "here": -a[w][pid], "there": -b[w][pid], "at": [at[plies[0]][pid]]})
    return out


def candidates(r):
    """Events found in one line and not the other, for one card."""
    ev, at, ln = {}, {}, {}
    for line in ("played", "best"):
        ev[line], at[line], ln[line] = events(r["fen"], r[f"{line}_pv"])
    other = {"played": "best", "best": "played"}
    root = chess.Board(r["fen"])
    lead = sum(VALUE.get(p.piece_type, 1) * (1 if p.color else -1) for p in root.piece_map().values() if p.piece_type != chess.KING)
    for line in ev:
        o = other[line]
        # more attacked squares around a king = fewer safe ones: compare negated counts
        neg = lambda kz: [{k: -n for k, n in d.items()} for d in kz]
        ev[line] += fewer(neg(ln[line]["kz"]), neg(ln[o]["kz"]), at[line], "king_exposed")
        mate, omate = ln[line]["mate"], ln[o]["mate"]
        if mate is not None and (omate is None or (omate > 0) != (mate > 0)):
            ev[line].append({"type": "forced_mate", "piece": None, "ply": ln[line]["last"], "n": mate, "at": []})
        k = min(ln[line]["last"], ln[o]["last"])
        for f, (side, pid, sq) in ln[line]["files"][k].items():
            live = "abcdefgh".index(f) in ln[line]["touched"][k] | ln[o]["touched"][k]
            if live and ln[o]["files"][k].get(f, (None,))[0] != side:
                ev[line].append({"type": "open_file", "piece": pid, "ply": k, "side": side, "file": f, "at": [sq]})
        extra = list(ln[line]["gone"][k])
        for p in ln[o]["gone"][k]:
            if p in extra:
                extra.remove(p)
        worth = lambda white: sum(VALUE[chess.Piece.from_symbol(p).piece_type] for p in extra if p.isupper() == white)
        # an uneven trade is won or lost material, which material reports
        if len(ln[line]["gone"][k]) - len(ln[o]["gone"][k]) >= 2 and abs(worth(True) - worth(False)) < 2:
            ev[line].append({"type": "trades", "piece": None, "ply": k, "gone": ln[line]["gone"][k],
                             "other_gone": ln[o]["gone"][k], "lead": lead, "at": []})
    # an exchange is the same when the same side wins the same pieces for the same price
    def key(e):
        if e["type"] == "material":
            return repr((e["type"], e["side"], sorted(e["won"]), sorted(e["lost"])))
        if e["type"] == "open_file":
            return repr((e["type"], e["side"], e["file"]))
        return repr((e["type"], e["piece"]))
    keys = {line: {key(e) for e in es} for line, es in ev.items()}
    out = [{"line": line, **e} for line, es in ev.items() for e in es
           if e["piece"] is None or key(e) not in keys[other[line]]]
    # the best line is good for the mover, so the opponent winning material there is an unfinished sacrifice
    mover = "white" if root.turn else "black"
    out = [c for c in out if not (c["type"] == "material" and c["line"] == "best" and c["side"] != mover)]
    # material won or a square entered inside a mating line is part of the mate
    mating = {c["line"] for c in out if c["type"] in ("mate", "forced_mate")}
    out = [c for c in out if not (c["type"] in ("material", "enter") and c["line"] in mating)]
    # entering, forking or threatening mate explains a line only for the side that line favours
    out = [c for c in out if c["type"] not in ("enter", "fork", "mate_threat")
           or (root.piece_at(chess.parse_square(c["piece"])).color == root.turn) == (c["line"] == "best")]
    # a capture on entry or a fork with check is the material or mate its line already reports
    tac = {c["line"] for c in out if c["type"] in ("material", "mate", "forced_mate")}
    out = [c for c in out if not (c["line"] in tac and (c["type"] == "enter" and c["capture"] and not c["check"]
                                                        or c["type"] == "fork" and c["check"]))]
    out += positional.facts(r["fen"], r["played_pv"], r["best_pv"])
    # a card about lost material or mate does not need positional facts, nor a drawing check next to a mate
    if any(c["type"] in ("material", "mate", "forced_mate") for c in out):
        out = [c for c in out if c["type"] not in ("shield", "open_file", "outpost", "piece_harassed", "pawn_weakness")]
    if any(c["type"] in ("mate", "forced_mate") for c in out):
        out = [c for c in out if c["type"] != "draw_risk"]
    # next to won or lost material, king exposure is only the material changing hands
    elif any(c["type"] == "material" for c in out):
        out = [c for c in out if c["type"] != "king_exposed"]
    return sorted(out, key=lambda c: (ORDER.index(c["type"]), c["line"] != "played", c["ply"]))


def main():
    rows = [json.loads(l) for l in (HERE / "positions.jsonl").read_text(encoding="utf-8").splitlines()]
    gold = {g["chk"]: g for g in map(json.loads, (HERE / "gold.jsonl").read_text(encoding="utf-8").splitlines())}
    counts, kinds, out = [], Counter(), []
    for r in rows:
        if r["played_pv"][:1] == r["best_pv"][:1]:
            continue
        cands = candidates(r)
        counts.append(len(cands))
        kinds.update(c["type"] for c in cands)
        out.append({"id": r["id"], "chk": r["chk"], "candidates": cands})
        g = gold.get(r["chk"])
        if g:
            hit = [c for c in cands if c["line"] == g["line"] and c["type"] == g["type"]
                   and (c["piece"] == g["piece"] if "piece" in g else c.get("by") == g["by"])]
            print(f"{g['chk']} {'HIT ' if hit else 'MISS'} {g['type']:12} {len(cands):3} candidates  {g['why']}")
            if not hit:
                for c in cands:
                    print("      ", c)
    (HERE / "candidates.jsonl").write_text("".join(json.dumps(o) + "\n" for o in out), encoding="utf-8")
    q = statistics.quantiles(counts, n=10)
    print(f"\n{len(counts)} cards with played != best; candidates per card: median {statistics.median(counts)}, "
          f"p90 {q[-1]}, max {max(counts)}, zero {counts.count(0)}")
    print(dict(kinds.most_common()))


if __name__ == "__main__":
    main()
