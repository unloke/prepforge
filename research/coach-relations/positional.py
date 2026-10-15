"""Research only. Positional facts between the played and best lines, for enumerate.py.

Ported from two Freebuff detector runs (artifacts/benchmarks/coach-relations-20261014), keeping the
detectors that held up on a board check:
- outpost: a knight or bishop lands on a central square (files c-f, relative ranks 4-6) that a
  friendly pawn defends, no enemy pawn can ever attack, and it still holds at the end of the line,
  never reached in the other line. Played line: the opponent's outpost; best line: the mover's;
- piece_harassed: a piece goes out, a cheaper enemy piece newly attacks it, and it moves away
  without capturing or checking (or a queen out from home is sent back to its first two ranks); a
  ply-1 pawn push kicks back an advanced enemy minor piece; or a ply-1 queen sortie from d1/d8
  meets three undeveloped enemy minor pieces, one of which can develop onto it with tempo. Played
  line: the mover's piece; best line: the opponent's;
- restricted: at the common ply a knight, bishop, rook or queen off its first rank loses material
  (static exchange) on every legal move and a cheaper enemy piece attacks it or can after one
  quiet move; still so at the line's end, and no piece of that kind is restricted in the other
  line. Played line: the mover's piece; best line: the opponent's (the played line lets it out);
- pawn_weakness: in the played line the first move is a pawn push that leaves a friendly pawn on
  relative rank 3 or more without pawn support, and that pawn is still there at the common ply; or
  at the common ply a new isolated pawn on files c-f is attacked more than defended (on d or e,
  simply undefended), or on files a, b, g or h is attacked at least as often as defended, can be
  attacked by an enemy piece, lasts to the end of the line, and no material is lost on the way.
  Played line: the mover's pawns; best line: the opponent's. Also a hole: the ply-1 push takes the
  last pawn able to cover a square on files c-f, ranks 4-6 for the opponent, that an enemy pawn
  can cover and an enemy knight or bishop can reach in two moves; the best line keeps the cover;
- draw_risk: a line ends in stalemate and the other does not; or in the played line the opponent
  gives two or more checks including the last move, the best line has none, and the mover is two
  points up at the end of either line;
- passed_pawn: at the end of a line a side has a passed pawn on a file where it has none at the
  root nor at the end of the other line, and the pawn is not attacked more often than defended.
  Played line: the opponent's; best line: the mover's;
- bishop_pair: a knight takes a bishop within four plies and is taken back, and the side that took
  keeps both bishops to the end of the line while the other has fewer; the other line does not end
  that way. Played line: the opponent takes; best line: the mover;
- queen_chased: in the whole engine line the queen is newly attacked by a cheaper man twice within
  plies 2-9 (the first by ply 4) and each time moves away without capturing or checking, ending on
  its first two ranks or where it started; not so in the other line. Played line: the mover's
  queen; best line: the opponent's;
- promotion: in the whole engine line a pawn passed at the root promotes within 16 plies and its
  side is still 3 or more points up at the line's end; not so in the other line. Played line: the
  opponent's pawn; best line: the mover's;
- castling: a side that could castle at the root loses every castling right without castling, by
  a king move in the line or by a king move answering check in Stockfish's next four plies after
  it, while in the other line it castles or keeps a right. Played line: the mover; best line: the
  opponent.
Each fact carries text_zh for the review page. Facts are returned per line, already contrastive.
"""
import chess

import tactics

VAL = {chess.PAWN: 1, chess.KNIGHT: 3, chess.BISHOP: 3, chess.ROOK: 5, chess.QUEEN: 9, chess.KING: 100}
ZH = {chess.PAWN: "兵", chess.KNIGHT: "馬", chess.BISHOP: "象", chess.ROOK: "車", chess.QUEEN: "后"}
name = chess.square_name


def side(c):
    return "白方" if c else "黑方"


def rel(sq, c):
    return chess.square_rank(sq) if c else 7 - chess.square_rank(sq)


def material(b, c):
    return sum(VAL[p.piece_type] * (1 if p.color == c else -1) for p in b.piece_map().values() if p.piece_type != chess.KING)


