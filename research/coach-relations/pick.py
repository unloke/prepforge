"""Research only. Orders a card's candidates so the first one is the reason to show.

  py research/coach-relations/pick.py

Mate first; then material that wins or loses a piece (net 3 or more), largest net first; then lost
castling rights; then smaller material, largest net first; then the other tactical facts; then the
positional facts that name a weakness (pawn weakness, restricted, outpost, harassed piece) before
the vaguer shield, trades, open file and enter. Ties keep the earlier ply, then the enumerator's
order. Tuned on rounds 2 and 3; round 4 (Codex labels) is the check. Prints, per set, how often
the first and the first two candidates include one rated key.
"""
import json
import pathlib

HERE = pathlib.Path(__file__).parent
ORDER = ["mate", "forced_mate", "mate_threat", "material_big", "castling", "material_small", "fork", "king_exposed",
         "pawn_weakness", "restricted", "outpost", "piece_harassed", "shield", "trades", "open_file", "enter", "draw_risk"]


def rank(cands):
    def key(c):
        t = c["type"]
        if t == "material":
            t = "material_big" if c["net"] >= 3 else "material_small"
        return ORDER.index(t), -c.get("net", 0), c["ply"]
    return sorted(cands, key=key)


def main():
    for name, rounds in (("rounds 2+3 (tuning)", "23"), ("round 4 (check)", "4")):
        n = top1 = top2 = 0
        for rnd in rounds:
            labels = HERE / "review" / (f"LABELS-r{rnd}.json" if rnd != "4" else "LABELS-r4.codex.json")
            sets = {p["pos_id"]: p for p in json.loads((HERE / "review" / f"set-r{rnd}.json").read_text(encoding="utf-8"))}
            for r in json.loads(labels.read_text(encoding="utf-8"))["reviews"]:
                cands = [dict(c, rating=r["ratings"].get(str(i))) for i, c in enumerate(sets[r["pos_id"]]["candidates"])]
                if not any(c["rating"] == "key" for c in cands):
                    continue
                ranked = [c["rating"] for c in rank(cands)]
                n += 1
                top1 += ranked[0] == "key"
                top2 += "key" in ranked[:2]
        print(f"{name}: {n} positions with a key fact; first is key {top1} ({top1 / n:.0%}), "
              f"first two include key {top2} ({top2 / n:.0%})")


if __name__ == "__main__":
    main()
