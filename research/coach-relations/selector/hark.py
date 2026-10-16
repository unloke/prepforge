"""Second judge: Hark's blind labels on the 360 development cards (judge/out, same cards and
candidate order as cand/) against sol, and the user's 60-card spot-check set (PREREG.md).

  py -B selector/hark.py   -> HARK.md, spot/run-output/BLINDED.jsonl (blind), spot/key.jsonl

Spot-check: 40 random cards (30 multi-candidate, 10 single) and 20 more where sol (cand/) and Hark
disagree on the card (one speaks and the other stays bare, or both speak with different picks),
shuffled together. run-output/BLINDED.jsonl holds only what the judges saw, for coach-ab-review's pick
mode; key.jsonl says which set a card is in. Review with
  node research/coach-ab-review/serve.mjs research/coach-relations/selector/spot
"""
import hashlib
import json
import random
from collections import defaultdict

import chess

import fit
import v2
from agree import kappa

SEED = 20261015


def ranked(cards):
    """best as a rank position (the passes show candidates in different orders), None to stay bare."""
    return {c["n"]: dict(c, best=None if c["best"] is None else c["rank_of_k"].index(c["best"])) for c in cards}


def card_view(a):
    return a["best"]


def disagree(s, h):
    return card_view(s) != card_view(h)


def ucis(fen, line):
    """A SAN line with move numbers ('18...Bd4 19.Rd1') as UCI moves from fen."""
    b, out = chess.Board(fen), []
    for tok in line.split():
        m = b.parse_san(tok.split(".")[-1])
        out.append(m.uci())
        b.push(m)
    return out


def review_card(i, c):
    """One card for coach-ab-review's pick mode: what the judges saw, candidates in the same order."""
    played, best = ucis(c["fen"], c["played_line"]), ucis(c["fen"], c["best_line"])
    # The first prompt line is a header; the review shows the rest, the loss the judges saw.
    return {"pair_id": f"card-{i:02d}",
            "prompt": f"{c['played']} ({c['grade']}), best {c['best']}.\n"
                      + (f"Loss {c['eval_loss_cp']} cp" if c["eval_loss_cp"] is not None else "Loss: mate"),
            "facts": {"fen_before": c["fen"], "side": c["side_to_move"], "move_number": chess.Board(c["fen"]).fullmove_number,
                      "played_uci": played[0], "played_san": c["played"], "best_uci": best[0], "best_san": c["best"],
                      "is_best": False, "grade": c["grade"], "played_pv": played, "best_pv": best},
            "candidates": [{"response": x["text"], "finish": {"finished": True},
                            "content_sha256": hashlib.sha256(x["text"].encode()).hexdigest()} for x in c["candidates"]]}


