"""Blind A/B of explain.py against the production Coach, for coach-ab-review and a Codex judge.

  py research/coach-relations/make_ab.py ab2
  node research/coach-prod-v2/run.mjs research/coach-relations/ab2/ids.json research/coach-relations/ab2/prod.jsonl
  py research/coach-relations/make_ab.py ab2
  node research/coach-ab-review/serve.mjs research/coach-relations/ab2 --port 5208
  py research/coach-relations/make_ab.py ab6 --reads artifacts/benchmarks/coach-relations-20261014/prod-depth/out

Rounds 1-5 (ab..ab5): the cards and both programs' lines are the coach-v5 depth-22 full-NNUE
reads, not production's depth. With --reads (round 6 on), both programs read production's own
reads (prod-depth/ kernels) and one run draws PER_GRADE cards of each error grade. Otherwise the first run draws the cards (writes <dir>/ids.json), run.mjs builds the production prose, the
second run builds the pairs. Cards: inaccuracies, mistakes and blunders that no
review round and no earlier A/B (ab*/ids.json) has shown, 60 of them; with --reviewed the review
rounds' cards may be drawn too (they tuned pick.py, not the wording). Order and A/B side come from os.urandom; the key is sealed
in ab/run-output/BLIND-KEY.json. Codex gets ab/run-output/judge/batchN.jsonl and RUBRIC.md (copied from
RUBRIC.md here; v2 from round 7 on, after the user's own round-6 review). Once the key is sealed, a
rerun keeps its order and sides and rewrites only BLINDED.jsonl (the review board's lines, scores and game).
"""
import hashlib
import json
import os
import pathlib
import random
import shutil
import sys

import chess

import tactics
from explain import explain

sys.path.append(str(pathlib.Path(__file__).parent / "prod-depth"))
from explain_cards import row  # noqa: E402

HERE = pathlib.Path(__file__).parent
N, BATCH, PER_GRADE = 60, 30, 30
ERRORS = ("inaccuracy", "mistake", "blunder")


def jsonl(path):
    return [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]


def san_line(fen, ucis):
    b, out = chess.Board(fen), []
    for u in ucis:
        m = chess.Move.from_uci(u)
        num = f"{b.fullmove_number}." if b.turn else f"{b.fullmove_number}..." if not out else ""
        out.append(num + b.san(m))
        b.push(m)
    return " ".join(out)


def answer(text):
    return {"response": text, "finish": {"finished": True}, "content_sha256": hashlib.sha256(text.encode()).hexdigest()}


def unseen():
    seen = set()
    for f in HERE.glob("ab*/ids.json"):
        seen |= set(json.loads(f.read_text(encoding="utf-8")))
    return seen


def v5_cards(AB):
    """(id, explain row, production row, explain output) from positions.jsonl and run.mjs's prod.jsonl."""
    pos = {r["id"]: r for r in jsonl(HERE / "positions.jsonl")}
    if not (AB / "prod.jsonl").exists():
        seen = unseen()
        for s in () if "--reviewed" in sys.argv else ("set", "set-r2", "set-r3", "set-r4"):
            seen |= {p["card"] for p in json.loads((HERE / f"review/{s}.json").read_text(encoding="utf-8"))}
        pool = [i for i, r in pos.items() if i not in seen and r["grade"] in ERRORS]
        AB.mkdir(exist_ok=True)
        ids = random.Random(int.from_bytes(os.urandom(16), "big")).sample(pool, N)
        (AB / "ids.json").write_text(json.dumps(ids) + "\n", encoding="utf-8")
        sys.exit(f"{len(pool)} unseen cards, drew {N}: now run run.mjs (see the docstring)")
    prod = {r["id"]: r for r in jsonl(AB / "prod.jsonl")}
    return [(i, pos[i], prod[i], explain(pos[i]), None) for i in json.loads((AB / "ids.json").read_text(encoding="utf-8"))]


def reads_cards(AB, reads):
    """The same from prod-depth kernel outputs (<reads>/fresh*/cards.jsonl, explain.jsonl): both
    programs on production's reads. Draws PER_GRADE unseen cards of each error grade once. explain.py
    runs again here on the full PVs (explain_cards.row; the kernels' rows are the old cut lines)."""
    rows, games = {}, {}
    for d in sorted(reads.glob("fresh*")):
        cards = {c["id"]: c for c in jsonl(d / "cards.jsonl")}
        rows.update({e["id"]: (row(cards[e["id"]]), cards[e["id"]]) for e in jsonl(d / "explain.jsonl") if "text" in e})
        for c in cards.values():
            games.setdefault(c["id"].split("/")[0], []).append(c)
    if not (AB / "ids.json").exists():
        seen, rng, ids = unseen(), random.Random(int.from_bytes(os.urandom(16), "big")), []
        for g in ERRORS:
            ids += rng.sample(sorted(i for i, (e, _) in rows.items() if e["grade"] == g and i not in seen), PER_GRADE)
        AB.mkdir(exist_ok=True)
        (AB / "ids.json").write_text(json.dumps(ids) + "\n", encoding="utf-8")
    tactics.READ += [d / "sf_cache.jsonl" for d in reads.glob("fresh*")]
    return [(i, *rows[i], explain(rows[i][0]), game(games[i.split("/")[0]], i))
            for i in json.loads((AB / "ids.json").read_text(encoding="utf-8"))]