def walk(fen, pv):
    """[(board, move that led here)], starting with (root, None)."""
    b, out = chess.Board(fen), []
    out.append((b.copy(), None))
    for u in pv:
        m = chess.Move.from_uci(u)
        if m not in b.legal_moves:
            break
        b.push(m)
        out.append((b.copy(), m))
    return out


def fact(kind, line, ply, color, squares, text, **what):
    return {"type": kind, "line": line, "ply": ply, "piece": None, "side": "white" if color else "black",
            "at": [name(s) for s in squares], "text_zh": text, **what}


def is_outpost(b, sq, c):
    p = b.piece_at(sq)
    if not p or p.color != c or p.piece_type not in (chess.KNIGHT, chess.BISHOP):
        return False
    if chess.square_file(sq) not in (2, 3, 4, 5) or rel(sq, c) not in (3, 4, 5):
        return False
    if any(abs(chess.square_file(e) - chess.square_file(sq)) == 1 and rel(e, c) > rel(sq, c)
           for e in b.pieces(chess.PAWN, not c)):
        return False
    if not any(b.piece_type_at(a) == chess.PAWN for a in b.attackers(c, sq)):
        return False
    return len(b.attackers(c, sq)) >= len(b.attackers(not c, sq))


def outposts(lines, mover):
    out = []
    for line, other in (("played", "best"), ("best", "played")):
        nodes, b0 = lines[line], lines[line][0][0]
        for i, (b, m) in enumerate(nodes[1:], 1):
            p = b.piece_at(m.to_square)
            if (p.color == mover) == (line == "played"):
                continue
            sq = m.to_square
            if (is_outpost(b, sq, p.color) and is_outpost(nodes[-1][0], sq, p.color) and not is_outpost(b0, sq, p.color)
                    and not any(is_outpost(ob, sq, p.color) for ob, _ in lines[other][1:])):
                out.append(fact("outpost", line, i, p.color, [sq],
                                f"{side(p.color)}的{ZH[p.piece_type]}佔據 {name(sq)} 前哨格，有兵保護，對方的兵趕不走它",
                                by=p.symbol().lower()))
                break
    return out


