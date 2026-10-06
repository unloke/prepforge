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

## Run-01 result (Kaggle version 1) and run-02 amendment

Run-01: FAIL, not KILL. Masks fell from 142 to 107 (-24.6%). The uncapped diagnostic reached
74 (-47.9%) at a median of +55% nodes. Depth8 recall was 72.0% (113/157). With the 30%
cap, 394 of 713 rows were never audited. Weak count fell in 8 sessions, and 1 session gained a mask.

There were two implementation defects:
- The spare-weak check counted the same spare anchor for every rejection
  (calmzone-white went from 10 to 6 weak rows).
- When the budget ran out, rejected rows were replaced by unaudited rows. Some of those
  were masked, and this caused the session that gained a mask.

There was also one overshoot: on a tiny session (pingancheng2014-white), a single search
exceeded the cap.

Run-02 changes. Each one targets one of these failure mechanisms; no thresholds are swept.
1. A weak anchor is dropped only if the weak anchors after it can still fill v10's weak count.
   A continuation swap from v10's weak line must stay weak.
2. A row v10 would not show needs a safe verdict. v10's own rows may stand `unverified`.
   The final fill prefers v10's rows.
3. A read starts only if its predicted nodes fit the remaining budget. The prediction is
   the maximum seen at that depth; before any reads it is the session's mean leaf nodes
   (a quarter of that at depth 6).
4. Cost (the measured binding constraint): each position is screened at depth 6 and
   confirmed at depth 8 only when the screen is within 50cp of the floor or shows an
   adverse mate. The depth-8 verdict decides. This is a single fixed margin.
   The diagnostic reports the screen's recall against both depth8 and native16.

The criteria and kill rules are unchanged.

## Run-02 result and run-03 amendment (user decision 2026-10-05)

Run-02: FAIL. Masks fell from 142 to 107 (-24.6%), median worst CP went from -141 to -107,
and utility did not drop. The uncapped arm reached -45.8% at +38.6% aggregate nodes.
53 of the remaining 107 masked rows were never audited. The per-session cap starved the
low-cost third of sessions (median 85 leaf reads; masks 45 to 44). The depth-6 screen
saved only about 20% of the cost.

User decision: the 40% production limit is measured against v10's full budget, not
against each run's actual reads. Run-03 therefore uses a fixed allowance per colour of
`AUDIT_NODE_BUDGET` = 30% x 300 depth-8 reads x 5,000 nodes = 450,000 nodes.
5,000 is the median nodes per leaf read measured in run-02. With this allowance, no scan
exceeds about 1.3x v10's worst case.

The criterion `extraNodesUnder40` is now: audit nodes < 40% of v10's full queue
(300 x 5,000) in every session. The ratio against the actual v10 reads is still reported.

Weak count: run-02 still lost one weak row in one session. Run-03 puts back a v10 weak
row, marked `risk`, in place of a replacement fill whenever the final weak count falls
below v10's. The other criteria and the kill rules are unchanged.
