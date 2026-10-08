# Deepening router study: protocol (frozen before the first Kaggle run)

## Question

Analyze reads every position at a screen depth, then re-reads some positions at the
analysis depth (`web-src/engine/tiered-analysis.js`). Can a tiny model choose those
positions better than today's rule, so more positions stay at the screen read without
losing product-visible results?

## Production configuration (checked 2026-10-07)

| | screen | deep |
| --- | --- | --- |
| depth | Settings − 4 = **12** (default Settings 16; tiering off below 12) | **16** |
| node cap | 1,500,000 (`ANALYSIS_MAX_NODES`, both passes) | 1,500,000 |
| engine | Stockfish 19 lite, 1 thread, Hash 16 (default), MultiPV 1, up to 4 workers | same |

Today's rule (`deepFlags`) deepens both positions of every move whose screen win-chance
loss is ≥ 1 point, or where either position has a mate score.

## Data

- **Scout set (train/val).** The 295,097 positions of the scout-distill depth-16 receipts
  (Kaggle `vexylon/scout-depth16-batch07-20261003`, native Stockfish 19, depth 16, Hash 64,
  fresh per position). These are opening-phase positions only (ply 0 to about 35).
  The deep read is reused. The only new read is a lite depth-12 screen of every position
  (kernel `analyze-router-scout`).
- **Whole-game set (train/val/test).** 300 rated `datasnaek/chess` games of 40–100 plies,
  taken in analyze-speed hash order after that study's 48 games. Each position gets three
  reads: lite 12, lite 16, and native 16 (kernel `analyze-router-whole`).
  This is the only set that matches production on both phase (whole games) and engine (lite 16).
- **Calibration.**
  - Lite 16 on a 4,000-position hash sample of the scout set, to measure how far the
    native teacher sits from production deep.
  - A fresh native depth-12 read of 1,000 of those positions, compared with the teacher's
    own depth-12 info line.

Every read starts from `ucinewgame`. The full per-depth history (score, best move, nodes,
time) is kept, because the router may use the screen's own iteration history as features.

## Labels

A move is the unit. Its outputs are computed from the evals of `fen_before` and
`fen_after`, exactly as the server does (`classification.py`, `brilliant.py`).

Primary label **L1, product-critical**: the move's output differs between all-screen and
all-deep evals in any of these ways.
1. **Eval swing.** The White win chance of either position moves by ≥ 10 points.
2. **Mate state.** Either position gains or loses a mate score, or its mate sign flips.
3. **Grade.**
   - The visible error tier changes. The tiers are {best/excellent/good}, inaccuracy,
     mistake and blunder.
   - Or the played move's "best" status flips.
4. **Great/Brilliant could change.** The move passes the sanity gates (it is not forced
   and not a recapture of the previous move), Maia3 23M at rating 1900 gives it
   human-probability ≤ 0.35, and at least one of these holds:
   - its Brilliant eligibility flips (best, or loss ≤ 2 points);
   - it is eligible under both reads, and one of these changes:
     - the Great live gates (truth ≥ 0.25 and before ≤ 0.97);
     - the reveal gate (truth − Maia glance ≥ 0.30, checked only when human-probability ≤ 0.10);
     - the truth moves more than 0.10, which is the deep-confirmation drift that fails closed.

   This is a conservative proxy. It does not run the trap or MultiPV searches, so it
   over-counts real Great/Brilliant changes.

Secondary label **L2, strict**: L1, or any tier change, or any best-move change at
`fen_before`, or an eval swing ≥ 5 points.

Production truth = lite 12 vs lite 16 (whole-game set). On the scout set the deep side is
the native teacher; the calibration measures how much that differs from lite 16.

## Routers

All routers see only what the screen pass produces: the lite 12 read with its iteration
history, plus the board.
- **Heuristics:**
  - `tiered1`, which is production;
  - loss thresholds;
  - loss or iteration instability.
