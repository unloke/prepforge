"""Research only. A Coach explanation from the picked facts: fixed sentences and board marks.

  py research/coach-relations/explain.py [card id ...]     # default: the round-4 cards

Shield, open file, enter and king exposure never speak (the first blind A/B lost 11 of 12 of
them), nor a pawn left without pawn support (round 7: a remark, not a reason). The lines are the full engine PVs (production's depth-12/16 reads); explain.py decides how much
to show. Material is recounted from the root to the ply where the balance settles for the rest of
the line, Stockfish's captures past the line included, so a rook traded for a rook in two runs is no rook won; a recount that comes
out even, or with the wrong side ahead (the mover in the played line: the line stopped too early;
the opponent in the best line), is dropped. Lost castling speaks only when the king move answers a
check no other move meets. A pawn-sized gain (net under 3) where the losing side gives a pawn
away in the line (a quiet pawn move onto a square the other side takes, not taken back) is no
win: an engine gambit a reader cannot follow. Neither is a count whose last capture the losing side
can simply take back: the line (and Stockfish's capture tail) stopped at its edge. The first fact from pick.rank speaks; with none, quiet() names what the reply does and
what the best move does, from the board alone (attacks on pawns are not named: a side remark
that is not the reason). One reason per card: a second fact speaks only as the fork that wins
the first fact's material (round 7, after the user's round-6 review). Sentences follow the production Coach's voice
("Blunder. Nfe5 loses a bishop after ... d4 was the move."). Marks: the move behind each fact as
an arrow at its node, then the squares the facts name, at most three in all.
"""
import json
import pathlib
import sys

import chess

import positional
import tactics
from enumerate import candidates
from pick import rank

HERE = pathlib.Path(__file__).parent
PIECE = {"p": "pawn", "n": "knight", "b": "bishop", "r": "rook", "q": "queen", "k": "king"}
COUNT = {2: "two", 3: "three", 4: "four"}
GRADE = {"blunder": "Blunder.", "mistake": "Mistake."}
SILENT = {"shield", "open_file", "enter", "king_exposed"}
VAL = {"p": 1, "n": 3, "b": 3, "r": 5, "q": 9}
NUMBER = {1: "one"}
HORIZON = 10  # plies of the engine line a reason may come from or quote
WINDOW = 6  # plies after an exchange in which a taking back still belongs to it
MIN_PLIES = 4


def color(white):
    return "White" if white else "Black"


def pieces(lst):
    """["q", "p"] -> "the queen and a pawn"; ["p", "p"] -> "two pawns"."""
    out = []
    for p in dict.fromkeys(lst):
        n = lst.count(p)
        if p[0] == "=":
            out.append(f"a new {PIECE[p[1]]}")
        elif n > 1:
            out.append(f"{COUNT.get(n, n)} {PIECE[p]}s")
        else:
            out.append(f"the {PIECE[p]}" if p in "qk" else f"a {PIECE[p]}")
    return " and ".join(out)


class Line:
    """One engine line: boards, moves and SAN from the root."""

    def __init__(self, fen, pv):
        b = chess.Board(fen)
        self.boards, self.moves, self.sans = [b.copy()], [], []
        for u in pv:
            m = chess.Move.from_uci(u) if isinstance(u, str) else u
            if m not in b.legal_moves:
                break
            self.sans.append(b.san(m))
            self.moves.append(m)
            b.push(m)
            self.boards.append(b.copy())

    def seq(self, a, b):
        """Plies a..b, numbered: 27.Nd7 Qc6 28.Qf3, or 27...Nd7 28.Qc6."""
        out = []
        for i in range(a, min(b, len(self.sans)) + 1):
            pb = self.boards[i - 1]
            n = pb.fullmove_number
            out.append(f"{n}.{self.sans[i - 1]}" if pb.turn else f"{n}...{self.sans[i - 1]}" if i == a else self.sans[i - 1])
        return " ".join(out)

    def after(self, a, b):
        return f" after {self.seq(a, b)}" if b >= a else ""

    def paren(self, a, b):
        return f" ({self.seq(a, b)})" if b >= a else ""

    def name(self, ply, sq):
        """"the bishop on g4", or "the king"."""
        for b in (self.boards[ply], self.boards[max(0, ply - 1)]):
            p = b.piece_at(chess.parse_square(sq))
            if p:
                return "the king" if p.piece_type == chess.KING else f"the {PIECE[p.symbol().lower()]} on {sq}"
        return sq

    def arrow(self, line, k):
        m = self.moves[k - 1]
        return {"line": line, "ply": k, "from": chess.square_name(m.from_square), "to": chess.square_name(m.to_square)}


