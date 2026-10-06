# Scout production ranking

Updated 2026-10-02. Scoring version **10**; Module B identity remains `scout-v2`.

Production shows twelve observed opening lines per colour (fewer only when the
games hold fewer distinct branches). Every row is a real game's line played to the end of the
opening; no row is a truncated prefix. Weak spots lead; the remaining slots are
filled with the opponent's likeliest other lines. "No reachable weak spots in
these games" appears only when no line qualifies at all.

## Anchors

A line's evidence is its **anchor**: the deepest prefix ending on an opponent
move with raw `n >= 3` and `n_eff >= 2`. The rest of the line is the observed
continuation and is not charged as depth. `routeSupportGames`, `routeWdl`,
`routeScorePct` and `selectionWdl` describe the anchor; `exactGames` counts games
that played the whole line, `pathGames` the games behind each move. A line with
no supported anchor has support 0 and is never planned.

## Evidence and utility

The colour/speed-filtered cohort excludes early-resignation collapses. Each
full prefix carries raw W/D/L, raw support `n`, and selection-weighted W/D/L.
Weights have a 90-day half-life anchored at the newest eligible game. Undated
games have weight one. Streaming display tries are rebuilt for selection when
their anchor or depth differs; a fixed-strength prior requires normalized counts.
The baseline uses exactly the same cohort and weights.

With weighted counts `x`, the baseline-centred Dirichlet prior has strength 8.
Cohort W/D/L proportions receive 0.001 smoothing per component. Let
`alpha = x + 8q`, `A = sum(alpha)`, and `b` be the weighted cohort score:

```
mu = (alphaW + 0.5 alphaD) / A
sigma² = ((alphaW + 0.25 alphaD) / A - mu²) / (A + 1)
H = max(0, b - mu - 0.5 sigma)
U = R H (1 + 0.2 E) / (1 + 0.03 max(0, ceil(plies / 2) - 4))
```

A weak spot requires anchor `n >= 3`, effective support
`n_eff = sum(weights)² / sum(weights²) >= 2`, and positive utility. There is no
weighted-support floor. The uncertainty deduction is a ranking parameter,
not a significance test.

`R` multiplies weighted child/parent support only at opponent decisions;
our chosen moves multiply by one. Require whole-route `R >= 0.10` and the
existing weakest-choice Jeffreys estimate >= 0.10. Maia never changes reach,
support or the posterior. Raw reach, Wilson frequency and decision coverage
remain diagnostics; coverage earns no selection reward.

## Pipeline and caches

1. Exact observed opponent-terminal opening lines supply the candidate pool,
   each annotated with its anchor (`annotateRouteEvidence`).
2. Cheap utility ranks eligible candidates for at most 300 Stockfish candidates
   per colour. Depth 8 and three workers remain. Require a usable reply; reject
   opponent-favouring mates and user CP below -75 (the only engine gate). `E` is one for a user mate,
   `max(cp,0)/(100+max(cp,0))` for CP reads, and 0.1 when unavailable.
3. Rows never share a canonical terminal FEN (four fields, without counters).
   Counter-only transpositions also reuse engine reads under their existing cache keys.
4. Selection (`selectPreparationRoutes`): anchors in utility order, one row each,
   shown by the most common observed line through the anchor (more games behind
   the first differing move). A weak anchor is shown by a line whose own
   evidence is also weak. An anchor already covered by a picked line is skipped,
   so a family of nested branches is one row. Then further lines by utility,
   stubs under eight plies last. Every pass keeps the same rule: a row parts from
   every picked line no later than its own anchor, so a slot stays empty rather
   than repeat a branch past its anchor.
   Once weak spots run out, `softValue = R (1 + (b - mu - 0.5 sigma) / b)`
   orders the fill: likely lines first, tilted toward weaker results.
5. Maia supplies optional WDL to prospective picks and bounded backups: global
   64 attempts/pool and 12 successful reads per colour. It earns no utility bonus.
   Engine-unavailable fallback uses the same evidence, gates and selection.
6. Derived branch/prefilter scopes use scoring version 10. Maia attempt scopes
   also include scoring version and game-ID hash. Successful engine FEN/depth
   and Maia FEN/rating read keys remain unchanged.

`selectionBaseline` supplies the weighted cohort.
`routeReach` remains the weakest-choice diagnostic;
`preparationEvidence.conditionalReach` is whole-route weighted reach.
`preparationEvidence` also exposes raw/shrunk scores, uncertainty, effective
support, weakness and utility. Report sample sizes and summary confidence use
anchor support; Maia results are identified separately.

## Verification and comparison

`scout-preparation-value.test.js` pins anchor-first ordering, fill order,
alternatives and stub handling. Scout regression tests retain legality, evidence transport, cancellation,
cache and empty-plan UI coverage, and add posterior, recency and transposition cases.

Run `node scripts/scout-route-ranking-benchmark.mjs`. It reads the pinned
Eric Rosen games and Stockfish cache offline, prints Markdown plus JSON, and
writes only when given `--out path`. Frozen v9 candidate generation, queue math,
engine gates and selector live in `research/scout*-v9.js`, imported only by this
benchmark. End-to-end and fallback measure the full ranking pipeline; same-pool
compares selectors using a common cached assessed pool. Each version receives
five warmups and thirty timed runs; diagnostics are excluded from timing.
Missing NEW cache reads make end-to-end inconclusive. There is no engine refresh.

Both versions are judged on the same anchor evidence. The acceptance targets
are a full slate of twelve, rows of at least eight plies, no fewer weak picks
than OLD, a five-point lower mean shrunk score, reach >= 10% with median >= half
OLD's, zero anchor support below three, no nested or duplicate rows, median
runtime <= 125% and p95 <= 150% of OLD. Results on one
in-sample corpus do not establish predictive quality; chronological held-out
validation is required before making that claim.

## Path guard prototype (on by default for testing; `?scoutPathGuard=0` shows v10)

v10 gates only the leaf. The prototype (`web-src/scout-path-guard.js`, from
`research/scout-v11`) also checks every position after a preparing-side move in a
shown line, with the same rule (CP < -75 or an adverse mate). Each line is read deepest
first with one `ucinewgame`: a depth-6 screen, confirmed at depth 8 when it is within
50cp of the floor. Unsafe after the anchor: the next most common continuation (<= 3).
Unsafe at or before it: the anchor is dropped (<= 4 per colour) while enough weak
anchors remain. Extra nodes are capped at 450,000 per colour (30% of 300 x 5,000).
When the budget runs out, v10's own rows stay and are marked `unverified`; a confirmed
unsafe row with no replacement stays and is marked `risk` (shown as `!`). Row count and
weak count are never below v10's.

Each colour's pass runs right after its Stockfish prefilter and before its lines are
published, on the input a render would select from. The first engine-ranked plan shown
is therefore the guarded one. Rows new to a re-ranked plan fade in.
Each render replays the recorded verdict trace without engine reads. If the input
changes, the replay falls back to cached position verdicts and the pass runs again (at most three times).
The research verdict was FAIL (-34.5% masked rows, against a 40% target); this default is for testing, not a release decision.

The former `?scoutV13=1` experimental runtime was retired; its code lives under `research/lib/`, unrelated to scoring
version 10. Its existing shared research dependencies and legacy v12 vocabulary
module retain their previous status. Historical `archive/` material does not
constrain current production ranking.
