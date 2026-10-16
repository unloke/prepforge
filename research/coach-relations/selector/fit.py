"""Reason selector, offline: hand-written rule baselines against a small logistic model, on the
candidate-level labels in cand/ (sol: per candidate correct / main; per card the best one or none).

  py -B selector/fit.py [--consensus]   -> EVAL.md (EVAL-consensus.md), weights.json

Positive candidate: correct and main. A policy shows at most one candidate per card or abstains.
Cards are split by game ID (GroupKFold, 5 folds). Metrics per policy and threshold, over all cards:
  coverage   cards shown a reason;
  hit        shown reason is correct and main (precision);
  wrong      cards shown a bad reason, split into 'should abstain' (no candidate on the card is
             good) and 'wrong pick' (another candidate was good);
  recall     cards with a good candidate that show a good one.
"""
import json
import math
from pathlib import Path

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import GroupKFold

HERE = Path(__file__).resolve().parent
TYPES = ["mate", "forced_mate", "material_big", "material_small", "material_unfinished", "promotion", "mate_threat",
         "castling", "fork", "passed_pawn", "bishop_pair", "queen_chased", "pawn_weakness", "restricted", "outpost",
         "piece_harassed", "trades", "draw_risk"]
GRADES = ["inaccuracy", "mistake", "blunder"]
NAMES = TYPES + GRADES + ["played_line", "ply", "net", "log_loss", "mate_score", "rank1", "rank2", "n_cands", "move"]
WEAK = {"trades", "piece_harassed", "pawn_weakness", "restricted", "outpost", "passed_pawn", "draw_risk", "material_unfinished"}
THRESHOLDS = (0.0, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8)
POOL = {1: 0.43, 2: 0.30}  # share of error cards with one / two or more candidates (0: 27%, always bare)


def kind(f, mover):
    t = f["type"]
    if t == "material":
        if f["line"] == "played" and f["side"] == mover:
            return "material_unfinished"
        return "material_big" if f["net"] >= 3 else "material_small"
    return t


def mover(c):
    return "white" if c["mover_white"] else "black"


def feats(f, pos, card):
    loss = card["loss"]
    x = [kind(f, mover(card)) == t for t in TYPES] + [card["grade"] == g for g in GRADES]
    x += [f["line"] == "played", min(f["ply"], 10) / 10, min(f.get("net", 0), 9) / 9,
          math.log1p(min(loss, 2000)) / 7.6 if loss is not None else 1.0, loss is None,
          pos == 0, pos == 1, len(card["facts"]) / 4, min(card["move"], 60) / 60]
    return np.array(x, dtype=float)


def load(consensus=False):
    """consensus: keep the cards whose two sol passes (cand/, cand2/) agree on every candidate."""
    cards = load_pass("cand")
    if not consensus:
        return cards
    other = {c["n"]: c for c in load_pass("cand2")}
    return [c for c in cards if c["n"] in other and other[c["n"]]["good"] == c["good"]]


def load_pass(d, out=None):
    """out: the labels' folder, when another judge labelled d's cards (default d/out)."""
    key = {k["n"]: k for k in map(json.loads, (HERE / d / "key.jsonl").read_text(encoding="utf-8").splitlines())}
    items = {}
    for p in sorted((HERE / d).glob("batch-*.jsonl")):
        for o in map(json.loads, p.read_text(encoding="utf-8").splitlines()):
            items[o["n"]] = o
    cards = []
    for p in sorted((HERE / (out or d + "/out")).glob("batch-*.jsonl")):
        for lab in map(json.loads, p.read_text(encoding="utf-8").splitlines()):
            k, it = key[lab["n"]], items[lab["n"]]
            byk = {c["k"]: c for c in lab["candidates"]}
            shown = [byk[k["rank_of_k"][j]] for j in range(len(k["facts"]))]
            cards.append(dict(k, mover_white=it["side_to_move"] == "white", good=[bool(c["correct"] and c["main"]) for c in shown],
                              correct=[bool(c["correct"]) for c in shown], best=lab["best"],
                              confidence=lab.get("confidence"), game=k["id"].split("/")[0]))
    return cards


def weights(cards):
    """Reweight the sample to the pool's mix of one-candidate and multi-candidate cards."""
    n1 = sum(len(c["facts"]) == 1 for c in cards)
    share = {1: POOL[1] / sum(POOL.values()), 2: POOL[2] / sum(POOL.values())}
    return [share[1] / (n1 / len(cards)) if len(c["facts"]) == 1 else share[2] / (1 - n1 / len(cards)) for c in cards]