def main():
    sol = ranked(fit.load_pass("cand"))
    sol2 = ranked(fit.load_pass("cand2"))
    hark = ranked(fit.load_pass("cand", "judge/out"))
    ns = sorted(hark)
    assert ns == sorted(sol) == list(range(360)), "Hark must label all 360 cards"
    for n in ns:
        assert len(hark[n]["good"]) == len(sol[n]["good"]), n

    out = ["# Hark vs sol on the 360 development cards", ""]

    def compare(name, a):
        ga = [g for n in ns for g in a[n]["good"]]
        gh = [g for n in ns for g in hark[n]["good"]]
        ca = [g for n in ns for g in a[n]["correct"]]
        ch = [g for n in ns for g in hark[n]["correct"]]
        sa = [a[n]["best"] is not None for n in ns]
        sh = [hark[n]["best"] is not None for n in ns]
        multi = [n for n in ns if len(a[n]["good"]) > 1 and a[n]["best"] is not None and hark[n]["best"] is not None]
        agr = lambda x, y: sum(p == q for p, q in zip(x, y)) / len(x)
        return [f"## Hark vs {name}", "",
                f"- candidates ({len(ga)}): good (correct and main) agreement {agr(ga, gh):.0%}, kappa {kappa(ga, gh):.2f}; "
                f"correct agreement {agr(ca, ch):.0%}, kappa {kappa(ca, ch):.2f}",
                f"- speak or stay bare ({len(ns)} cards): agreement {agr(sa, sh):.0%}, kappa {kappa(sa, sh):.2f}; "
                f"speaks on {sum(sa) / len(ns):.0%} ({name}) vs {sum(sh) / len(ns):.0%} (Hark)",
                f"- multi-candidate cards where both pick one: {len(multi)}; same pick "
                f"{sum(a[n]['best'] == hark[n]['best'] for n in multi) / max(1, len(multi)):.0%}",
                f"- cards decided differently: {sum(disagree(a[n], hark[n]) for n in ns)}", ""]

    out += compare("sol pass 1 (cand)", sol) + compare("sol pass 2 (cand2)", sol2)

    sh = [hark[n]["best"] is not None for n in ns]
    ss = [sol[n]["best"] is not None for n in ns]
    out += ["Speak / stay bare, sol pass 1 by Hark:", "",
            "| | Hark speaks | Hark bare |", "| --- | ---: | ---: |",
            f"| sol speaks | {sum(a and b for a, b in zip(ss, sh))} | {sum(a and not b for a, b in zip(ss, sh))} |",
            f"| sol bare | {sum(b and not a for a, b in zip(ss, sh))} | {sum(not a and not b for a, b in zip(ss, sh))} |", ""]

    st = defaultdict(lambda: [0, 0, 0])
    for n in ns:
        c = sol[n]
        for j, f in enumerate(c["facts"]):
            s = st[fit.kind(f, fit.mover(c))]
            s[0] += 1
            s[1] += c["good"][j]
            s[2] += hark[n]["good"][j]
    out += ["Good rate per candidate type (v2 weak types marked *):", "",
            "| Type | n | sol | Hark |", "| --- | ---: | ---: | ---: |"]
    for t, (k, a, b) in sorted(st.items(), key=lambda x: -x[1][0]):
        out.append(f"| {t}{' *' if t in v2.WEAK2 else ''} | {k} | {a / k:.0%} | {b / k:.0%} |")

    cards = [hark[n] for n in ns]
    w = fit.weights(cards)
    out += ["", "Policies scored with Hark's labels (pool-weighted; v2 was chosen on sol's labels):", ""] + fit.HEAD[:1]
    out[-1] += " Utility |"
    out.append(fit.HEAD[1] + " ---: |")
    for name, pol in (("R0", lambda c: 0), ("R1b (v1)", fit.r1b), ("R1b (v2)", v2.r1v2)):
        m = fit.evaluate(cards, [pol(c) for c in cards], w)
        out.append(fit.line(name, m) + f" {v2.utility(m):+.2f} |")

    rng = random.Random(SEED)
    multi = [n for n in ns if len(sol[n]["good"]) > 1]
    single = [n for n in ns if len(sol[n]["good"]) == 1]
    rand = rng.sample(multi, 30) + rng.sample(single, 10)
    diff = [n for n in ns if disagree(sol[n], hark[n]) and n not in rand]
    dis = rng.sample(diff, 20)
    picked = rand + dis
    rng.shuffle(picked)
    items = {}
    for p in sorted((fit.HERE / "cand").glob("batch-*.jsonl")):
        for o in map(json.loads, p.read_text(encoding="utf-8").splitlines()):
            items[o["n"]] = o
    d = fit.HERE / "spot"
    (d / "run-output").mkdir(parents=True, exist_ok=True)
    (d / "run-output/BLINDED.jsonl").write_text(
        "".join(json.dumps(review_card(i + 1, items[n]), ensure_ascii=False) + "\n" for i, n in enumerate(picked)), encoding="utf-8")
    (d / "key.jsonl").write_text("".join(json.dumps({"pair_id": f"card-{i + 1:02d}", "n": n, "set": "random" if n in rand else "disagree"})
                                         + "\n" for i, n in enumerate(picked)), encoding="utf-8")
    out += ["", f"Spot-check set (seed {SEED}): 40 random (30 multi, 10 single) + 20 of the "
            f"{sum(disagree(sol[n], hark[n]) for n in ns) - sum(disagree(sol[n], hark[n]) for n in rand)} "
            "disagreement cards outside the random 40, shuffled, in `spot/`."]
    (fit.HERE / "HARK.md").write_text("\n".join(out) + "\n", encoding="utf-8")
    print("\n".join(out))


if __name__ == "__main__":
    main()
