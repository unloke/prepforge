"""Research only. Tactical and material relations along an engine line, for enumerate.py.

Per move (the mover's view, right after the move):
- fork: the moved piece attacks two or more targets, each the king, worth more than it, or
  undefended and worth at least a minor piece;
- mate_threat: were the opponent to pass, the mover would mate next move.
Per exchange (a run of consecutive captures, joined by a later recapture of the same piece on the
same square after quiet moves, and finished by Stockfish's own captures when the line stops
mid-exchange): material, when one side comes out ahead, with the pieces won and given. The
last exchange is dropped when the winner, to move at the end, has two pieces en prise and can
save only one, which wipes out the gain, and Stockfish's eval there does not back the gain.
Per line: mate (the line ends in mate), and Stockfish's forced mate at its end. Between lines:
mate, king exposure (attacked squares around a king) and how many pieces come off.

Stockfish is production's engine (the stockfish 19 lite package under node) at the screen depth
analysis limits (more threads and hash than the browser), cached by FEN in sf_cache.jsonl.
"""
import json
import os
import pathlib
import signal

import chess
import chess.engine

HERE = pathlib.Path(__file__).parent
ENGINE = ["node", str(HERE.parents[1] / "node_modules/stockfish/bin/stockfish-19-lite.js")]
LIMIT = chess.engine.Limit(depth=12, nodes=1_500_000)  # the screen depth of a game analysis (tiered-analysis.js)
CACHE = HERE / "sf_cache.jsonl"
_cache, _engine = None, None

VAL = {chess.PAWN: 1, chess.KNIGHT: 3, chess.BISHOP: 3, chess.ROOK: 5, chess.QUEEN: 9, chess.KING: 100}


def close():
    """Kill the engine process. Scripts call it before they end: the wasm build ignores "quit", so
    SimpleEngine.close() alone, or interpreter shutdown (it joins the engine thread), waits forever."""
    global _engine
    if _engine is not None:
        e, _engine = _engine, None
        try:
            os.kill(e.protocol.transport.get_pid(), signal.SIGTERM)  # TerminateProcess on Windows
        except OSError:
            pass
        e.close()


def analyse(b):
    """{"cp", "mate", "pv"} for the side to move."""
    global _cache, _engine
    if _cache is None:
        _cache = {}
        if CACHE.exists():
            for line in CACHE.read_text(encoding="utf-8").splitlines():
                row = json.loads(line)
                _cache[row["fen"]] = row
    fen = b.fen()
    if fen not in _cache:
        if _engine is None:
            _engine = chess.engine.SimpleEngine.popen_uci(ENGINE)
            _engine.configure({"Threads": 8, "Hash": 256})
        info = _engine.analyse(b, LIMIT)
        score = info["score"].relative
        row = {"fen": fen, "cp": score.score(), "mate": score.mate(), "pv": [m.uci() for m in info.get("pv", [])],
               "depth": info.get("depth")}
        with CACHE.open("a", encoding="utf-8") as f:
            f.write(json.dumps(row) + "\n")
        _cache[fen] = row
    return _cache[fen]


def tail(b, color):
    """(Stockfish's captures that continue from the end of a line, Stockfish's mate distance with
    a positive sign when `color` mates, else None)."""
    a = analyse(b)
    mate = None if a["mate"] is None else (a["mate"] if b.turn == color else -a["mate"])
    t, out = b.copy(stack=False), []
    for u in a["pv"]:
        m = chess.Move.from_uci(u)
        if not (t.is_capture(m) or m.promotion):
            break
        out.append(u)
        t.push(m)
    return out, mate


