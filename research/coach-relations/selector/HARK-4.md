# Hark on the reason selector (2026-10-15)

Agrees: the linear model must not ship, and the result is an informative null, not just "not
significant". Wrong picks are 3-5%, so choosing among candidates has little room; the error mass
is speaking when the card should stay bare. Next: confirm the speak/stay-bare labels, then confirm
weak-type v2 on fresh cards.

## Tests and power

- Paired bootstrap on the same cards (one card per game, so it is a cluster bootstrap), 10,000
  resamples, percentile or BCa; McNemar as a side check.
- With about 20% of cards decided differently by two policies, 360 cards separate 8-10pp, 5pp is
  borderline, 2-3pp is not detectable. The L vs R1b CI rules out a gain above about 3pp.
- Thresholds set on training folds only is right; nested CV (C and threshold together) is stricter.
- The real optimism risk is editing the weak-type list after seeing per-type rates: v2 must be
  validated on new cards only. Per-type rates need Wilson CIs and Beta shrinkage toward the overall
  rate before deciding.
- R3 (loss < 200cp stays bare) costs 22pp coverage for +2pp hit. Use win-probability drop, not cp.

## Features (for in-type rules, not for the model)

- explained_share: cp the reason verifies / eval drop. Should split material_small and trades.
- subsumed_by_other: fork loses points where material already contains it; check by cross-tab.
- settled_in_window: small material settled inside the window, the line not still capturing or checking.
- contrast_strength: weak when both lines have the same kind of fact (passed_pawn, pawn_weakness).
- Win-probability drop instead of log cp; bucket |eval_best|.

## Pre-registered criterion

Self-consistency kappa 0.80 shows sol is stable, not that it is right: a second judge and a user
spot-check are still needed. L' upper bound +4.8pp stays below the +5pp bar.

Confirmation set: about 250 new cards, one per game, weighted to the pool. Labels: sol and a second
judge agree, taken; disagree, the user decides. Precondition: user vs sol speak/stay-bare kappa >= 0.6,
multi-candidate best agreement >= 70%.

H1, ship weak-type v2 (all must hold):
- v2 vs R0: hit >= +10pp, paired bootstrap 95% CI lower bound > 0;
- v2 vs R1: CI lower bound of the hit difference > -3pp, coverage >= R1 - 2pp;
- speak-when-should-stay-bare rate <= 12%.

H2, a learned model replaces the rule: with coverage within +-3pp, hit >= +5pp with the paired
bootstrap 95% CI lower bound > 0; recall drops by at most 5pp; utility (right +1, wrong -2, bare 0)
not below the rule's. If any fails, keep the rule.

## Next steps, in order

1. A second judge rates all 360 cards; the user spot-checks 60 (kappa >= 0.6).
2. Freeze weak-type v2, register H1/H2.
3. Label about 250 new cards, run once.
4. Stop work on choosing among candidates.
