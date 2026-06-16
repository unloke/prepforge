"""Confirm the proposed gate swap: drop "sound", add trap_gap.

Old gate (4 conditions, all required):
    1. unintuitive   human_p   <= 0.10
    2. reveal        reveal    >= 0.30
    3. sound-a       sf_truth  >= sf_before - 0.05
    4. sound-b       sf_truth  >= 0.50

New gate (3 conditions, all required):
    1. unintuitive   human_p   <= 0.10
    2. reveal        reveal    >= 0.30
    3. trap_gap      trap_sf   >= MIN_TRAP

trap_sf = sf_truth(played) - sf_truth(the move Maia thinks a human would play).
A high trap_gap means the natural human move throws away the advantage -- the
played move is the only one that works.

Runs on the 23 hand-labeled moves (8 yes / 15 no) using the engine values
already computed by brilliant_probe2.py -- so this is a pure replay, no engine.

    py -3.13 scripts/brilliant_probe5_newgate.py
"""
from __future__ import annotations

from brilliant_probe2_corr import ROWS

# ROWS columns:
# 0 name, 1 label, 2 human_p, 3 maia_glance, 4 reveal, 5 trap_sf, 6 trap_maia,
# 7 p_entropy, 8 policy_margin, 9 sac_invest, 10 sf_draw, 11 sf_truth, 12 sf_before
NAME, LABEL, HUMAN_P, REVEAL, TRAP_SF, SF_TRUTH, SF_BEFORE = 0, 1, 2, 4, 5, 11, 12

MAX_HUMAN_P = 0.10
MIN_REVEAL = 0.30
MAX_DROP = 0.05
MIN_HIGH_WC = 0.50


def old_gate(r) -> bool:
    return (
        r[HUMAN_P] <= MAX_HUMAN_P
        and r[REVEAL] >= MIN_REVEAL
        and r[SF_TRUTH] >= r[SF_BEFORE] - MAX_DROP
        and r[SF_TRUTH] >= MIN_HIGH_WC
    )


def new_gate(r, min_trap: float) -> bool:
    return (
        r[HUMAN_P] <= MAX_HUMAN_P
        and r[REVEAL] >= MIN_REVEAL
        and r[TRAP_SF] >= min_trap
    )


def confusion(rows, predicate):
    tp = fp = tn = fn = 0
    for r in rows:
        flagged = predicate(r)
        yes = r[LABEL] == 1
        if flagged and yes:
            tp += 1
        elif flagged and not yes:
            fp += 1
        elif not flagged and yes:
            fn += 1
        else:
            tn += 1
    return tp, fp, tn, fn


def main():
    print("Per-move verdicts (Y=yes label, .=no label):\n")
    print("{0:<18} {1:>3} {2:>8} {3:>8} {4:>8} | {5:<8} {6:<8}".format(
        "move", "lbl", "human_p", "reveal", "trap_sf", "OLD", "NEW(.05)"))
    print("-" * 70)
    for r in sorted(ROWS, key=lambda x: -x[LABEL]):
        og = "FLAG" if old_gate(r) else " -"
        ng = "FLAG" if new_gate(r, 0.05) else " -"
        lbl = "Y" if r[LABEL] == 1 else "."
        print("{0:<18} {1:>3} {2:>8.3f} {3:>8.3f} {4:>8.3f} | {5:<8} {6:<8}".format(
            r[NAME], lbl, r[HUMAN_P], r[REVEAL], r[TRAP_SF], og, ng))

    print("\n\nConfusion (8 yes / 15 no):")
    print("{0:<22} {1:>4} {2:>4} {3:>4} {4:>4}   {5}".format(
        "gate", "TP", "FP", "TN", "FN", "false positives kept"))
    print("-" * 78)

    tp, fp, tn, fn = confusion(ROWS, old_gate)
    fps = [r[NAME] for r in ROWS if old_gate(r) and r[LABEL] == 0]
    print("{0:<22} {1:>4} {2:>4} {3:>4} {4:>4}   {5}".format(
        "OLD (sound)", tp, fp, tn, fn, ", ".join(fps) or "-"))

    for mt in (0.03, 0.05, 0.07, 0.10):
        pred = lambda r, mt=mt: new_gate(r, mt)
        tp, fp, tn, fn = confusion(ROWS, pred)
        fps = [r[NAME] for r in ROWS if pred(r) and r[LABEL] == 0]
        miss = [r[NAME] for r in ROWS if not pred(r) and r[LABEL] == 1]
        note = "FP: " + (", ".join(fps) or "none")
        if miss:
            note += "  | MISSED yes: " + ", ".join(miss)
        print("{0:<22} {1:>4} {2:>4} {3:>4} {4:>4}   {5}".format(
            "NEW trap>={0:.2f}".format(mt), tp, fp, tn, fn, note))


if __name__ == "__main__":
    main()
