# Qualitative facet calibration

The target is preparation in the stored moves, separately from chess strength,
prose quality, popularity and learning difficulty. [Frozen judgments](facet-judgments.json)
contain 225 subjective facet ratings plus 45 independent overall judgments for
38 saved studies / 45 color scopes. Every facet has its own move-content rationale.
The ratings were committed at `c3554909` before feature extraction and fitting.
They were not calculated from the old metrics or from the candidate features.

The reviewer is a single Codex instance previously exposed to production outputs.
Scores were hidden while reviewing the [move packets](facet-review-packets.json),
but this is not a blind expert assessment. Packets show all chapters' initial
mainline excerpts and sampled forks, repeated choices and early frontiers, not
every variation. Confidence is medium, roughly ±10 points; mixed opening tours
are particularly ambiguous as functional repertoires. Likes and annotations
were not inspected as label inputs. No subagents or runtime LLM were used.

## Failure → revision → remaining problem

1. **Replies was nearly always 95–100.** An answered node is not evidence of
   handling the opponent's plan. Fit supported breadth
   and route/deployment adequacy. A move list can still contain answers without
   establishing useful preparation; mixed demonstrations remain overestimated.
2. **Counts accumulated unrelated stubs.** The first fit improved individual
   scales, but overall held-out MAE worsened from 10.6 to 13.4. Counting unique
   decisions and ordinary answered alternatives could not distinguish short
   opening choosers from conditional preparation. Reject that overall formula.
3. **A lone reply inflated breadth.** Follow up each alternative for at most six
   plies in the distance-increasing graph. Support is zero for only one own move,
   half for two, full for three; stable opening completion or winning terminal
   positions also establish support. Remove the strongest alternative before
   summing extra supported choices. Both aggregate breadth and mean per-route
   supported branching inform Reach. This is an evidence convention, not author
   intent or empirical opponent frequency. A short explanatory refutation can
   still be indistinguishable from an unfinished recommendation.
4. **A single long game dominated depth; uniform cutoffs penalized completed
   setups.** Retain core survival with the existing stable `gamePhase` boundary,
   and add deployment at distinct core endpoints, including bound endpoints.
   Deployment measures departure of original minor-piece home squares (75%) and
   the king leaving e1/e8 (25%). These are structural signals: captured original
   minors and an exposed moved king can fool them. They are not positional safety
   analysis. Adding pawn-reuse to Depth worsened held-out MAE, so reject it.
5. **An empty repeated-choice intersection gave intentional systems zero.**
   Retain intersection only as one observation alongside early alternative-choice
   burden and staged pawn-setup concentration. Choices that share a reachable
   position within three further plies have no alternative burden. Distinct
   systems describe choice load; Consistency never reduces Preparation. A local
   empty chapter endpoint is not a contradictory reply. No repetition evidence
   assumes no observed contradiction, not proof of strategic coherence.
6. **Exact own-piece placement was too restrictive for Ease.** Compare two-action
   plans under matching own pawn structure, developed-minor count, material,
   king locations and castling rights, with opponent pawns differing by at most
   one relocation. Checks are excluded. This permits different move orders to
   reuse an action plan. Fit that overlap together with quiet-action share and
   choice burden. One-step action concentration and pawn/action concentration
   alternatives failed to improve family validation. London still scores too
   low and Dragon too high: quietness cannot establish tactical simplicity.
7. **A smaller mean error hid a wrong inspected ranking.** A three-feature total
   using per-route branching reached about 9.4 MAE but still put Stafford traps
   above the broader defensive investigation. Use the smaller two-feature total:
   aggregate supported breadth plus geometric route/deployment adequacy. It
   improves both aggregate ranking and that inspected pair, with only a small
   overall MAE improvement. Do not claim a major quality breakthrough.