- **Models:** logistic regression, a shallow decision tree / small gradient-boosted
  trees, and a small MLP.
- **Two granularities:**
  - move-level, which deepens both positions of a flagged move, like production;
  - position-level.

## Evaluation (end-to-end simulation)

A router produces a set of positions to deepen. Final evals are deep where flagged and
screen elsewhere. The final outputs of every move are compared with the all-deep outputs.

A **false negative** is a move whose final output still differs from all-deep under L1
(or L2). This is computed through the real two-position grading, so a move counts as
missed only if the position that mattered was left shallow.

Reported per router:
- L1 and L2 recall over critical moves, and the false-negative list on test;
- the share of positions kept at screen depth;
- deep nodes saved;
- simulated wall time, using the browser pool shape (4 workers, shared forward queue,
  screen pass then deep pass) and measured per-position lite times;
- model size and browser inference cost (feature extraction plus model, in Node).

## Splits and operating points

- **Whole-game set:** split by a hash of the game id into 120 train, 60 validation and 120 test games.
- **Scout set:** split by a hash of `fen_before` into 80% train and 20% validation.
- **Thresholds:** each model's threshold is chosen on whole-game validation games for L1
  recall ≥ 99% and ≥ 99.5%, then reported once on test.
- **Bootstrap:** a 95% interval over test games.

## Decision (fixed in advance)

A router is **worth a production prototype** only if all of these hold on whole-game test games:
- L1 recall is at least `tiered1`'s L1 recall and at least 99%;
- it keeps at least 10 percentage points more positions at screen depth than `tiered1`;
- browser inference costs < 1% of the screen pass time.

Otherwise production keeps `tiered1`. Production code is not touched in this study.

## Amendment 2026-10-07 (before any results)

The user rejected training on the scout set. Its positions stop around ply 35, so a router
trained on it learns where openings need depth 16, not where whole-game Analyze spends its
reads. Filling in those games at depth 16 (about 1.5M new deep reads) is not worth it.
Changes:

- **The scout screen run is cancelled.** The scout receipts are used only for the engine
  calibration: the fresh depth-12 check and lite against native on the opening sample.
- **Two more whole-game shards.** `gamesA` covers hash-order games 348–1347 and `gamesB`
  covers 1348–2347. Each position gets lite 12 and lite 16 only, which together with the
  first 300 games makes about 2,300 games.
- **All training, validation and test use whole games.**
  - Split by game hash: 60% train, 15% validation, 25% test.
  - Recall targets and the decision rule are unchanged.
  - Native 16 stays on the first 300 games, for the noise-floor comparison only.
- **A learning curve is added.** Models are trained on 25%, 50% and 100% of the training
  games, which shows whether more data would still help.

## Amendment 2 (2026-10-07, after base rates only, before any router result)

The first 300 games show that the label is mostly engine noise:
- **Core changes, depth 12 → 16:** the screen read changes the product output (excluding
  Great/Brilliant) on 23% of moves.
- **Noise floor:** lite 16 and native 16, at the same depth, disagree on 22% of moves.
- **Fresh depth 12 vs the depth-12 info line:** identical on 17,550 of 17,551 positions.

A **robust recall** is reported beside the frozen metrics. A robust change is a core
change where the screen differs from both lite 16 and native 16, and those two agree with
each other. It covers 15% of moves.

- **Scope:** computed on test games that have native reads (the first 300).
- **What is unchanged:** the decision rule still uses L1 against lite 16. Robust recall
  shows whether a router's misses are real changes or noise.

## Amendment 3 (2026-10-07, user decision, before any router result)

The router is the classifier layer between the depth-12 screen and the depth-16 pass. Its
label and features must not depend on Maia.

- **No Maia anywhere.** The Maia-gated Great/Brilliant part of L1 is removed.
- **The training label and the decision rule use core:** eval swing ≥ 10, mate state, error
  group, best status. In `RESULTS.json`, `recall1` is now core recall. Thresholds are chosen on
  validation core recall ≥ 99% and ≥ 99.5%.