def chased(nodes):
    """(ply, color, type, square, retreat square, kind) of pieces sent back with loss of tempo."""
    hits = []
    for i in range(1, len(nodes) - 2):
        (b0, _), (b1, m1), (b2, m2), (b3, m3) = nodes[i - 1:i + 3]
        sq, p = m1.to_square, b1.piece_at(m1.to_square)
        if p.piece_type in (chess.PAWN, chess.KING) or m3.from_square != sq or b2.is_capture(m3) or b3.is_check():
            continue
        cheaper = lambda b: [a for a in b.attackers(not p.color, sq) if VAL[b.piece_type_at(a)] < VAL[p.piece_type]]
        if cheaper(b2) and not cheaper(b1) and not b1.is_capture(m2):
            hits.append((i + 2, p.color, p.piece_type, sq, m3.to_square, "chased"))
        elif (i == 1 and p.piece_type == chess.QUEEN and rel(m1.from_square, p.color) == 0 and not b0.is_capture(m1)
              and rel(sq, p.color) >= 3 and rel(m3.to_square, p.color) <= 1 and not b1.is_capture(m2)):
            hits.append((i + 2, p.color, p.piece_type, sq, m3.to_square, "chased"))
    for i in range(1, len(nodes)):
        b0, m = nodes[i - 1][0], nodes[i][1]
        p = b0.piece_at(m.from_square)
        if p.piece_type in (chess.PAWN, chess.KING) or b0.is_capture(m) or nodes[i][0].is_check():
            continue
        sq, at = m.from_square, m.to_square
        for j in range(i + 2, len(nodes), 2):  # follow the piece while it moves without capturing or checking
            bj, mj = nodes[j - 1][0], nodes[j][1]
            if bj.piece_at(at) != p:
                break
            if mj.from_square != at:
                continue
            if bj.is_capture(mj) or nodes[j][0].is_check():
                break
            if mj.to_square == sq and not any(h[:2] == (j, p.color) for h in hits):
                hits.append((j, p.color, p.piece_type, at, sq, "round_trip"))
                break
            at = mj.to_square
    if len(nodes) >= 3:
        (b0, _), (b1, m1), (b2, m2) = nodes[:3]
        kicker, victim = b1.piece_at(m1.to_square), b1.piece_at(m2.from_square)
        if (kicker.piece_type == chess.PAWN and not b0.is_capture(m1) and victim.piece_type in (chess.KNIGHT, chess.BISHOP)
                and m2.from_square in b1.attacks(m1.to_square) and not b1.is_capture(m2) and not b2.is_check()
                and rel(m2.from_square, victim.color) >= 3 and rel(m2.to_square, victim.color) < rel(m2.from_square, victim.color)):
            hits.append((2, victim.color, victim.piece_type, m2.from_square, m2.to_square, "kick"))
    if len(nodes) >= 2:
        (b0, _), (b1, m1) = nodes[:2]
        q = b1.piece_at(m1.to_square)
        home = chess.D1 if b0.turn else chess.D8
        if q.piece_type == chess.QUEEN and m1.from_square == home and not b1.is_check() and rel(m1.to_square, q.color) >= 3:
            undeveloped = [s for s in b1.pieces(chess.KNIGHT, not q.color) | b1.pieces(chess.BISHOP, not q.color)
                           if rel(s, not q.color) == 0]
            if len(undeveloped) >= 3 and not any(h[3] == m1.to_square for h in hits):
                for m in b1.legal_moves:
                    if m.from_square in undeveloped and not b1.is_capture(m):
                        b1.push(m)
                        hit = m1.to_square in b1.attacks(m.to_square) and (
                            not b1.attackers(q.color, m.to_square) or bool(b1.attackers(not q.color, m.to_square)))
                        b1.pop()
                        if hit:
                            hits.append((1, q.color, chess.QUEEN, m1.to_square, m.to_square, "early_queen"))
                            break
    return hits


def harassed(lines, mover):
    found = {line: chased(nodes) for line, nodes in lines.items()}
    out = []
    for line, other in (("played", "best"), ("best", "played")):
        seen = {h[1:4] for h in found[other]}
        for ply, c, pt, sq, to, kind in found[line]:
            if (c, pt, sq) in seen or (c == mover) != (line == "played"):
                continue
            text = {"early_queen": f"{side(c)}的后太早出到 {name(sq)}，對方可以出子到 {name(to)} 先手攻擊它",
                    "kick": f"{side(not c)}推兵把 {name(sq)} 的{ZH[pt]}趕回 {name(to)}",
                    "chased": f"{side(c)}的{ZH[pt]}走到 {name(sq)} 後被趕回 {name(to)}，白白浪費步數",
                    "round_trip": f"{side(c)}的{ZH[pt]}出到 {name(sq)} 又走回 {name(to)}，白跑一趟"}[kind]
            out.append(fact("piece_harassed", line, ply, c, [sq, to], text, what=kind, by=chess.piece_symbol(pt)))
    return out


def see(b, sq, enemy):
    """What `enemy` wins by capturing on `sq`, lowest-value attacker first, each side free to stop."""
    tb = b.copy(stack=False)
    tb.turn = enemy
    target = tb.piece_at(sq)
    caps = [m for m in tb.legal_moves if m.to_square == sq] if target else []
    if not caps:
        return 0
    tb.push(min(caps, key=lambda m: VAL[tb.piece_type_at(m.from_square)]))
    return max(0, VAL[target.piece_type] - see(tb, sq, not enemy))


def pawn_control(b, c, sq):
    """A pawn of c on an adjacent file behind sq, so it attacks sq now or after advancing."""
    return any(abs(chess.square_file(p) - chess.square_file(sq)) == 1 and rel(p, c) < rel(sq, c) for p in b.pieces(chess.PAWN, c))