def game(cards, i):
    """The card's whole game for the review board: start FEN, moves, and the score (White's view, as the
    prod-depth reads store it) and grade after each move; ply is the reviewed move's (1 = the first move)."""
    cards = sorted(cards, key=lambda c: int(c["id"].split("/")[1]))
    return {"fen": cards[0]["fen"], "moves": [c["uci"] for c in cards], "ply": int(i.split("/")[1]) + 1,
            "scores": [score(c["after"]) for c in cards], "grades": [c["code"] for c in cards]}


def score(read):
    return {"cp": read["cp"], "mate": read["mate"]}


def main():
    AB = HERE / sys.argv[1]
    reads = sys.argv[sys.argv.index("--reads") + 1] if "--reads" in sys.argv else None
    cards = reads_cards(AB, pathlib.Path(reads)) if reads else v5_cards(AB)
    dst = AB / "run-output"
    sealed = (dst / "BLIND-KEY.json").exists()
    if sealed:
        # A sealed key fixes order and sides: only BLINDED.jsonl is rebuilt (texts and their hashes unchanged).
        key = json.loads((dst / "BLIND-KEY.json").read_text(encoding="utf-8"))["pairs"]
        by_id = {c[0]: c for c in cards}
        cards = [by_id[key[pid]["id"]] for pid in sorted(key)]
        sides = [(key[pid]["A"], key[pid]["B"]) for pid in sorted(key)]
    else:
        seed = int.from_bytes(os.urandom(16), "big")
        rng = random.Random(seed)
        rng.shuffle(cards)
        sides = [("relations", "production") if rng.random() < 0.5 else ("production", "relations") for _ in cards]
    out, judge, key = [], [], {}
    for n, ((i, p, r, ours, g), (a, b)) in enumerate(zip(cards, sides), 1):
        pid = f"pair-{n:03d}"
        text = {"relations": ours["text"], "production": r["prose"]}
        # The review board's lines are the cut lines the judge sees; reads rounds add the scores and the game.
        view = {"played_pv": p["played_pv"], "best_pv": p["best_pv"]}
        if g:
            view |= {"before": score(r["before"]), "after": score(r["after"]), "game": g}
        out.append({
            "pair_id": pid,
            "prompt": f"{r['san']} ({r['code']}), {r['mover']}, move {r['moveNumber']}.",
            "facts": {"fen_before": r["fen"], "fen_after": r["fenAfter"], "side": r["mover"], "move_number": r["moveNumber"],
                      "played_uci": r["uci"], "played_san": r["san"], "best_uci": r["bestUci"], "best_san": r["bestSan"],
                      "is_best": r["isBest"], "grade": r["code"], **view},
            "A": answer(text[a]), "B": answer(text[b]),
        })
        judge.append({"pair_id": pid, "fen": p["fen"], "side_to_move": r["mover"], "grade": p["grade"],
                      "played": san_line(p["fen"], p["played_pv"]), "best": san_line(p["fen"], p["best_pv"]),
                      "A": text[a], "B": text[b]})
        key[pid] = {"id": i, "A": a, "B": b, "facts": ours["facts"]}
    (dst / "judge/out").mkdir(parents=True, exist_ok=True)
    (dst / "BLINDED.jsonl").write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in out), encoding="utf-8")
    if sealed:
        print(len(out), "pairs: BLINDED.jsonl rebuilt from the sealed key")
        return tactics.close()
    (dst / "BLIND-KEY.json").write_text(json.dumps({"seed_hex": f"{seed:032x}", "pairs": key}, indent=2) + "\n", encoding="utf-8")
    for k in range(0, len(judge), BATCH):
        (dst / f"judge/batch{k // BATCH + 1}.jsonl").write_text(
            "".join(json.dumps(r) + "\n" for r in judge[k:k + BATCH]), encoding="utf-8")
    shutil.copy(HERE / "RUBRIC.md", dst / "judge/RUBRIC.md")
    print(len(out), "pairs")
    tactics.close()


if __name__ == "__main__":
    main()