- **Great/Brilliant is reported as a check, never a label.** `recallGB` counts moves whose
  Brilliant eligibility, Great live gates or truth drift > 0.10 differ between the screen and
  the deep read, without Maia. It over-counts real changes. The reveal gate needs Maia's glance
  and is left out. If the check shows a router losing Brilliant candidates, the fix is a
  Maia-free rule outside the router (for example, always deepen moves that are eligible under
  the screen read), not Maia in the label.
- Strict (L2) and robust recall are unchanged, apart from dropping Great/Brilliant.

## Amendment 4 (2026-10-07, before any router result)

The training job no longer attaches the scout teacher receipts. They served only two
opening-position calibrations that belonged to the dropped scout training plan: a fresh native
depth-12 read against the receipts' depth-12 info line, and lite against native on an opening
sample. The whole-game calibration (fresh lite 12 against the lite 16 info line, and the
lite/native comparison on the first 300 games) is kept.

## Result of the frozen rule (train kernel v3, 2026-10-07)

The frozen rule fails. At ≥ 99% validation core recall, every model keeps only 4–8% of
positions at screen depth. That costs 6–10% more than reading everything at depth 16,
because the screen pass is wasted. tiered1 reaches 76% core recall with 24% shallow.

The main cause is label noise. Lite 16 and native 16 disagree on 22% of moves, and of
tiered1's misses, 79% are best-status flips.

On the test curve (read post hoc, so not a result), GBT at 90% core recall keeps 27% shallow
at wall 0.88×, with the Great/Brilliant check at 0.83 ≈ tiered1. That point is the
hypothesis tested below.

## Amendment 5 (2026-10-07, user decision): frozen threshold, fresh holdout

Question: does the GBT router at a fixed 90% core-recall threshold beat tiered1 on games
that played no part in any choice so far?

- **Model.** `gbt [100% train]` from the train kernel's `models.json`, unchanged. No refit.
- **Features.** `features.mjs` now counts captures and checks from plain SAN instead of
  verbose move objects. The values are identical (0 differences over 17,667 positions); the
  speedup is about 8× locally.
- **Threshold (kernel `analyze-router-freeze`).**
  - Rebuild the same split as the train kernel. Assert 1,335 train / 334 validation /
    556 test games.
  - Take the highest threshold whose validation core recall is ≥ 90%, using the same
    simulation as before.
  - Check that the Python scorer matches `predict.mjs` (max |diff| < 1e-9).
  - Write `frozen.json`: threshold, model sha, `features.mjs` and `predict.mjs` shas, and
    the dev game ids and move-sequence hashes.
  - It is written before any holdout read exists. The threshold value and shas are copied
    here before the evaluation runs.
- **Holdout (kernels `analyze-router-holdA`, `analyze-router-holdB`).**
  - 1,000 fresh datasnaek games in analyze-speed hash order, offsets 2348–3347, read at
    lite 12 and lite 16, as production does.
  - Games whose id or move sequence appears in the dev set are dropped.
  - The fixed engine runner is used; no refill.
- **Evaluation (kernel `analyze-router-holdout`), run once.** The frozen router and tiered1
  on the same holdout games. Each difference (router − tiered1) gets a 95% paired bootstrap
  over games (2,000 resamples).
- **Decision (all four must hold, or production keeps tiered1):**
  1. **Core recall:** the lower CI bound of the difference is > 0.
  2. **Wall time:** the router's simulated wall time vs all-deep is ≤ tiered1's (point
     estimate).
  3. **Great/Brilliant check:** the lower CI bound of the difference is ≥ −1 point.
  4. **Browser cost:** features plus one model call, measured on the same machine as a fresh
     single-worker lite-12 screen read, is < 1% of that read.
- **Also reported, not decisive:**
  - recall without best-status flips (`recallNoBest`), since that is the noisiest part of
    the label;
  - strict recall, shallow share and nodes.