def targetable(b, sq, c):
    """An enemy piece (not a pawn or king) attacks sq, or can after one quiet move to a safe square."""
    if any(b.piece_type_at(a) not in (chess.PAWN, chess.KING) for a in b.attackers(not c, sq)):
        return True
    tb = b.copy(stack=False)
    tb.turn = not c
    for m in list(tb.legal_moves):
        if tb.piece_type_at(m.from_square) in (chess.PAWN, chess.KING) or tb.is_capture(m):
            continue
        tb.push(m)
        hit = sq in tb.attacks(m.to_square) and see(tb, m.to_square, c) == 0
        tb.pop()
        if hit:
            return True
    return False


def minor_reaches(b, sq, c):
    """Type of an enemy knight or bishop on sq or able to reach it in two moves, not stopping on a
    square a pawn of c attacks, with sq attacked no more by c than by the enemy on arrival."""
    tb = b.copy(stack=False)
    tb.turn = not c
    held = lambda: len(tb.attackers(not c, sq)) >= len(tb.attackers(c, sq))
    for start in [*b.pieces(chess.KNIGHT, not c), *b.pieces(chess.BISHOP, not c)]:
        if start == sq:
            return b.piece_type_at(sq)
        for m1 in [m for m in tb.legal_moves if m.from_square == start]:
            if m1.to_square != sq and (tb.is_capture(m1) or any(tb.piece_type_at(a) == chess.PAWN for a in tb.attackers(c, m1.to_square))):
                continue
            tb.push(m1)
            if m1.to_square == sq:
                ok = held()
            else:
                tb.turn = not c
                ok = chess.Move(m1.to_square, sq) in tb.legal_moves
                if ok:
                    tb.push(chess.Move(m1.to_square, sq))
                    ok = held()
                    tb.pop()
            tb.pop()
            tb.turn = not c
            if ok:
                return b.piece_type_at(start)
    return None


def isolated(b, c):
    pawns = b.pieces(chess.PAWN, c)
    files = {chess.square_file(s) for s in pawns}
    return {s for s in pawns if chess.square_file(s) - 1 not in files and chess.square_file(s) + 1 not in files}


def files(squares):
    return {chess.square_file(s) for s in squares}


def doubled(b, c):
    files = [chess.square_file(s) for s in b.pieces(chess.PAWN, c)]
    return {f for f in files if files.count(f) > 1}


def passed(b, c):
    """c's passed pawns: no enemy pawn ahead on the same or a neighbouring file."""
    return {s for s in b.pieces(chess.PAWN, c)
            if not any(abs(chess.square_file(e) - chess.square_file(s)) <= 1 and rel(e, c) > rel(s, c)
                       for e in b.pieces(chess.PAWN, not c))}


def passed_pawns(lines, mover):
    out, b0 = [], lines["played"][0][0]
    ends = {line: lines[line][-1][0] for line in lines}
    for line, other, c in (("played", "best", not mover), ("best", "played", mover)):
        e = ends[line]
        for f in sorted(files(passed(e, c)) - files(passed(ends[other], c)) - files(passed(b0, c))):
            sq = max((s for s in passed(e, c) if chess.square_file(s) == f), key=lambda s: rel(s, c))
            if len(e.attackers(not c, sq)) > len(e.attackers(c, sq)):
                continue  # about to be taken
            ply = next(i for i, (b, _) in enumerate(lines[line]) if f in files(passed(b, c)))
            out.append(fact("passed_pawn", line, max(ply, 1), c, [sq], f"{side(c)}在 {'abcdefgh'[f]} 線得到通路兵"))
    return out


