"""explain.py on the production-depth cards (analyze-games.mjs cards.jsonl).

  py research/coach-relations/prod-depth/explain_cards.py <cards.jsonl> <out.jsonl>

Each inaccuracy, mistake or blunder becomes an explain row: played line = the move plus the
after-read PV, best line = the before-read PV, both whole (explain.py decides how much to show;
the coach-v5 4-to-8-ply cut hid exchanges finished later in the line). The grade is production's
own (the card's code). Tail searches go to
tactics.py's cache (sf_cache.jsonl), at the screen depth.
"""
import json
import pathlib
import sys
import time

HERE = pathlib.Path(__file__).resolve().parent
sys.path[:0] = [str(HERE.parent)]
import tactics  # noqa: E402
from explain import explain  # noqa: E402

ERRORS = ("inaccuracy", "mistake", "blunder")


def row(c):
    after = c["after"]["pv"] if c["after"] else []
    return {"id": c["id"], "fen": c["fen"], "grade": c["code"], "played_pv": [c["uci"]] + after, "best_pv": c["before"]["pv"]}


def main():
    src, dst = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
    done = {json.loads(l)["id"] for l in dst.open(encoding="utf-8")} if dst.exists() else set()
    cards = [json.loads(l) for l in src.open(encoding="utf-8")]
    todo = [c for c in cards if c["code"] in ERRORS and c["id"] not in done]
    t0 = time.time()
    with dst.open("a", encoding="utf-8") as f:
        for n, c in enumerate(todo, 1):
            r = row(c)
            try:
                e = explain(r)
                out = {**r, "text": e["text"], "facts": e["facts"], "arrows": e["arrows"], "squares": e["squares"]}
            except Exception as err:  # recorded, never fatal: one bad card must not stop the run
                out = {**r, "error": repr(err)}
            f.write(json.dumps(out) + "\n")
            if n % 200 == 0:
                print(json.dumps({"explained": n, "of": len(todo), "s": round(time.time() - t0)}), flush=True)
    tactics.close()  # before interpreter shutdown, which would wait on the engine thread
    print(json.dumps({"explained": len(todo), "skipped": len(done), "s": round(time.time() - t0)}))


if __name__ == "__main__":
    main()