- **No second look.** If the result fails, the holdout is spent. A new idea needs new games.

### Frozen values (freeze kernel, before any holdout read)

- threshold `0.4661505423488886` (validation core recall 0.9008)
- model sha `9c1558ab0079b38f6dd5727800c7883d9906f324f27b1fd843d662762288333f`, identical to the train kernel's `gbt [100% train]`
- `features.mjs` sha `f999b300b8baf89fe48b569ad0a2b7d41638c2d0b18e1dafc843a283350e802c`
- `predict.mjs` sha `8c78345f586c14e130c797f31e159398886ccc9b6fa44eca630dbe47fc868226`
- Python/JS parity: max |diff| 2.2e-16. The split matched (1,335 / 334 / 556). There are 2,225 dev games.

## Fresh holdout result (amendment 5, run once, 2026-10-08)

Kernel `vexylon/analyze-router-holdout-20261007`: 959 complete fresh games (61,879 moves), none seen in development. Frozen threshold, model, features and predict shas verified.

| | Router | tiered1 | Diff, 95% CI (game bootstrap) |
|---|---|---|---|
| Core recall | 0.901 | 0.757 | +0.143 [+0.131, +0.156] |
| Core recall without best-move flips | 0.936 | 0.898 | +0.039 [+0.023, +0.054] |
| Great/Brilliant check | 0.830 | 0.832 | −0.002 [−0.016, +0.011] |
| Wall time vs all-deep | 0.876 | 0.887 | −0.011 [−0.020, −0.001] |

Browser cost: features 418 µs + model 2.6 µs per position against a 75 ms single-worker lite-12 read (0.56%); model 38.5 KB.

Decision: rules 1, 2 and 4 pass; rule 3 fails (Great/Brilliant CI lower bound −0.016 < −0.01). Under the frozen rule the router does not ship.

## Amendment 6: round 2 (written 2026-10-08, before any round 2 result)

The amendment 5 holdout failed only rule 3 (Great/Brilliant). holdA/holdB have been read once, so
they become development data; they are never used as a holdout again.

**Development** (`round2.py dev`, kernel `analyze-router-round2-20261007`): whole + gamesA + gamesB +
holdA + holdB, new hash split `router2:` 60/15/25. Features and `predict.mjs` are unchanged. Labels per
move: core (as before) and the Maia-free Great/Brilliant flip (screen vs lite 16). Candidates, all
HistGradientBoosting, small (60 iters, depth 3) or big (200, depth 4, lr 0.05):

- `v1`: round 1 recipe (core model, validation core recall ≥ 0.90), reference only;
- `<core|joint>-<size>+guard`: one model trained on core or core∪GB; highest threshold with
  validation core recall ≥ 0.85 and validation GB recall ≥ tiered1's + 0.01;
- `two-<size>`: a core model OR a GB model; for 25 GB thresholds the highest core threshold meeting the
  same guard, keeping the cheapest on validation.

Dev-test (paired game bootstrap vs tiered1, 2000 resamples) marks a candidate passing when the core
recall CI lower bound > 0, its wall ≤ tiered1's − 0.005, and the GB CI lower bound ≥ −0.01. The frozen
choice is the passing candidate with the highest GB CI lower bound (then lowest wall); none passing
means no holdout run. The script writes `frozen2.json` (rule, model shas, dev game ids and move-sequence
hashes) automatically, so no choice is made by hand.

**Holdout** (`round2.py eval`, kernel `analyze-router-holdout2-20261007`), run once: holdC..holdF,
2,000 new games from the same dataset (hash-order offsets 3348..5347), minus any game whose id or move
sequence appears in development. The decision rule is amendment 5's four rules, unchanged; rule 4
counts features plus one call per model.

Maia stays out: as a feature it costs about one more screen read per position in the browser (rule 4),
and changing the Great/Brilliant check's definition after seeing round 1 would move the goalposts.