def pawn_weakness(lines, mover):
    out = []
    k = min(len(lines["played"]), len(lines["best"])) - 1
    b0 = lines["played"][0][0]
    if k >= 1:
        b1, m1 = lines["played"][1]
        if b0.piece_type_at(m1.from_square) == chess.PAWN and not b0.is_capture(m1) and not b1.is_check():
            for t in b0.attacks(m1.from_square) & b0.pieces(chess.PAWN, mover):
                if (rel(t, mover) >= 2 and not any(b1.piece_type_at(a) == chess.PAWN for a in b1.attackers(mover, t))
                        and lines["best"][1][1].from_square != t
                        and lines["played"][k][0].piece_at(t) == chess.Piece(chess.PAWN, mover)):
                    out.append(fact("pawn_weakness", "played", 1, mover, [m1.to_square, t],
                                    f"{side(mover)}推 {name(m1.from_square)}-{name(m1.to_square)} 拆開兵鏈，{name(t)} 兵沒有兵保護了", what="chain"))
                    break
            # a hole: the pushed pawn was the only one that could cover a square, and by the end of the line none can
            end, end_best = lines["played"][-1][0], lines["best"][-1][0]
            others = b0.copy()
            others.remove_piece_at(m1.from_square)
            for sq in chess.SQUARES:
                if (abs(chess.square_file(sq) - chess.square_file(m1.from_square)) != 1 or chess.square_file(sq) not in (2, 3, 4, 5)
                        or rel(sq, not mover) not in (3, 4, 5) or not rel(m1.from_square, mover) < rel(sq, mover) <= rel(m1.to_square, mover) + 1
                        or material(end, mover) < material(b0, mover) or end.piece_type_at(sq) == chess.PAWN):
                    continue
                if (pawn_control(b0, mover, sq) and not pawn_control(others, mover, sq) and not pawn_control(end, mover, sq)
                        and pawn_control(end_best, mover, sq) and pawn_control(end, not mover, sq)):
                    pt = minor_reaches(end, sq, mover)
                    if pt:
                        out.append(fact("pawn_weakness", "played", 1, mover, [m1.to_square, sq],
                                        f"{side(mover)}推 {name(m1.to_square)} 後 {name(sq)} 再也沒有兵能控制，{side(not mover)[0]}{ZH[pt]}可以佔據", what="hole",
                                        by=chess.piece_symbol(pt)))
                        break
    # doubled pawns, compared at the end of each line: the structure lasts
    ends = {line: lines[line][-1][0] for line in lines}
    for line, other in (("played", "best"), ("best", "played")):
        for c in (mover, not mover):
            hurt = (c == mover) == (line == "played")
            new = doubled(ends[line], c) - doubled(ends[other], c)
            gone = doubled(ends[other], c) - doubled(ends[line], c)
            for f in sorted(new - doubled(b0, c) if hurt else gone & doubled(b0, c)):
                pawns = [s for s in ends[line].pieces(chess.PAWN, c) if chess.square_file(s) == f]
                if not pawns:
                    continue  # both pawns gone from the file: nothing was undoubled
                if hurt and any(len(ends[line].attackers(not c, s)) > len(ends[line].attackers(c, s)) for s in pawns):
                    continue  # a pawn about to be taken back is not a lasting structure
                if not hurt and not any(b.turn == c and b.piece_type_at(m.from_square) == chess.PAWN and chess.square_file(m.from_square) == f
                                        and b.is_capture(m) for (b, _), (_, m) in zip(lines[line], lines[line][1:])):
                    continue  # undoubled by c's own pawn capture, not by losing the pawn
                ply = next(i for i, (b, _) in enumerate(lines[line]) if (f in doubled(b, c)) == hurt)
                text = (f"{side(c)}在 {'abcdefgh'[f]} 線變成疊兵" if hurt else
                        f"{side(c)}的 {'abcdefgh'[f]} 線疊兵被解開了")
                out.append(fact("pawn_weakness", line, ply, c, pawns, text, what="doubled" if hurt else "undoubled"))
    for line, other in (("played", "best"), ("best", "played")):
        c = mover if line == "played" else not mover
        bk, ok = lines[line][k][0], lines[other][k][0]
        for sq in sorted(isolated(bk, c) - isolated(b0, c) - isolated(ok, c)):
            att, dfn = len(bk.attackers(not c, sq)), len(bk.attackers(c, sq))
            f = chess.square_file(sq)
            if f in (2, 3, 4, 5) and (att > dfn or f in (3, 4) and dfn == 0):
                out.append(fact("pawn_weakness", line, k, c, [sq], f"{side(c)}在 {name(sq)} 留下沒有保護的中央孤兵", what="isolated"))
            elif (f not in (2, 3, 4, 5) and dfn <= att and f not in doubled(bk, c) | files(isolated(b0, c)) | files(isolated(ok, c))
                  and not any(n[-1][0].is_checkmate() for n in lines.values())
                  and lines[line][-1][0].piece_at(sq) == chess.Piece(chess.PAWN, c)
                  and min(material(bk, c), material(lines[line][-1][0], c)) >= material(b0, c) and targetable(bk, sq, c)):
                out.append(fact("pawn_weakness", line, k, c, [sq], f"{side(c)} {name(sq)} 兵變成孤兵，對方可以攻擊它", what="isolated"))
    return out


