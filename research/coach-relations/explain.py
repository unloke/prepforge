"""Research only. A Coach explanation from the picked facts: fixed sentences and board marks.

  py research/coach-relations/explain.py [card id ...]     # default: the round-4 cards

The first fact from pick.rank speaks, unless it is material the mover wins in the played line (the
line stopped too early), and then nothing does. The second joins it unless the first is a mate,
the second is a vaguer fact (shield, trades, open file, enter, king exposure, draw) or also such
material, both are the same kind in the same line, or it is a fork that is not how the first
fact's material is won. Sentences follow the production Coach's voice ("Blunder. Nfe5 loses a
bishop after ... d4 was the move."). Marks: the move behind each fact as an arrow at its node,
then the squares the facts name, at most three in all.
"""
import json
import pathlib
import sys

import chess

import positional
from enumerate import candidates
from pick import rank, unfinished

HERE = pathlib.Path(__file__).parent
PIECE = {"p": "pawn", "n": "knight", "b": "bishop", "r": "rook", "q": "queen", "k": "king"}
COUNT = {2: "two", 3: "three", 4: "four"}
GRADE = {"blunder": "Blunder.", "mistake": "Mistake."}
VAGUE = {"shield", "trades", "open_file", "enter", "king_exposed", "draw_risk"}
NUMBER = {1: "one"}


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

    def run_end(self, k):
        """The last ply of the exchange that starts at ply k: consecutive captures, and a later
        recapture on the same square."""
        sq = self.moves[k - 1].to_square
        while k < len(self.moves) and self.boards[k].is_capture(self.moves[k]):
            k += 1
        later = [i for i in range(k + 1, len(self.moves) + 1) if self.moves[i - 1].to_square == sq and self.boards[i - 1].is_capture(self.moves[i - 1])]
        return later[-1] if later else k

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