8. **Black opening choosers still appeared too consistent.** Replacing staged
   pawn reuse with post-move full deployment concentration reduced the worst
   chooser error slightly, but worsened the matched-row Consistency MAE from
   about 10.1 to 10.2. Reject the extra feature. A power-law total also worsened
   overall family-held-out MAE to 11.2 and ranking to 83.2%; reject it. Mixed
   teaching demonstrations remain a known failure, not a solved intent detector.
9. **Per-facet damage exposed availability's denominator problem again.** The
   first fitted Replies rose by 1.01 points when truncating bbxmDYZV/black: an
   unanswered frontier disappeared. Remove availability from the fit entirely.
   Supported continuations and adequacy give lower held-out error (11.7 → 11.2)
   and better pair ordering (81.4% → 84.6%) with fewer features. Replies and
   Preparation now use the same two observations, with separately fitted weights
   from their distinct qualitative targets. Do not claim they are independent
   measurements of unrelated abilities.

## Fit and verification

[Validation](facet-validation.md) includes all five human targets, fitted values,
family-held-out predictions and the largest remaining errors for every side.
[JSON](facet-fit-results.json) includes exact coefficients and every fold model.
Fits have nonnegative slopes, fixed ridge 0.05, and at most four observations per
metric. Preparation, Replies, Reach and Depth have zero intercepts; profile
facets may have intercepts. Predictions are clipped to 0–100. Preparation is
fitted independently, not inferred by rating difficult repertoires as bad.

Nine opening-family groups were fixed with the labels. Both colors of a study
stay together. Feature selection did inspect validation outcomes; these are
development estimates, not nested or external validation. No source IDs, titles,
roles, stars or notes are features. Mixed studies overlap named families, so
group separation is incomplete. A second human rater and new sources are needed
to establish generalization beyond this corpus.

Reproduce from the repository root, using the project Python environment with
python-chess installed:

```powershell
.venv313/Scripts/python.exe -m pip install -r research/atlas-quality/requirements-fit.txt
.venv313/Scripts/python.exe -X utf8 research/atlas-quality/prepare-facet-review.py
node research/atlas-quality/extract-facet-features.mjs
.venv313/Scripts/python.exe -X utf8 research/atlas-quality/fit-facets.py --write-model
node research/atlas-quality/evaluate-preparation.mjs
node research/atlas-quality/calibrate-preparation.mjs
node research/atlas-quality/write-ranking-report.mjs
```

The extractor defaults to freshly converted, hash-checked PGNs. A local converter
stream path can accelerate exploratory runs. `facet-baseline.json` freezes the
previous shipped values at `bab295f5`; it must not be replaced by current outputs.
Fitting asserts the frozen judgment hash. No fit occurs in the application;
`web-src/atlas-calibration.js` contains only six tiny coefficient tables.

The five-axis layout stays intact. Tooltips describe the new estimates; the old
raw numerator/denominator is no longer appended as if it explained a fitted
score. Empty input remains unmeasured. Ease without comparable positions stays
unmeasured. Structural and fitted regressions cover legal identity, phase and
bound completion, intentional alternatives, copies, notes and missing replies.

On the final corpus run, truncation and missing-reply mutations raised none of
Preparation, Replies, Reach or Depth in any of the 45 reports. Consistency and
Ease frequently rise after deleting difficult choices; that is expected for
learning-load profiles and is why they do not contribute to Preparation.
Copying complete trees, copying/reordering raw chapters, and replacing every
annotation with empty text or `1` left all analytical values unchanged. All 270
fitted values match the generated coefficients and fresh-PGN corpus outputs.
The 97 targeted JavaScript regressions, build and lint checks passed (repository
lint has preexisting warnings). Desktop/laptop/mobile Build smoke passed for
writable and shared views. The same populated Atlas fixture has no console
errors or horizontal overflow at 1440/1000/390 pixels. A final Chromium worker
sample processed 2,000 real nodes in 169.5 ms with 16 main-thread heartbeat ticks;
this is a measurement, not a latency guarantee.