def restricted(b, sq):
    """The knight, bishop, rook or queen on sq (off its first rank, not pinned, not in check) loses
    material on every legal move, and a cheaper enemy piece attacks it or can after one quiet move
    (directly or by uncovering it), the attacker safe."""
    p = b.piece_at(sq)
    if not p or p.piece_type in (chess.PAWN, chess.KING) or rel(sq, p.color) == 0 or b.is_game_over():
        return False
    c, v = p.color, VAL[p.piece_type]
    tb = b.copy(stack=False)
    tb.turn = c
    if tb.is_check() or tb.is_pinned(c, sq):
        return False
    for m in [m for m in tb.legal_moves if m.from_square == sq]:
        won = VAL[tb.piece_type_at(m.to_square)] if tb.is_capture(m) else 0
        tb.push(m)
        lost = see(tb, m.to_square, not c)
        tb.pop()
        if lost <= won:
            return False
    if any(VAL[b.piece_type_at(a)] < v for a in b.attackers(not c, sq)):
        return True
    tb.turn = not c
    for m in list(tb.legal_moves):
        if tb.is_capture(m):
            continue
        tb.push(m)
        hit = see(tb, m.to_square, c) == 0 and any(VAL[tb.piece_type_at(a)] < v and see(tb, a, c) == 0 for a in tb.attackers(not c, sq))
        tb.pop()
        if hit:
            return True
    return False


def restricted_pieces(lines, mover):
    out = []
    k = min(len(lines["played"]), len(lines["best"])) - 1
    if k < 1 or any(n[-1][0].is_checkmate() for n in lines.values()):
        return out
    for line, other in (("played", "best"), ("best", "played")):
        c = mover if line == "played" else not mover
        bk, ok, end = lines[line][k][0], lines[other][k][0], lines[line][-1][0]
        for sq in chess.SquareSet(bk.occupied_co[c]):
            pt = bk.piece_type_at(sq)
            if (restricted(bk, sq) and (end is bk or restricted(end, sq))
                    and not any(restricted(ok, o) for o in ok.pieces(pt, c))):
                out.append(fact("restricted", line, k, c, [sq], f"{side(c)[0]}{ZH[pt]} {name(sq)} 活動嚴重受限，缺乏安全退路",
                                by=chess.piece_symbol(pt)))
    return out


def draw_risk(lines, mover):
    out = []
    for line, other in (("played", "best"), ("best", "played")):
        if lines[line][-1][0].is_stalemate() and not lines[other][-1][0].is_stalemate():
            out.append(fact("draw_risk", line, len(lines[line]) - 1, mover, [], "這條變化走成逼和（無子可動）", what="stalemate"))
    checks = {line: [i for i in range(1, len(n)) if n[i - 1][0].turn != mover and n[i][0].is_check()]
              for line, n in lines.items()}
    p = lines["played"]
    last = len(p) - 1 if (len(p) - 1) % 2 == 0 else len(p) - 2
    if (len(checks["played"]) >= 2 and not checks["best"] and last in checks["played"]
            and max(material(p[-1][0], mover), material(lines["best"][-1][0], mover)) >= 2):
        k = p[-1][0].king(mover)
        out.append(fact("draw_risk", "played", checks["played"][-1], mover, [k],
                        f"{side(mover)}的王在 {name(k)} 缺乏掩護，對方可以連續將軍求和", what="perpetual"))
    return out