def exchanges(nodes, last, add):
    """material events for runs of consecutive captures; nodes may run past the line's `last`
    ply into Stockfish's tail."""
    runs = []
    for i in range(1, len(nodes)):
        m = nodes[i][2]
        if not (nodes[i - 1][0].is_capture(m) or m.promotion):
            continue
        # a delayed recapture of the same piece on the same square finishes that exchange, together
        # with any captures made in between (Bxg3 Nb4 Nxb4 hxg3 is one exchange)
        k = next((k for k in range(len(runs) - 1, -1, -1) if m.to_square == nodes[runs[k][-1]][2].to_square
                  and nodes[i - 1][1].get(m.to_square) == nodes[runs[k][-1]][1][m.to_square]), None)
        if k is not None:
            runs[k:] = [sum(runs[k:], []) + [i]]
        elif runs and i == runs[-1][-1] + 1:
            runs[-1].append(i)
        else:
            runs.append([i])
    found = []
    for run in runs:
        first = nodes[run[0] - 1][0].turn
        won, lost, net = [], [], 0
        for j in run:
            pb, m = nodes[j - 1][0], nodes[j][2]
            x = pb.piece_at(m.to_square)
            got = [x.symbol().lower() if x else "p"] if pb.is_capture(m) else []
            v = taken(pb, m) + (VAL[m.promotion] - 1 if m.promotion else 0)
            (won if pb.turn == first else lost).extend(got + (["=" + chess.piece_symbol(m.promotion)] if m.promotion else []))
            net += v if pb.turn == first else -v
        if net and not nodes[run[-1]][0].is_checkmate():  # a mating capture is the mate
            side = first if net > 0 else not first
            won, lost = (won, lost) if net > 0 else (lost, won)
            for p in list(won):  # like for like cancels out: Q and R for Q is a rook
                if p in lost:
                    won.remove(p)
                    lost.remove(p)
            j = next(j for j in run if nodes[j - 1][0].turn == side)
            found.append(dict(kind="material", piece=nodes[j][1][nodes[j][2].to_square], ply=min(j, last),
                              side="white" if side else "black", net=abs(net), won=won, lost=lost,
                              at=[chess.square_name(nodes[j][2].to_square)] if j <= last else []))
    b = nodes[-1][0]
    if found and not b.is_game_over():
        e = found[-1]
        x = e["side"] == "white"
        h = en_prise(b, x)
        cp = analyse(b)["cp"]
        if b.turn == x and len(h) >= 2 and e["net"] - h[1] <= 0 and cp is not None and cp < (e["net"] - 1) * 100:
            found.pop()
    for e in found:
        add(e.pop("kind"), e.pop("piece"), e.pop("ply"), **e)


def en_prise(b, c):
    """Values of c's pieces (not pawns or the king) attacked by a cheaper man or attacked and
    undefended, highest first."""
    out = []
    for sq in chess.SquareSet(b.occupied_co[c] & ~b.pawns & ~b.kings):
        att = b.attackers(not c, sq)
        if att and (min(VAL[b.piece_type_at(a)] for a in att) < VAL[b.piece_type_at(sq)] or not b.attackers(c, sq)):
            out.append(VAL[b.piece_type_at(sq)])
    return sorted(out, reverse=True)


def defended(b, sq, color):
    return bool(b.attackers(color, sq))


def taken(board, move):
    x = board.piece_at(move.to_square)
    return VAL[x.piece_type] if x else (1 if board.is_en_passant(move) else 0)


def move_events(pb, b, m, ids, add, i):
    """Tactical events of move m (board pb before, b after)."""
    c = pb.turn
    to = m.to_square
    p = b.piece_at(to)
    moved = ids[to]
    v = VAL[p.piece_type]
    name = chess.square_name

    # fork: skip when the forking piece just hangs to a cheaper attacker or is simply undefended
    attackers = b.attackers(not c, to)
    safe = not attackers or (defended(b, to, c) and min(VAL[b.piece_type_at(s)] for s in attackers) >= v)
    if safe or b.is_check():
        targets = [t for t in b.attacks(to) & b.occupied_co[not c]
                   if b.piece_type_at(t) == chess.KING or VAL[b.piece_type_at(t)] > v
                   or (VAL[b.piece_type_at(t)] >= 3 and not defended(b, t, not c))]
        if len(targets) >= 2:
            add("fork", moved, i, targets=[name(t) for t in targets], check=b.is_check(), at=[name(to)] + [name(t) for t in targets])

    # mate threat: let the opponent pass and look for a mate in one
    if not b.is_check() and not b.is_game_over():
        t = b.copy(stack=False)
        t.push(chess.Move.null())
        for mm in t.legal_moves:
            t.push(mm)
            mate = t.is_checkmate()
            t.pop()
            if mate:
                add("mate_threat", moved, i, square=name(mm.to_square), at=[name(to), name(mm.to_square)])
                break


def king_zone(b):
    """{king square: enemy-attacked squares around it, the king's own square included}."""
    out = {}
    for c in chess.COLORS:
        k = b.king(c)
        zone = b.attacks(k) | chess.SquareSet([k])
        out[k] = sum(1 for s in zone if b.is_attacked_by(not c, s))
    return out


def pieces_gone(first, last):
    """Symbols of the pieces (not pawns or kings) on `first` that are no longer on `last`."""
    out = []
    for c in chess.COLORS:
        for t in (chess.QUEEN, chess.ROOK, chess.BISHOP, chess.KNIGHT):
            out += [chess.Piece(t, c).symbol()] * max(0, len(first.pieces(t, c)) - len(last.pieces(t, c)))
    return out