def evaluate(cards, choice, w=None):
    """choice[i]: the rank position shown on card i, or None to abstain. Weighted by w."""
    w = w or [1.0] * len(cards)
    tot = sum(w)
    shown = [(c, j, x) for c, j, x in zip(cards, choice, w) if j is not None]
    cov = sum(x for _, _, x in shown)
    hit = sum(x * c["good"][j] for c, j, x in shown)
    should = sum(x for c, j, x in shown if not c["good"][j] and not any(c["good"]))
    pick = sum(x for c, j, x in shown if not c["good"][j] and any(c["good"]))
    anyg = sum(x for c, x in zip(cards, w) if any(c["good"]))
    return {"coverage": cov / tot, "hit": hit / cov if cov else float("nan"),
            "should": should / tot, "pick": pick / tot, "recall": hit / anyg if anyg else float("nan")}


def line(name, m):
    return f"| {name} | {m['coverage']:.0%} | {m['hit']:.0%} | {m['should']:.0%} | {m['pick']:.0%} | {m['recall']:.0%} |"


HEAD = ["| Policy | Coverage | Hit | Wrong: should abstain | Wrong: other was good | Recall |",
        "| --- | ---: | ---: | ---: | ---: | ---: |"]


def r1(c):
    """Hand rule: the top-ranked candidate unless it is a weak type; then nothing."""
    return None if kind(c["facts"][0], mover(c)) in WEAK else 0


def r1b(c):
    """Hand rule: the first candidate in rank order that is not a weak type; nothing if none."""
    return next((j for j, f in enumerate(c["facts"]) if kind(f, mover(c)) not in WEAK), None)


def fit_fold(cards, tr):
    tally, X, y = {}, [], []
    for i in tr:
        c = cards[i]
        for j, f in enumerate(c["facts"]):
            a, b = tally.get(kind(f, mover(c)), (0, 0))
            tally[kind(f, mover(c))] = (a + c["good"][j], b + 1)
            X.append(feats(f, j, c))
            y.append(c["good"][j])
    model = LogisticRegression(C=0.5, max_iter=2000).fit(np.array(X), np.array(y))
    table = lambda c: [(tally.get(kind(f, mover(c)), (0, 0))[0] + 1) / (tally.get(kind(f, mover(c)), (0, 0))[1] + 2) for f in c["facts"]]
    lin = lambda c: list(model.predict_proba(np.array([feats(f, j, c) for j, f in enumerate(c["facts"])]))[:, 1])
    return table, lin


def matched(scorefn, cards, tr, w, rule):
    """A threshold set on the training fold alone: the one whose (weighted) coverage there is closest
    to the rule's coverage there. The scores on the training fold are in-sample, so only the
    threshold, not the test-fold result, is affected."""
    best = [max(scorefn(cards[i])) for i in tr]
    target = sum(w[i] for i in tr if rule(cards[i]) is not None) / sum(w[i] for i in tr)
    cands = sorted(set(best))
    cov = lambda t: sum(w[i] for i, b in zip(tr, best) if b >= t) / sum(w[i] for i in tr)
    return min(cands, key=lambda t: abs(cov(t) - target))


def boot(cards, w, a, b, n=4000, seed=1):
    """Paired bootstrap over cards of (hit rate of a) - (hit rate of b), and of their bad-shown rates."""
    rng = np.random.default_rng(seed)
    idx = np.arange(len(cards))
    good = lambda ch, i: ch[i] is not None and cards[i]["good"][ch[i]]
    bad = lambda ch, i: ch[i] is not None and not cards[i]["good"][ch[i]]
    G = np.array([[good(a, i), good(b, i)] for i in idx], float)
    B = np.array([[bad(a, i), bad(b, i)] for i in idx], float)
    S = np.array([[a[i] is not None, b[i] is not None] for i in idx], float)
    W = np.array(w)
    dh, db = [], []
    for _ in range(n):
        k = rng.choice(idx, len(idx))
        ww = W[k]
        hit = (G[k] * ww[:, None]).sum(0) / np.maximum((S[k] * ww[:, None]).sum(0), 1e-9)
        bd = (B[k] * ww[:, None]).sum(0) / ww.sum()
        dh.append(hit[0] - hit[1])
        db.append(bd[0] - bd[1])
    q = lambda v: (np.percentile(v, 2.5), np.percentile(v, 97.5))
    return q(dh), q(db)