def castle_state(nodes, c):
    """(state, ply, (Stockfish moves after the line up to the loss, whether that king move answered
    check)) for color c; state is castled, kept, lost (a king move, after the line only out of check)
    or gone (lost any other way)."""
    b = nodes[-1][0]
    more = [] if b.is_game_over() else [chess.Move.from_uci(u) for u in tactics.analyse(b)["pv"][:4]]
    b = nodes[0][0].copy(stack=False)
    for i, m in enumerate([m for _, m in nodes[1:]] + more, 1):
        if b.turn == c and b.is_castling(m):
            return "castled", i, ([], False)
        king = b.turn == c and m.from_square == b.king(c)
        check = b.is_check()
        tail = more[:max(0, i - len(nodes) + 1)]
        b.push(m)
        if not b.has_castling_rights(c):
            return ("lost" if king and (i < len(nodes) or check) else "gone"), i, (tail, check)
    return "kept", len(nodes) - 1, ([], False)


def castling(lines, mover):
    out = []
    root = lines["played"][0][0]
    for line, other in (("played", "best"), ("best", "played")):
        c = mover if line == "played" else not mover
        if not root.has_castling_rights(c):
            continue
        state, ply, (tail, check) = castle_state(lines[line], c)
        ostate = castle_state(lines[other], c)[0]
        if state == "lost" and ostate in ("castled", "kept"):
            last = len(lines[line]) - 1
            b = lines[line][min(ply, last)][0].copy(stack=False)
            sans = []
            for m in tail:
                sans.append(b.san(m))
                b.push(m)
            how = f"引擎續著 {' '.join(sans)} 後，" if tail else ""
            keep = "已經易位" if ostate == "castled" else "仍保有易位權"
            out.append(fact("castling", line, min(ply, last), c, [b.king(c)],
                            f"{how}{side(c)}的王{'被將軍後' if check else ''}移動，失去易位權；另一條變化裡{keep}"))
    return out


def queen_chases(nodes, c, loose=False):
    """(attacking plies, final queen square) when c's queen is chased twice in plies 2-9 of a line: the
    other side's move newly attacks it with a cheaper man (the first by ply 4), and c's next move
    takes the queen away without capturing or checking; it ends on its first two ranks or where it
    started (loose: wherever it ends). None otherwise."""
    if len(nodes[0][0].pieces(chess.QUEEN, c)) != 1:
        return None
    q = start = next(iter(nodes[0][0].pieces(chess.QUEEN, c)))
    hits = []
    cheaper = lambda b, sq: any(VAL[b.piece_type_at(a)] < VAL[chess.QUEEN] for a in b.attackers(not c, sq))
    for i in range(1, min(len(nodes) - 1, 10)):
        (pb, _), (b, m), (nb, r) = nodes[i - 1], nodes[i], nodes[i + 1]
        if pb.turn == c and m.from_square == q:  # the queen moves
            q = m.to_square
        elif pb.turn != c and m.to_square == q:
            return None  # the queen is taken
        elif (pb.turn != c and cheaper(b, q) and not cheaper(pb, q) and r.from_square == q
                and not b.is_capture(r) and not nb.is_check()):
            hits.append(i)
            if len(hits) == 2:  # where the second retreat lands (later queen moves are not the chase)
                to = r.to_square
                return (hits, to) if hits[0] <= 4 and (rel(to, c) <= 1 or to == start or loose) else None
    return None


def queen_chased(lines, mover, full):
    """The queen chased twice (queen_chases) in one whole engine line and not in the other. Played
    line: the mover's queen; best line: the opponent's."""
    out = []
    for line, other in (("played", "best"), ("best", "played")):
        c = mover if line == "played" else not mover
        hit = queen_chases(full[line], c)
        if hit and not queen_chases(full[other], c, loose=True):
            (a1, a2), q = hit
            nodes = full[line]
            out.append(fact("queen_chased", line, a2 + 1, c, [q], f"{side(c)}的后被連續趕兩次，退回 {name(q)}",
                            chasers=[a1, a2]))
    return out