### Round 2 development result (kernel `analyze-router-round2-20261007`, 2026-10-08)

3,184 development games (train 1,911 / validation 477 / test 796). Dev-test vs tiered1 (core 0.756,
GB 0.831, wall 0.880):

| Candidate | Core | GB | Wall | GB diff [95% CI] | Passes |
|---|---|---|---|---|---|
| v1 (reference) | 0.900 | 0.824 | 0.876 | −0.007 [−0.023, +0.009] | no (wall, GB) |
| core-small+guard | 0.903 | 0.830 | 0.881 | −0.001 [−0.017, +0.015] | no |
| core-big+guard | 0.934 | 0.845 | 0.910 | +0.014 [−0.003, +0.030] | no (wall) |
| joint-small+guard | 0.858 | 0.890 | 0.846 | +0.059 [+0.046, +0.072] | yes |
| **joint-big+guard** | 0.857 | 0.900 | 0.826 | +0.069 [+0.055, +0.082] | **yes, chosen** |
| two-small | 0.858 | 0.845 | 0.838 | +0.014 [+0.001, +0.028] | yes |
| two-big | 0.848 | 0.846 | 0.811 | +0.015 [+0.002, +0.028] | yes |

Frozen automatically: `joint-big+guard`, one HistGradientBoosting model (200 iterations, depth 4)
trained on core ∪ Great/Brilliant flips. The threshold and model sha are in `frozen2.json`. The holdout
(holdC..holdF) is read once by `round2.py eval`.

### Round 2 holdout result (kernel `analyze-router-holdout2-20261007`, run once, 2026-10-08)

1,917 complete fresh games (123,283 moves) from holdC..holdF, none seen in development. Frozen model
and code shas verified. Router `joint-big+guard` against tiered1, game bootstrap (2000):

| | Router | tiered1 | Diff [95% CI] |
|---|---|---|---|
| Core recall | 0.855 | 0.760 | +0.095 [+0.088, +0.104] |
| Core recall without best-move flips | 0.921 | 0.896 | +0.025 [+0.015, +0.035] |
| Great/Brilliant check | 0.903 | 0.835 | +0.067 [+0.060, +0.075] |
| Positions left shallow | 0.317 | 0.235 | +0.081 |
| Wall time vs all-deep | 0.831 | 0.897 | −0.066 [−0.072, −0.060] |
| Nodes vs all-deep | 0.825 | 0.870 | −0.045 [−0.051, −0.038] |

Browser cost: features 420 µs + model 12.3 µs per position against a 64 ms single-worker lite-12 read
(0.67%); model JSON 241 KB.

Decision: all four rules pass. Under the pre-registered rule the router is worth shipping.

### Production integration (2026-10-08)

`web-src/engine/deepening-router.js` ports `features.mjs`, the move features of `train.py` and the
model; `fixture.py` writes `web-src/engine/deepening-router.fixture.json` (three games, made-up screen
reads) and `deepening-router.test.js` requires the browser rows and scores to equal the research ones
exactly. The router runs at depth 16 only; other depths keep the tiered1 rule.

Training read every position from an empty hash; the browser game pass carried the hash between a
worker's positions. Kernel `analyze-router-hashbench-20261008` (`hash-bench.mjs`, 100 holdC games,
6,743 positions, four round-robin engines like the browser pool) compared the two for the depth-12
screen pass:

| | Fresh hash | Carried hash |
|---|---|---|
| Screen CPU | 1 | 0.956 |
| Screen wall | 1 | 0.877 |
| Moves flagged | 0.478 | 0.474 |
| Positions deepened | 0.671 | 0.669 |

Same flag rate, but only 85.1% of moves get the same decision, so router reads with a carried hash are
not the reads it was validated on. Production clears the hash before every screen read (`newGame`),
which costs about 4% screen CPU and up to 12% screen wall time against the old pass.
