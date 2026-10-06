# Scout v11 path guard: protocol (frozen before the first Kaggle run)

Continues the Scout risk research (`artifacts/benchmarks/scout-risk-probes-20261005`, runs 01–49).
Production v10 is unchanged.

## Defect

The v10 only engine gate is the leaf: user CP below -75 or an adverse mate rejects a line.
A line can pass at the leaf while an earlier position after a preparing-side move is
below -75 (endpoint mask). The run-02 audit found 142 of 713 v10 rows masked (47/262
weak, 95/451 fills), with at least one in 51 of 60 sessions.

## Stopped (not rerun)

Fixed/feature probes, joint-v1, paid-admission, conditional cheapest-proof, risk-proposal
retention, paid-opportunity projection, end-state recombination/repair, same-anchor
continuation only, and the blanket -75 full-path floor inside the quality-first
superiority search. Quality-first-v1 "beat v10 by 25cp/5cp" is not a go criterion: its
oracle ceiling is 11/64 sessions (6/64 with the floor).

## Mechanism (one, fixed)

v11 = v10 cohort, weights, posterior, anchors (n >= 3, n_eff >= 2), reach >= 0.10,
300-candidate depth8 leaf queue, diversity rule and twelve real full lines, plus a check
inside `selectPreparationRoutes` before a row is committed:

1. Read the row's preparing-side positions at the production depth8 config, deepest first,
   one `ucinewgame` per line so the hash carries back along it (Lichess fishnet analyses
   games backwards the same way). Stop at the first unsafe position. Verdicts are shared
   by position across rows.
2. Unsafe = the existing leaf rule (CP < -75 or adverse mate). No new threshold.
3. Failure after the anchor: next most common continuation through that anchor (<= 3 tries).
4. Failure at or before the anchor: drop the anchor (<= 4 per colour). A weak anchor is
   dropped only while another weak anchor can still take a slot.
5. Past a cap the v10 row stays, marked `risk`. When the node budget is spent, rows
   commit exactly as v10 picks them, marked `unverified`. The row count is never below v10's.

Budget: extra Stockfish nodes <= 30% of that colour's v10 leaf nodes. This is a hard
cap; overshoot is at most one depth8 search. Production cannot accept more than +40%.

## Data

All 60 train/development sessions from `scout-depth16-batch07-20261003`. The v10 leaf
receipts come from `scout-recommendation-audit-20261005`, cached as production would.
The 4 known-problem sessions are reported separately and are not independent. Native16
labels are evaluator-only. The locked test is untouched.

Arms: v10 (replay; must equal the audit's selection), v11 (30% cap), v11-uncapped
(diagnostic: separates budget limits from mechanism limits). There is also a diagnostic
full depth8 read of every v10 row to measure detector recall. That read is not a runtime cost.

## Pre-registered criteria (train + development)

PASS needs all of:
- native16 endpoint-mask rows reduced by >= 40% in aggregate;
- no session gains masks;
- the same row count as v10 in every session;
- weak count >= v10 in every session;
- extra nodes < 40% of v10 leaf nodes in every session.

Reported, not gated: full-path failures, worst CP, utility/soft utility, weak posterior,
reach, length, changed rows/anchors, risk/unverified flags.

KILL (stop this direction) if either holds:
- depth8 recall of native16 own-decision failures is < 60%;
- the v11 mask reduction is < 20%.

FAIL without kill: inspect which criterion failed, then decide once. No threshold sweep.