def promotes(nodes, c):
    """(plies of the pawn's moves, promotion ply) when a pawn of c's, passed at the root, promotes
    within 16 plies of the whole line and c is still at least 3 points up on the root balance at
    the line's end; None otherwise."""
    root = nodes[0][0]
    for i in range(1, min(len(nodes), 17)):
        pb, m = nodes[i - 1][0], nodes[i][1]
        if pb.turn == c and m.promotion:
            plies, sq = [i], m.from_square
            for j in range(i - 1, 0, -1):  # walk the pawn back to its root square
                if nodes[j][1].to_square == sq and nodes[j - 1][0].piece_type_at(nodes[j][1].from_square) == chess.PAWN:
                    plies.insert(0, j)
                    sq = nodes[j][1].from_square
            if sq not in passed(root, c):
                return None
            if material(nodes[-1][0], c) - material(root, c) >= 3:
                return plies, i
            return None
    return None


def promotion(lines, mover, full):
    """A passed pawn promotes in one whole engine line and the gain holds (promotes), not in the
    other. Played line: the opponent's pawn; best line: the mover's."""
    out = []
    for line, other in (("played", "best"), ("best", "played")):
        c = (not mover) if line == "played" else mover
        hit = promotes(full[line], c)
        if hit and not promotes(full[other], c):
            plies, i = hit
            out.append(fact("promotion", line, i, c, [full[line][i][1].to_square], f"{side(c)}的通路兵升變", pawn_plies=plies))
    return out


def bishop_pair(lines, mover, full):
    """A knight takes a bishop in the first four plies and is taken back, leaving the side that took
    with both bishops and the other with fewer to the end of the whole engine line (full); the
    other whole line does not end that way. doubled: the file, when a pawn takes back and stays
    doubled there to the end of the line, and the other line does not end doubled there. Played line: the opponent takes; best line: the mover."""
    out = []
    for line, other in (("played", "best"), ("best", "played")):
        f = (not mover) if line == "played" else mover
        nodes = full[line]
        pair = lambda b, c: len(b.pieces(chess.BISHOP, c)) >= 2
        for i in range(1, min(5, len(nodes) - 1)):
            (pb, _), (b, m), (_, r) = nodes[i - 1], nodes[i], nodes[i + 1]
            if (pb.turn == f and pb.piece_type_at(m.from_square) == chess.KNIGHT and pb.piece_type_at(m.to_square) == chess.BISHOP
                    and r.to_square == m.to_square and pair(pb, not f)
                    and all(pair(nb, f) and not pair(nb, not f) for nb, _ in nodes[i + 1:])
                    and not (pair(full[other][-1][0], f) and not pair(full[other][-1][0], not f))):
                fl = chess.square_file(m.to_square)
                doubled = lambda b: len(b.pieces(chess.PAWN, not f) & chess.BB_FILES[fl]) >= 2
                pawn = b.piece_type_at(r.from_square) == chess.PAWN
                dbl = pawn and not doubled(b) and all(doubled(nb) for nb, _ in nodes[i + 1:]) and not doubled(full[other][-1][0])
                out.append(fact("bishop_pair", line, i, f, [m.to_square],
                                f"{side(f)}用馬換掉對方在 {name(m.to_square)} 的象，取得雙象" + ("，對方疊兵" if dbl else ""),
                                doubled=chess.FILE_NAMES[fl] if dbl else None))
                break
    return out


def facts(fen, played_pv, best_pv, full_pv=None):
    """full_pv: {"played", "best"} whole engine lines, for facts that must last past the cut lines."""
    lines = {"played": walk(fen, played_pv), "best": walk(fen, best_pv)}
    full = {k: walk(fen, v) for k, v in full_pv.items()} if full_pv else lines
    mover = chess.Board(fen).turn
    return (outposts(lines, mover) + harassed(lines, mover) + restricted_pieces(lines, mover) + pawn_weakness(lines, mover)
            + passed_pawns(lines, mover) + bishop_pair(lines, mover, full) + queen_chased(lines, mover, full) + promotion(lines, mover, full) + draw_risk(lines, mover) + castling(lines, mover))
