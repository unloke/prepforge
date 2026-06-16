"""Correlation / AUC of each brilliant-probe feature against the yes/no label.

Takes the 23 labeled rows from scripts/brilliant_probe2.py's run (8 yes, 15 no)
and reports, for every feature, the point-biserial correlation with the label
and the AUC (probability a random "yes" outranks a random "no"). Features near
r=0 / AUC=0.5 carry no signal for this set and are candidates to drop.

    py -3.13 scripts/brilliant_probe2_corr.py
"""
from __future__ import annotations

import math

# label: 1 = yes (true brilliancy), 0 = no (false positive)
ROWS = [
    # name, label, human_p, maia_glance, reveal, trap_sf, trap_maia, p_entropy, policy_margin, sac_invest, sf_draw, sf_truth, sf_before, only_move_gap
    ("Immortal Qxh7+", 1, 0.003, 0.611, 0.365, 0.419, -0.183, 0.78, 0.886, 8.0, 0.000, 0.975, 0.975, None),
    ("Rubinstein Rxc3", 1, 0.006, 0.515, 0.390, 0.282, -0.107, 0.89, 0.866, 0.0, 0.000, 0.906, 0.867, None),
    ("Rubinstein Rd2", 1, 0.023, 0.380, 0.596, 0.701, 0.065, 1.73, 0.452, 0.0, 0.000, 0.975, 0.975, None),
    ("Marshall Qg3", 1, 0.000, 0.389, 0.472, 0.277, -0.207, 1.74, 0.662, 9.0, 0.000, 0.861, 0.856, None),
    ("#5 28.Qxe4", 1, 0.078, 0.182, 0.321, 0.336, -0.075, 3.13, 0.196, 6.0, 0.997, 0.504, 0.503, None),
    ("#6 54...Rxg4", 1, 0.009, 0.461, 0.374, 0.213, -0.235, 3.02, 0.219, 4.0, 0.000, 0.835, 0.825, None),
    ("#13 29...Bg3", 1, 0.034, 0.458, 0.391, 0.091, -0.130, 2.49, 0.348, 1.0, 0.000, 0.848, 0.855, None),
    ("#18 13.axb4", 1, 0.096, 0.319, 0.363, 0.178, -0.254, 2.94, 0.142, 2.0, 0.006, 0.682, 0.686, None),
    ("Blitz Rd2 (dud)", 0, 0.029, 0.661, 0.204, -0.022, 0.003, 2.53, 0.324, 0.0, 0.000, 0.865, 0.888, None),
    ("#2 40...Re8", 0, 0.060, 0.264, 0.287, 0.018, -0.104, 3.02, 0.218, 0.0, 0.947, 0.550, 0.570, None),
    ("#4 53.Rf3+", 0, 0.020, 0.437, 0.367, -0.020, -0.136, 1.30, 0.466, 0.0, 0.000, 0.804, 0.818, None),
    ("#7 41.Kf2", 0, 0.038, 0.532, 0.342, 0.026, -0.025, 2.78, 0.281, 0.0, 0.000, 0.875, 0.875, None),
    ("#8 45...Kc8", 0, 0.058, 0.097, 0.403, 0.000, -0.002, 1.98, 0.339, 0.0, 0.998, 0.500, 0.500, None),
    ("#9 65.Qd1", 0, 0.004, 0.675, 0.197, -0.104, -0.039, 2.52, 0.396, 0.0, 0.000, 0.872, 0.875, None),
    ("#10 66...Kg6", 0, 0.074, 0.512, 0.367, -0.003, -0.121, 1.77, 0.376, 0.0, 0.000, 0.879, 0.870, None),
    ("#11 41...Kg7", 0, 0.081, 0.494, 0.284, 0.278, 0.119, 1.89, 0.588, 0.0, 0.000, 0.778, 0.776, None),
    ("#12 34.Rbf7+", 0, 0.035, 0.536, 0.426, -0.003, -0.185, 2.00, 0.339, 0.0, 0.000, 0.962, 0.877, None),
    ("#15 35...Qa1+", 0, 0.002, 0.664, 0.308, -0.003, -0.033, 1.54, 0.627, 0.0, 0.000, 0.972, 0.970, None),
    ("#16 66.Qc2", 0, 0.010, 0.459, 0.338, -0.035, 0.119, 2.95, 0.250, 0.0, 0.000, 0.797, 0.807, None),
    ("#17 88...Be4", 0, 0.005, 0.525, 0.326, -0.010, -0.109, 0.85, 0.869, 0.0, 0.000, 0.851, 0.852, None),
    ("#19 5.c3", 0, 0.005, 0.493, 0.295, -0.039, -0.090, 2.51, 0.418, 0.0, 0.000, 0.788, 0.829, None),
    ("#20 41.Qb7+", 0, 0.054, 0.625, 0.330, 0.028, -0.037, 1.37, 0.713, 0.0, 0.000, 0.955, 0.975, None),
    ("#21 33...Re8", 0, 0.015, 0.569, 0.308, -0.002, 0.035, 2.95, 0.321, 1.0, 0.000, 0.877, 0.889, None),
]

FEATURES = [
    "human_p", "maia_glance", "reveal", "trap_sf", "trap_maia", "p_entropy",
    "policy_margin", "sac_invest", "sf_draw", "sf_truth", "sf_before",
]

# sf_truth - sf_before = the "drop vs before" the 4th gate condition checks
EXTRA = "drop_vs_before"


def pearson(xs, ys):
    n = len(xs)
    mx, my = sum(xs) / n, sum(ys) / n
    cov = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    vx = sum((x - mx) ** 2 for x in xs)
    vy = sum((y - my) ** 2 for y in ys)
    if vx == 0 or vy == 0:
        return float("nan")
    return cov / math.sqrt(vx * vy)


def auc(values, labels):
    """AUC = P(random yes > random no), Mann-Whitney U based."""
    yes = [v for v, l in zip(values, labels) if l == 1]
    no = [v for v, l in zip(values, labels) if l == 0]
    total = len(yes) * len(no)
    wins = 0.0
    for y in yes:
        for n in no:
            if y > n:
                wins += 1
            elif y == n:
                wins += 0.5
    return wins / total


def main():
    labels = [r[1] for r in ROWS]
    print("{0:<16} {1:>8} {2:>6} {3:>9}".format("feature", "r", "AUC", "|AUC-.5|"))
    print("-" * 44)
    results = []
    for i, name in enumerate(FEATURES):
        idx = 2 + i
        values = [r[idx] for r in ROWS]
        r = pearson(values, labels)
        a = auc(values, labels)
        results.append((name, r, a, abs(a - 0.5)))
    # drop_vs_before = sf_truth - sf_before
    values = [r[10] - r[11] for r in ROWS]  # sf_truth - sf_before
    r = pearson(values, labels)
    a = auc(values, labels)
    results.append((EXTRA, r, a, abs(a - 0.5)))

    for name, r, a, _ in sorted(results, key=lambda t: -abs(t[1])):
        print("{0:<16} {1:>8.3f} {2:>6.3f} {3:>9.3f}".format(name, r, a, abs(a - 0.5)))


if __name__ == "__main__":
    main()