def main():
    import sys
    consensus = "--consensus" in sys.argv
    cards = load(consensus)
    w = weights(cards)
    n = len(cards)
    out = ["# Reason selector: offline evaluation" + (" (cards both sol passes label alike)" if consensus else ""), "",
           f"{n} labelled cards (sol, candidate level), {sum(len(c['facts']) for c in cards)} candidates; "
           f"{sum(any(c['good']) for c in cards)} cards have a good (correct and main) candidate; "
           f"{sum(len(c['facts']) > 1 for c in cards)} have two or more candidates; "
           f"{sum(all(c['correct']) for c in cards)} have every candidate correct.", "",
           "Rates are weighted to the pool's mix (among cards with a candidate: one candidate 59%, two or more "
           "41%); the 27% of error cards with no candidate stay bare under every policy, so pool coverage = "
           "coverage x 0.73. Wrong = shown a reason that is not good: 'should abstain' when no candidate on "
           "the card is good, 'other was good' when another one was.", "", "## Rules", ""] + HEAD
    rules = {"R0 current Coach (rank 1, always)": lambda c: 0,
             "R1 rank 1 unless a weak type": r1,
             "R1b first non-weak candidate": r1b}
    for t in (100, 200):
        rules[f"R2 rank 1 unless loss < {t}cp"] = lambda c, t=t: None if c["loss"] is not None and c["loss"] < t else 0
        rules[f"R3 R1b unless loss < {t}cp"] = lambda c, t=t: None if c["loss"] is not None and c["loss"] < t else r1b(c)
    out.append(line("oracle", evaluate(cards, [c["good"].index(True) if any(c["good"]) else None for c in cards], w)))
    for name, rule in rules.items():
        out.append(line(name, evaluate(cards, [rule(c) for c in cards], w)))
    folds = list(GroupKFold(5).split(np.zeros(n), groups=[c["game"] for c in cards]))
    table, lin, nested = [None] * n, [None] * n, {"T'": [None] * n, "L'": [None] * n}
    for tr, te in folds:
        tf, lf = fit_fold(cards, tr)
        for key, fn in (("T'", tf), ("L'", lf)):
            t = matched(fn, cards, tr, w, r1b)
            for i in te:
                s_ = fn(cards[i])
                j = int(np.argmax(s_))
                nested[key][i] = j if s_[j] >= t else None
        for i in te:
            table[i], lin[i] = tf(cards[i]), lf(cards[i])
    for name, sc, first in (("T: per-type hit table, rank-1 candidate", table, True), ("T': per-type hit table, best-scored candidate", table, False),
                            ("L: logistic, rank-1 candidate", lin, True), ("L': logistic, best-scored candidate", lin, False)):
        out += ["", f"## {name} (out of fold, threshold sweep)", ""] + HEAD
        for t in THRESHOLDS:
            ch = []
            for s_ in sc:
                j = 0 if first else int(np.argmax(s_))
                ch.append(j if s_[j] >= t else None)
            out.append(line(f"threshold {t:.1f}", evaluate(cards, ch, w)))
    base = [r1b(c) for c in cards]
    out += ["", "## Same coverage as R1b, threshold chosen on the training folds only", ""] + HEAD
    out.append(line("R1b first non-weak candidate", evaluate(cards, base, w)))
    for key in ("T'", "L'"):
        out.append(line(f"{key} nested", evaluate(cards, nested[key], w)))
    out.append("")
    for key in ("T'", "L'"):
        (h0, h1), (b0, b1) = boot(cards, w, nested[key], base)
        out.append(f"- {key} minus R1b, paired bootstrap 95% CI: hit {h0:+.1%} to {h1:+.1%}; cards shown a bad reason {b0:+.1%} to {b1:+.1%}")
    multi = [i for i, c in enumerate(cards) if len(c["facts"]) > 1 and any(c["good"])]
    out += ["", "## Choice among two or more candidates (cards with a good one)", "",
            f"{len(multi)} cards. Picks a good candidate:",
            f"- rank 1: {sum(cards[i]['good'][0] for i in multi) / len(multi):.0%}",
            f"- first non-weak (R1b, when it picks): {sum(cards[i]['good'][r1b(cards[i])] for i in multi if r1b(cards[i]) is not None) / max(1, sum(r1b(cards[i]) is not None for i in multi)):.0%}",
            f"- type table: {sum(cards[i]['good'][int(np.argmax(table[i]))] for i in multi) / len(multi):.0%}",
            f"- logistic: {sum(cards[i]['good'][int(np.argmax(lin[i]))] for i in multi) / len(multi):.0%}"]
    X = np.array([feats(f, j, c) for c in cards for j, f in enumerate(c["facts"])])
    y = np.array([c["good"][j] for c in cards for j in range(len(c["facts"]))])
    model = LogisticRegression(C=0.5, max_iter=2000).fit(X, y)
    (HERE / "weights.json").write_text(json.dumps({"bias": model.intercept_[0], **dict(zip(NAMES, model.coef_[0]))}, indent=1) + "\n", encoding="utf-8")
    (HERE / ("EVAL-consensus.md" if consensus else "EVAL.md")).write_text("\n".join(out) + "\n", encoding="utf-8")
    print("\n".join(out))


if __name__ == "__main__":
    main()
