"""The user's 5-card blind check of the two fixes (material quote; material + mate threat), for
research/coach-ab-review: old and new text from Sol's review set (review/batch-01.jsonl), in fresh
random order; the board lines carry the capture tail. Key: ../../kingmat-human-key.jsonl (outside the review server's allowlist).

  py -B selector/kingmat/human/make.py
  node research/coach-ab-review/serve.mjs research/coach-relations/selector/kingmat/human --port 5218
"""
import json
import os
import random
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SEL = HERE.parents[1]
sys.path.insert(0, str(SEL))
import pool  # noqa: E402
from make_ab import answer, game, score  # noqa: E402

# quote: hPj7iyMI/48, HF5O5UtI/46; threat + material: YlS77iU2/50, iA3o2tRj/18; attribution dispute: fXXRphIf/51
PICK = ["hPj7iyMI/48", "HF5O5UtI/46", "YlS77iU2/50", "iA3o2tRj/18", "fXXRphIf/51"]


def ext(r, k):
    """The engine line with Stockfish's capture tail, as the Coach quotes it."""
    ln = pool.explain.Line(r["fen"], r[f"{k}_pv"])
    root = pool.explain.chess.Board(r["fen"])
    return r[f"{k}_pv"] + ([] if ln.boards[-1].is_game_over() else pool.explain.tactics.tail(ln.boards[-1], root.turn)[0])


def main():
    sealed = {json.loads(l)["id"] for l in (SEL / "confirm/key.jsonl").read_text(encoding="utf-8").splitlines()}
    assert not sealed & set(PICK)
    rev = {o["id"]: o for o in map(json.loads, (HERE.parent / "review/batch-01.jsonl").open(encoding="utf-8"))}
    rkey = {o["id"]: o for o in map(json.loads, (SEL / "kingmat-review-key.jsonl").open(encoding="utf-8"))}
    cards = pool.setup()
    games = {}
    for p in sorted((pool.BENCH / "prod-depth/out").glob("fresh*/cards.jsonl")):
        for c in pool.jsonl(p):
            games.setdefault(c["id"].split("/")[0], []).append(c)
    rng = random.Random(int.from_bytes(os.urandom(16), "big"))
    ids = PICK[:]
    rng.shuffle(ids)
    out, key = [], []
    for n, i in enumerate(ids, 1):
        c, r, o = cards[i], pool.row(cards[i]), rev[i]
        new = o[rkey[i]["new"]]
        old = o["B" if rkey[i]["new"] == "A" else "A"]
        swap = rng.random() < 0.5
        pid = f"pair-{n:03d}"
        out.append({
            "pair_id": pid,
            "prompt": f"{c['san']} ({c['code']}), {c['mover']}, move {c['moveNumber']}.",
            "facts": {"fen_before": c["fen"], "fen_after": c["fenAfter"], "side": c["mover"], "move_number": c["moveNumber"],
                      "played_uci": c["uci"], "played_san": c["san"], "best_uci": c["bestUci"], "best_san": c["bestSan"],
                      "is_best": c["isBest"], "grade": c["code"], "played_pv": ext(r, "played"), "best_pv": ext(r, "best"),
                      "before": score(c["before"]), "after": score(c["after"]), "game": game(games[i.split("/")[0]], i)},
            "A": answer(new if swap else old), "B": answer(old if swap else new),
        })
        key.append({"pair_id": pid, "id": i, "part": rkey[i]["part"], "new": "A" if swap else "B"})
    (HERE / "run-output").mkdir(exist_ok=True)
    (HERE / "run-output/BLINDED.jsonl").write_text("".join(json.dumps(o, ensure_ascii=False) + "\n" for o in out), encoding="utf-8")
    (SEL / "kingmat-human-key.jsonl").write_text("".join(json.dumps(o) + "\n" for o in key), encoding="utf-8")
    print(len(out), "pairs")


if __name__ == "__main__":
    main()
