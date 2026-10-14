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
in ab/run-output/BLIND-KEY.json. Codex gets ab/run-output/judge/batchN.jsonl and RUBRIC.md.
"""
import hashlib
import json
import os
import pathlib
import random
import sys

import chess

import tactics
from explain import explain

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
    return [(i, pos[i], prod[i], explain(pos[i])) for i in json.loads((AB / "ids.json").read_text(encoding="utf-8"))]


def reads_cards(AB, reads):
    """The same from prod-depth kernel outputs (<reads>/fresh*/cards.jsonl, explain.jsonl): both
    programs on production's reads. Draws PER_GRADE unseen cards of each error grade once."""
    rows = {}
    for d in sorted(reads.glob("fresh*")):
        cards = {c["id"]: c for c in jsonl(d / "cards.jsonl")}
        rows.update({e["id"]: (e, cards[e["id"]]) for e in jsonl(d / "explain.jsonl") if "text" in e})
    if not (AB / "ids.json").exists():
        seen, rng, ids = unseen(), random.Random(int.from_bytes(os.urandom(16), "big")), []
        for g in ERRORS:
            ids += rng.sample(sorted(i for i, (e, _) in rows.items() if e["grade"] == g and i not in seen), PER_GRADE)
        AB.mkdir(exist_ok=True)
        (AB / "ids.json").write_text(json.dumps(ids) + "\n", encoding="utf-8")
    return [(i, *rows[i], rows[i][0]) for i in json.loads((AB / "ids.json").read_text(encoding="utf-8"))]


def main():
    AB = HERE / sys.argv[1]
    reads = sys.argv[sys.argv.index("--reads") + 1] if "--reads" in sys.argv else None
    cards = reads_cards(AB, pathlib.Path(reads)) if reads else v5_cards(AB)
    seed = int.from_bytes(os.urandom(16), "big")
    rng = random.Random(seed)
    rng.shuffle(cards)
    out, judge, key = [], [], {}
    for n, (i, p, r, ours) in enumerate(cards, 1):
        pid = f"pair-{n:03d}"
        text = {"relations": ours["text"], "production": r["prose"]}
        a, b = ("relations", "production") if rng.random() < 0.5 else ("production", "relations")
        out.append({
            "pair_id": pid,
            "prompt": f"{r['san']} ({r['code']}), {r['mover']}, move {r['moveNumber']}.",
            "facts": {"fen_before": r["fen"], "fen_after": r["fenAfter"], "side": r["mover"], "move_number": r["moveNumber"],
                      "played_uci": r["uci"], "played_san": r["san"], "best_uci": r["bestUci"], "best_san": r["bestSan"],
                      "is_best": r["isBest"], "grade": r["code"]},
            "A": answer(text[a]), "B": answer(text[b]),
        })
        judge.append({"pair_id": pid, "fen": p["fen"], "side_to_move": r["mover"], "grade": p["grade"],
                      "played": san_line(p["fen"], p["played_pv"]), "best": san_line(p["fen"], p["best_pv"]),
                      "A": text[a], "B": text[b]})
        key[pid] = {"id": i, "A": a, "B": b, "facts": ours["facts"]}
    dst = AB / "run-output"
    (dst / "judge/out").mkdir(parents=True, exist_ok=True)
    (dst / "BLINDED.jsonl").write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in out), encoding="utf-8")
    (dst / "BLIND-KEY.json").write_text(json.dumps({"seed_hex": f"{seed:032x}", "pairs": key}, indent=2) + "\n", encoding="utf-8")
    for k in range(0, len(judge), BATCH):
        (dst / f"judge/batch{k // BATCH + 1}.jsonl").write_text(
            "".join(json.dumps(r) + "\n" for r in judge[k:k + BATCH]), encoding="utf-8")
    print(len(out), "pairs")
    tactics.close()


if __name__ == "__main__":
    main()