def horizon(fen, pv):
    """How much of an engine line the facts look at: MIN_PLIES, then on while the side to move is
    in check, the next move captures, or the last capture is taken back after one move in between;
    at most HORIZON."""
    b, ms, caps = chess.Board(fen), [chess.Move.from_uci(u) for u in pv[:HORIZON]], []
    for i, m in enumerate(ms):
        delayed = caps[-1:] == [True] and i + 1 < len(ms) and ms[i + 1].to_square == ms[i - 1].to_square
        if i >= MIN_PLIES and not (b.is_check() or b.is_capture(m) or delayed):
            return i
        caps.append(b.is_capture(m))
        b.push(m)
    return len(ms)


def kings_first(ln, k, squares):
    return sorted(squares, key=lambda s: ln.name(k, s) != "the king")


def phrase(f, ln, ext, a, root, row):
    """(verb phrase for what the line's first move does, last ply it needs, arrow, squares). The
    played move's phrase shows the moves from ply a (at least 2), the best move's from ply a. ext is
    the line with Stockfish's captures after it."""
    t, played = f["type"], f["line"] == "played"
    a = max(a, 2) if played else a
    k = max(1, min(f["ply"], len(ln.moves)))
    sq, arrow = list(f.get("at", [])), ln.arrow(f["line"], k)
    c = f.get("side") == "white"
    if t == "mate":
        n = k // 2 if played else (k + 1) // 2
        return f"{'allows mate in' if played else 'mates in'} {NUMBER.get(n, n)}: {ln.seq(a, k)}", k, arrow, []
    if t == "forced_mate":
        last = len(ln.moves)
        winner = root.turn if f["n"] > 0 else not root.turn
        n = abs(f["n"]) + (last // 2 if winner != root.turn else (last + 1) // 2)
        return f"{'allows' if winner != root.turn else 'forces'} mate in {n}", last, None, []
    if t == "mate_threat":
        if played:
            return f"allows {ln.seq(a, k)}, threatening mate on {f['square']}", k, arrow, [f["square"]]
        return f"threatens mate on {f['square']}{ln.paren(a, k)}", k, arrow, [f["square"]]
    if t == "material":
        what = pieces(f["won"]) + (f" for {pieces(f['lost'])}" if f["lost"] else "")
        # quote the line to the winner's last capture of a man it wins, or on to a later capture of its
        # until the count holds after the reply: later trades and take-backs are the count's, not the reader's
        w = f["side"] == "white"
        caps = [j for j in range(a, f["end"] + 1) if ext.boards[j - 1].turn == w and ext.boards[j - 1].is_capture(ext.moves[j - 1])]
        won = [j for j in caps if (ext.boards[j - 1].piece_at(ext.moves[j - 1].to_square) or chess.Piece(chess.PAWN, not w)).symbol().lower() in f["won"]]
        holds = lambda j: balance(ext.boards[min(j + 1, len(ext.moves))], w) - balance(ext.boards[0], w) >= f["net"]
        q = next((j for j in caps if j >= max(won, default=f["end"]) and holds(j)), f["end"])
        return (f"loses {what}{ext.after(a, q)}" if played else f"wins {what}{ext.paren(a, q)}"), q, arrow, []
    if t == "fork":
        targets = " and ".join(ln.name(k, s) for s in kings_first(ln, k, f["targets"]))
        if played:
            verb = f"allows {ln.seq(a, k)}, forking {targets}"
        else:
            verb = f"forks {targets}{ln.paren(a, k)}" if k == 1 else f"sets up {ln.seq(k, k)}, forking {targets}{ln.paren(a, k)}"
        return verb, k, arrow, f["targets"][:2]
    if t == "castling":
        cc = chess.WHITE if c else chess.BLACK
        _, ply, (tail, _) = positional.castle_state(positional.walk(row["fen"], row[f"{f['line']}_pv"]), cc)
        long = Line(row["fen"], ln.moves + tail)
        b = min(ply, len(long.moves))
        verb = (f"allows {long.seq(a, b)}, and the {color(cc).lower()} king can no longer castle" if played
                else f"drives the {color(cc).lower()} king out{long.paren(a, b)}, so {color(cc)} can no longer castle")
        return verb, b, None if tail else arrow, sq[:1]
    if t == "trades":
        extra = list(f["gone"])
        for p in f["other_gone"]:
            if p in extra:
                extra.remove(p)
        w = [p.lower() for p in extra if p.isupper()]
        b = [p for p in extra if p.islower()]
        what = " and ".join(x for x in (w and f"White's {pieces(w).split(' ', 1)[1]}", b and f"Black's {pieces(b).split(' ', 1)[1]}") if x)
        lead = f["lead"] if root.turn else -f["lead"]
        pts = lambda n: f"{n} point{'s' if n > 1 else ''}"
        why = (f", though {color(root.turn)} is {pts(-lead)} down" if played and lead < 0 else
               f", while {color(root.turn)} is {pts(lead)} up" if not played and lead > 0 else "")
        return f"trades off {what}{ln.paren(a, k)}{why}", k, None, []
    what, by = f.get("what"), PIECE.get(f.get("by"), "piece")
    moves = ln.after(a, k) if played else ln.paren(a, k)
    if t == "passed_pawn":
        verb = f"lets {color(c)} get a passed pawn on the {sq[0][0]}-file" if played else f"gets a passed pawn on the {sq[0][0]}-file"
        return verb + moves, k, arrow, sq[:1]
    if t == "outpost":
        verb = f"lets the {color(c).lower()} {by} settle on {sq[0]}" if played else f"puts the {by} on {sq[0]}"
        return f"{verb}, an outpost no pawn can challenge{moves}", k, arrow, sq[:1]
    if t == "piece_harassed":
        fr, to = sq
        if what == "chased" and not ln.boards[k - 1].is_attacked_by(not c, chess.parse_square(fr)):
            what = "round_trip"
        if not played:
            return f"chases the {color(c).lower()} {by} from {fr} back to {to}{moves}", k, arrow, sq
        verb = {"early_queen": f"brings the queen out to {fr} too early: a piece comes to {to} with tempo",
                "kick": f"lets a pawn push drive the {by} on {fr} back to {to}",
                "chased": f"lets the {by} on {fr} be chased back to {to}, losing time",
                "round_trip": f"sends the {by} to {fr} and straight back to {to}"}[what]
        return verb + moves, k, arrow, sq
    if t == "pawn_weakness":
        if what == "hole":
            return (f"gives up {sq[1]} to a {color(not c).lower()} {by}: no pawn can cover it any more",
                    1, arrow, sq[:2])
        file = sq[0][0]
        verb = {"doubled": (f"leaves doubled pawns on the {file}-file" if played
                            else f"saddles {color(c)} with doubled pawns on the {file}-file"),
                "undoubled": (f"lets {color(c)} undouble the {file}-pawns" if played
                              else f"undoubles the {file}-pawns"),
                "isolated": (f"leaves an isolated pawn on {sq[0]} that can be attacked" if played
                             else f"leaves {color(c)} with an isolated pawn on {sq[0]}")}[what]
        return verb + moves, k, arrow if k == 1 else None, sq[:2]
    if t == "restricted":
        return f"leaves the {color(c).lower()} {by} on {sq[0]} with no safe square{moves}", k, None, sq[:1]
    # draw_risk
    if what == "stalemate":
        return f"runs into stalemate{moves}", k, None, []
    return f"lets {color(not c)} give perpetual check{moves}", k, None, sq[:1]


def recount(f, ext):
    """The material fact counted from the root to the line's last capture, or None when it comes out
    even or for the wrong side (the opponent ahead in the best line, the mover in the played line)."""
    end = settled(ext, ext.h)
    if end is None:
        return None
    gone = {}
    for c in chess.COLORS:
        for t in VAL:
            pt = chess.Piece.from_symbol(t).piece_type
            gone[c, t] = len(ext.boards[0].pieces(pt, c)) - len(ext.boards[end].pieces(pt, c))
    net = sum(VAL[t] * (gone[chess.BLACK, t] - gone[chess.WHITE, t]) for t in VAL)
    w = net > 0
    if not net or (w == ext.boards[0].turn) != (f["line"] == "best") or abs(net) < 3 and gifted(ext, end, f["line"]):
        return None
    if ext.boards[end].turn != w and edge(ext, end):
        return None
    won = [t for t in VAL for _ in range(gone[not w, t])] + [f"={t}" for t in VAL for _ in range(-gone[w, t])]
    lost = [t for t in VAL for _ in range(gone[w, t])] + [f"={t}" for t in VAL for _ in range(-gone[not w, t])]
    for t in list(won):  # like for like cancels out
        if t in lost:
            won.remove(t)
            lost.remove(t)
    return dict(f, side=color(w).lower(), net=abs(net), won=won[::-1], lost=lost[::-1], end=end)


def defender(f, ln):
    """How the material fact's first won man falls, when it falls for losing its last guard in the
    line: (kind, ply, guard square, victim square, capture ply) or None. The man is taken unguarded at ply c; going
    back while it stays on its square, the move that left it without a guard is
    - "abandon": the played move itself walks the guard away;
    - "lure": the losing side's guard takes the piece the winner just moved (that move lures it);
    - "drive": the losing side moves the guard to answer a check, or to flee a new attack by the
      piece the winner just moved (the guard was not attacked before that move);
    - "remove": the winner takes the guard.
    Anything else (the guard leaves on its own later, a line is blocked, a pinned or overloaded
    guard) says nothing: the line alone does not show why it happened. Nor does a man that was
    not safe with its guard (more attackers than guards, or a cheaper attacker): it falls anyway
    (sol's precision check, 2 of 20)."""
    w = chess.WHITE if f["side"] == "white" else chess.BLACK
    for c in range(1, f["end"] + 1):
        b, m = ln.boards[c - 1], ln.moves[c - 1]
        x = b.piece_at(m.to_square)
        if b.turn == w and x and x.color != w and x.symbol().lower() in f["won"]:
            break
    else:
        return None
    s = m.to_square
    if b.attackers(not w, s):
        return None
    for j in range(c - 2, -1, -1):
        bj, mj = ln.boards[j], ln.moves[j]
        if s in (mj.from_square, mj.to_square):
            return None
        guards = bj.attackers(not w, s)
        if not guards:
            continue
        # the man must have been safe with its guard: never more attackers than guards from then on,
        # and none cheaper than the man (else it falls anyway and the guard is a side detail)
        man = tactics.VAL[x.piece_type]
        for i in range(j, c):
            att = ln.boards[i].attackers(w, s)
            if len(att) > len(guards) or any(tactics.VAL[ln.boards[i].piece_type_at(q)] < man for q in att):
                return None
        if bj.turn != w and mj.from_square in guards:
            if j == 0 and f["line"] == "played":
                return "abandon", 1, mj.from_square, s, c
            lure = ln.moves[j - 1] if j else None
            if lure and mj.to_square == lure.to_square:
                return "lure", j, mj.from_square, s, c
            new = (mj.from_square in bj.attacks(lure.to_square) and not ln.boards[j - 1].is_attacked_by(w, mj.from_square)) if lure else False
            if lure and (bj.is_check() or new):
                return "drive", j, mj.from_square, s, c
        elif bj.turn == w and mj.to_square in guards and bj.is_capture(mj):
            return "remove", j + 1, mj.to_square, s, c
        return None
    return None


def edge(ln, end):
    """True when the line ends on the capture at ply end and the side to move can take back on that
    square: the count holds only because the line stops there."""
    b = ln.boards[end]
    return 0 < end == len(ln.moves) and any(b.is_capture(m) for m in b.legal_moves if m.to_square == ln.moves[end - 1].to_square)


def gifted(ln, end, line):
    """True when the losing side gives a pawn away within plies 1..end: a quiet pawn move onto a
    square the other side then takes on and the loser does not take back (a gambit in the engine's
    line, too abstract to call a win). The played move itself (ply 1) is the mistake, not a gift."""
    for j in range(2, end + 1):
        m, prev = ln.moves[j - 1], ln.moves[j - 2]
        b = ln.boards[j - 2]
        if (j - 1 >= (3 if line == "played" else 2) and b.piece_type_at(prev.from_square) == chess.PAWN
                and not b.is_capture(prev) and m.to_square == prev.to_square and ln.boards[j - 1].is_capture(m)
                and not (j < len(ln.moves) and ln.moves[j].to_square == m.to_square)):
            return True
    return False


def forced_out(f, row):
    """True when the castling fact's king move answers a check that only a king move meets."""
    c = chess.WHITE if f["side"] == "white" else chess.BLACK
    _, ply, (tail, _) = positional.castle_state(positional.walk(row["fen"], row[f"{f['line']}_pv"]), c)
    b = Line(row["fen"], Line(row["fen"], row[f"{f['line']}_pv"]).moves + tail).boards[ply - 1]
    return b.is_check() and all(b.piece_type_at(m.from_square) == chess.KING for m in b.legal_moves)


def said(cands, row, ext):
    out = []
    for f in cands:
        if f["type"] == "material":
            f = recount(f, ext[f["line"]])
        if (f and f["type"] not in SILENT and f.get("what") != "chain"
                and (f["type"] != "castling" or forced_out(f, row))):
            out.append(f)
    return out


def second(a, b):
    """One reason per card: a second fact speaks only as the fork that wins the first fact's material."""
    return (b["type"] == "fork" and a["type"] == "material" and a["line"] == b["line"] and bool(a["at"])
            and a["at"][0] in b["targets"])


def settled(ln, h):
    """The capture that settles the line's material, h plies being what the facts look at: the
    exchanges up to h, then any exchange starting within WINDOW plies of the next quiet position that leaves less (an
    exchange finished late, as in a delayed recapture) — but not later gains or give-backs, which
    are other events. Past HORIZON + WINDOW it is too deep to show (None)."""
    caps = [i for i in range(1, len(ln.moves) + 1) if ln.boards[i - 1].is_capture(ln.moves[i - 1]) or ln.moves[i - 1].promotion]
    calm = lambda j: j == 0 or not (j in caps or ln.boards[j].is_check())
    b0 = balance(ln.boards[0], chess.WHITE)
    end = max((i for i in caps if i <= h), default=0)
    while True:
        q = next((j for j in range(end, len(ln.moves) + 1) if calm(j)), len(ln.moves))
        gain = balance(ln.boards[q], chess.WHITE) - b0
        settle = lambda r: next((j for j in range(r, len(ln.moves) + 1) if calm(j)), len(ln.moves))
        back = next((settle(r) for r in caps if q < r <= q + WINDOW
                     and abs(balance(ln.boards[settle(r)], chess.WHITE) - b0) < abs(gain)), None)
        if back is None:
            return max((i for i in caps if i <= q), default=0)
        if back > HORIZON + 2 * WINDOW:
            return None
        end = max(i for i in caps if i <= back)


def last_capture(ln):
    return max(i for i in range(len(ln.moves) + 1) if i == 0 or ln.boards[i - 1].is_capture(ln.moves[i - 1])
               or ln.moves[i - 1].promotion)


def balance(b, c):
    return sum(VAL[p.symbol().lower()] * (1 if p.color == c else -1) for p in b.piece_map().values() if p.piece_type != chess.KING)


def hits(b, sq, c):
    """Squares of c's men (not the king) that the piece on sq attacks."""
    return list(b.attacks(sq) & b.occupied_co[c] & ~b.kings)


def answered(ln, i, sq):
    """The attack on sq made by ply i matters in the line: ply i+1 moves the man away, or the
    attacker's side takes on sq at ply i+2 or i+4."""
    if i < len(ln.moves) and ln.moves[i].from_square == sq:
        return True
    return any(j <= len(ln.moves) and ln.moves[j - 1].to_square == sq and ln.boards[j - 1].is_capture(ln.moves[j - 1])
               for j in (i + 2, i + 4))


def quiet(lines, ext, root):
    """With no fact: (what the played move allows, what the best move does), each "" when
    nothing concrete holds. Allows: the reply when it checks or captures (not a plain recapture), or when it newly
    attacks a man that then has to move or is taken. Best: comes out ahead in material over the other
    line, stops the played line's quiet reply, or newly attacks a man that then has to move or is
    taken."""
    pl, bl, me = lines["played"], lines["best"], root.turn
    allows = ""
    if len(pl.moves) > 1:
        r, b1, b2 = pl.moves[1], pl.boards[1], pl.boards[2]
        if b2.is_check() or b1.is_capture(r) and r.to_square != pl.moves[0].to_square:  # not a plain recapture
            allows = f"allows {pl.seq(2, 2)}"
        elif len(pl.moves) > 2:
            new = [t for t in hits(b2, r.to_square, me) if t not in b1.attacks(r.from_square) and answered(pl, 2, t)
                   and b2.piece_type_at(t) != chess.PAWN]
            if new:
                allows = f"allows {pl.seq(2, 2)}, which attacks {pl.name(2, chess.square_name(new[0]))}"
    ep, eb = ext["played"], ext["best"]
    ends = {k: settled(ln, ln.h) for k, ln in ext.items()}
    if None in ends.values():
        ends = None
    d = ends and balance(eb.boards[ends["best"]], me) - balance(ep.boards[ends["played"]], me)
    if (ends and d >= 1 and not gifted(eb, ends["best"], "best") and not gifted(ep, ends["played"], "played")
            and not edge(eb, ends["best"]) and not edge(ep, ends["played"])):
        words = {1: "a pawn", 2: "two pawns", 3: "a piece", 5: "a rook", 9: "a queen"}.get(d, f"{d} pawns' worth")
        return allows, f"it comes out {words} better{eb.paren(1, ends['best'])}"
    b1 = bl.boards[1]
    if len(pl.moves) > 1 and not b1.is_check():
        r = pl.moves[1]
        q = b1.piece_at(r.from_square)
        if (not pl.boards[1].is_capture(r) and not root.piece_at(r.to_square) and q and q == pl.boards[1].piece_at(r.from_square)
                and r not in b1.legal_moves):
            return allows, f"it stops {pl.seq(2, 2)}"
    m = bl.moves[0]
    new = [t for t in hits(b1, m.to_square, not me) if t not in root.attacks(m.from_square) and answered(bl, 1, t)
           and b1.piece_type_at(t) != chess.PAWN]
    if new and not b1.is_check():
        return allows, f"it attacks {bl.name(1, chess.square_name(new[0]))}"
    return allows, ""


def explain(row, cands=None):
    root = chess.Board(row["fen"])
    mover = "white" if root.turn else "black"
    full = {k: Line(row["fen"], row[f"{k}_pv"]) for k in ("played", "best")}
    ext = {k: Line(row["fen"], ln.moves + ([] if ln.boards[-1].is_game_over() else
                                              [chess.Move.from_uci(u) for u in tactics.tail(ln.boards[-1], root.turn)[0]]))
           for k, ln in full.items()}
    # facts come from both lines up to one horizon (the longer of the two: a line seen further
    # would show facts the other only lacks for being cut sooner); material is counted on the whole line
    h = max(horizon(row["fen"], row[k]) for k in ("played_pv", "best_pv"))
    row = dict(row, played_pv=row["played_pv"][:h], best_pv=row["best_pv"][:h])
    lines = {k: Line(row["fen"], row[f"{k}_pv"]) for k in ("played", "best")}
    for k in ext:
        ext[k].h = len(lines[k].moves)
    P, B = lines["played"].sans[0], lines["best"].sans[0]
    cands = said(cands if cands is not None else candidates(row), row, ext)
    ranked = rank([c for c in cands if not c.get("mechanism")], mover)
    facts = ranked[:1] + [c for c in ranked[1:] + [c for c in cands if c.get("mechanism")] if second(ranked[0], c)][:1] if ranked else []
    if [f["type"] for f in facts] == ["trades"] and any(quiet(lines, ext, root)):  # a trade alone says little
        facts = []
    grade = GRADE.get(row["grade"])
    out, arrows, squares, shown = [], [], [], {}
    fork_first = len(facts) == 2 and facts[0]["line"] == "best" and facts[1]["ply"] == 1
    guard = facts[0]["type"] == "material" and len(facts) == 1 and defender(facts[0], ext[facts[0]["line"]]) if facts else None
    for i, f in enumerate(facts):
        line = f["line"]
        ln = lines[line]
        verb, last, arrow, sq = phrase(f, ln, ext[line], shown.get(line, 0) + 1, root, row)
        if i == 0 and fork_first:  # the best move itself forks: one sentence names the fork and its gain
            verb = f"forks {' and '.join(ln.name(1, s) for s in kings_first(ln, 1, facts[1]['targets']))} and {verb}"
        if guard:  # the material falls for losing its guard: say how, in as few moves as show it
            kind, k, g, v, c = guard
            el = ext[line]
            man, gd = el.name(c - 1, chess.square_name(v)), el.name(k if kind in ("lure", "drive") else k - 1, chess.square_name(g))
            # just the man won (no other gains or losses): name it and the move that undoes its guard, not the line
            simple = f["won"] == [el.boards[c - 1].piece_at(v).symbol().lower()] and not f["lost"]
            gain = "loses" if line == "played" else "wins"
            if kind == "abandon":
                verb = f"leaves {man} undefended: {el.seq(2, c)}" if simple else f"leaves {man} undefended and {verb}"
            elif simple and k == 1:
                verb = {"lure": f"pulls {gd} away from {man} and wins it", "drive": f"drives {gd} away from {man} and wins it",
                        "remove": f"takes {gd}, the last guard of {man}, and wins it"}[kind]
            elif simple:
                verb = f"{gain} {man} once {el.seq(k, k)} " + {"lure": f"pulls {gd} away", "drive": f"drives {gd} away",
                                                             "remove": f"takes {gd}, its last guard"}[kind]
            else:  # the count, and the move that undoes the guard instead of the whole line
                how = {"lure": f"pulls {gd} away from {man}", "drive": f"drives {gd} away from {man}",
                       "remove": f"takes {gd}, the last guard of {man}"}[kind]
                count = f"{gain} {pieces(f['won'])}" + (f" for {pieces(f['lost'])}" if f["lost"] else "")
                verb = f"{how} and {count}" if k == 1 else f"{count}: {el.seq(k, k)} {how}"
        if i == 0:
            if line == "played":
                body = verb
            elif f["type"] == "mate":
                body = f"misses mate in {verb.split('mates in ', 1)[1]}"
            else:
                body = f"misses {B}, which {verb}"
            out.append(f"{grade} {P} {body}." if grade else f"{P} {body}.")  # Analyze shows the grade
        elif not fork_first:  # the fork that wins the material, later in the line
            out.append(f"The key move is {ln.seq(f['ply'], f['ply'])}, forking {verb.rsplit('fork', 1)[1].split(' ', 1)[1]}.")
        shown[line] = max(last, shown.get(line, 0))
        if arrow:
            arrows.append(arrow)
        squares += [s for s in sq if s not in squares]
    better = ""
    if not facts:
        allows, better = quiet(lines, ext, root)
        out.append(f"{grade} {P} {allows or 'is not the best move'}." if grade else
                   f"{P} is slightly inaccurate{': it ' + allows if allows else ''}.")
    if "best" not in shown:
        out.append(f"{B} was the move{': ' + better if better else ''}.")
    arrows = arrows[:3]
    return {"text": " ".join(out), "arrows": arrows, "squares": squares[:3 - len(arrows)], "facts": [f["type"] for f in facts], "chosen": facts,
            "guard": guard[0] if guard else None}


def main():
    rows = {r["id"]: r for r in map(json.loads, (HERE / "positions.jsonl").read_text(encoding="utf-8").splitlines())}
    ids = sys.argv[1:] or [p["card"] for p in json.loads((HERE / "review/set-r4.json").read_text(encoding="utf-8"))]
    for i in ids:
        e = explain(rows[i])
        marks = [f"{a['line']} ply {a['ply']} {a['from']}-{a['to']}" for a in e["arrows"]]
        print(f"{i}  [{' + '.join(e['facts'])}]\n  {e['text']}\n  marks: {'; '.join(marks + e['squares']) or 'none'}\n")
    tactics.close()


if __name__ == "__main__":
    main()