def phrase(f, ln, a, root, row):
    """(verb phrase for what the line's first move does, last ply it needs, arrow, squares). The
    played move's phrase shows the moves from ply a (at least 2), the best move's from ply a."""
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
        if not f["at"]:
            last = len(ln.moves)
            return f"{'loses' if played else 'wins'} {what} once the captures go on past {ln.seq(last, last)}", last, None, []
        b = ln.run_end(k)
        return (f"loses {what}{ln.after(a, b)}" if played else f"wins {what}{ln.paren(a, b)}"), b, arrow, []
    if t == "fork":
        targets = " and ".join(ln.name(k, s) for s in f["targets"])
        verb = f"allows {ln.seq(a, k)}, forking {targets}" if played else f"forks {targets}{ln.paren(a, k)}"
        return verb, k, arrow, f["targets"][:2]
    if t == "castling":
        cc = chess.WHITE if c else chess.BLACK
        _, ply, (tail, _) = positional.castle_state(positional.walk(row["fen"], row[f"{f['line']}_pv"]), cc)
        long = Line(row["fen"], ln.moves + tail)
        b = min(ply, len(long.moves))
        verb = (f"allows {long.seq(a, b)}, and the {color(cc).lower()} king can no longer castle" if played
                else f"drives the {color(cc).lower()} king out{long.paren(a, b)}, so {color(cc)} can no longer castle")
        return verb, b, None if tail else arrow, sq[:1]
    if t == "king_exposed":
        w = max(1, min(f["worst"], len(ln.moves)))
        king = f"the {'white' if root.piece_at(chess.parse_square(f['piece'])).color else 'black'} king"
        return (f"leaves {king} with {f['here']} attacked squares around it{ln.after(a, w)}, against {f['there']} in the other line",
                w, ln.arrow(f["line"], w), sq[:1])
    if t == "shield":
        king = f"the {'white' if root.piece_at(chess.parse_square(f['other'])).color else 'black'} king" if f.get("other") else "the king"
        if played:
            return f"cracks the pawn cover of {king}{ln.after(a, k)}", k, arrow, sq[:2]
        return f"breaks open the pawn cover of {king}{ln.paren(a, k)}", k, arrow, sq[:2]
    if t == "trades":
        extra = list(f["gone"])
        for p in f["other_gone"]:
            if p in extra:
                extra.remove(p)
        w = [p.lower() for p in extra if p.isupper()]
        b = [p for p in extra if p.islower()]
        what = " and ".join(x for x in (w and f"White's {pieces(w).split(' ', 1)[1]}", b and f"Black's {pieces(b).split(' ', 1)[1]}") if x)
        lead = f["lead"] if root.turn else -f["lead"]
        why = (f", though {color(root.turn)} is {-lead} points down" if played and lead < 0 else
               f", while {color(root.turn)} is {lead} points up" if not played and lead > 0 else "")
        return f"trades off {what}{ln.paren(a, k)}{why}", k, None, []
    if t == "open_file":
        if played:
            return f"hands {color(c)} the open {f['file']}-file{ln.after(a, k)}", k, None, sq[:1]
        return f"takes the open {f['file']}-file{ln.paren(a, k)}", k, None, sq[:1]
    if t == "enter":
        piece = ln.name(k, sq[0]).split(" on ")[0]
        if played:
            return f"allows {ln.seq(a, k)}, and {piece} gets into {f['square']}", k, arrow, []
        return f"brings {piece} to {f['square']}{ln.paren(a, k)}", k, arrow, []
    what, by = f.get("what"), PIECE.get(f.get("by"), "piece")
    moves = ln.after(a, k) if played else ln.paren(a, k)
    if t == "outpost":
        verb = f"lets the {color(c).lower()} {by} settle on {sq[0]}" if played else f"puts the {by} on {sq[0]}"
        return f"{verb}, an outpost no pawn can challenge{moves}", k, arrow, sq[:1]
    if t == "piece_harassed":
        fr, to = sq
        if not played:
            return f"chases the {color(c).lower()} {by} from {fr} back to {to}{moves}", k, arrow, sq
        verb = {"early_queen": f"brings the queen out to {fr} too early: a piece comes to {to} with tempo",
                "kick": f"lets a pawn push drive the {by} on {fr} back to {to}",
                "chased": f"lets the {by} on {fr} be chased back to {to}, losing time",
                "round_trip": f"sends the {by} to {fr} and straight back to {to}"}[what]
        return verb + moves, k, arrow, sq
    if t == "pawn_weakness":
        if what == "chain":
            return f"leaves the pawn on {sq[1]} without pawn support", 1, arrow, sq[:2]
        if what == "hole":
            return (f"gives up {sq[1]}: no pawn can cover it any more, and a {color(not c).lower()} {by} can settle there",
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


def second(a, b, mover):
    if a["type"] in ("mate", "forced_mate") or b["type"] in VAGUE or unfinished(b, mover):
        return False
    if a["type"] == b["type"] and a["line"] == b["line"]:
        return False
    if b["type"] == "fork":  # a fork earns a place only as the way the first fact's material is won
        return a["type"] == "material" and a["line"] == b["line"] and bool(a["at"]) and a["at"][0] in b["targets"]
    return True


def explain(row, cands=None):
    root = chess.Board(row["fen"])
    mover = "white" if root.turn else "black"
    lines = {"played": Line(row["fen"], row["played_pv"]), "best": Line(row["fen"], row["best_pv"])}
    P, B = lines["played"].sans[0], lines["best"].sans[0]
    ranked = [c for c in rank(cands if cands is not None else candidates(row), mover) if not unfinished(c, mover)]
    facts = ranked[:2] if len(ranked) > 1 and second(*ranked[:2], mover) else ranked[:1]
    grade = GRADE.get(row["grade"])
    out, arrows, squares, shown = [], [], [], {}
    for i, f in enumerate(facts):
        line = f["line"]
        ln = lines[line]
        verb, last, arrow, sq = phrase(f, ln, shown.get(line, 0) + 1, root, row)
        if i == 0:
            if line == "played":
                body = verb
            elif f["type"] == "mate":
                body = f"misses mate in {verb.split('mates in ', 1)[1]}"
            else:
                body = f"misses {B}, which {verb}"
            out.append(f"{grade} {P} {body}." if grade else f"{P} is slightly inaccurate: it {body}.")
        elif f["type"] == "fork":
            out.append(f"The key move is {ln.seq(f['ply'], f['ply'])}, forking {verb.rsplit('fork', 1)[1].split(' ', 1)[1]}.")
        elif line in shown:
            out.append(f"It also {verb}.")
        else:
            out.append(f"{P} itself {verb}." if line == "played" else f"{B} was the move: it {verb}.")
        shown[line] = max(last, shown.get(line, 0))
        if arrow:
            arrows.append(arrow)
        squares += [s for s in sq if s not in squares]
    if not facts:
        out.append(f"{grade} {P} is not the best move." if grade else f"{P} is slightly inaccurate.")
    if "best" not in shown:
        out.append(f"{B} was the move.")
    arrows = arrows[:3]
    return {"text": " ".join(out), "arrows": arrows, "squares": squares[:3 - len(arrows)], "facts": [f["type"] for f in facts]}


def main():
    rows = {r["id"]: r for r in map(json.loads, (HERE / "positions.jsonl").read_text(encoding="utf-8").splitlines())}
    ids = sys.argv[1:] or [p["card"] for p in json.loads((HERE / "review/set-r4.json").read_text(encoding="utf-8"))]
    for i in ids:
        e = explain(rows[i])
        marks = [f"{a['line']} ply {a['ply']} {a['from']}-{a['to']}" for a in e["arrows"]]
        print(f"{i}  [{' + '.join(e['facts'])}]\n  {e['text']}\n  marks: {'; '.join(marks + e['squares']) or 'none'}\n")


if __name__ == "__main__":
    main()
