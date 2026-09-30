# Scout route plausibility: real-game candidate study

Sparse-data follow-up: [PR #74 support classification](scout-sparse-plausibility-followup.md) supersedes the original interpretation of 1/1 as 100% evidence. The original candidate study below is retained for comparison.

This study uses public Lichess games parsed by the production Scout fetcher. It compares **candidate-stage** rules before Stockfish or Maia. It does not claim an improvement in final win rate. Each profile is the latest `n` games before a fixed 50-game chronological holdout. `EricRosen` has 1,187 parsed games (1,000-game profile available); `DrNykterstein` has 606 (largest profile: 300). Reproduce with `scripts/scout-fetch-games.mjs` and `scripts/scout-plausibility-study.mjs`.

The production path is observed game opening routes → trie statistics and empirical struggle prior → route gate → at most 300 ranked branches per colour → distinct leaf FENs to Stockfish depth 8 → Maia pool of at most 12 global routes. The old gate multiplied opponent conditional probabilities to a 2% floor and examined only the first 16 plies. It ignored our own moves correctly, but a sequence of individually plausible decisions could fail solely because it was long. Moves after ply 16 were not checked. `offModal` is diagnostic only and already has no positive ranking weight.

Definitions compared: old 16-ply product at 2%; full-route product at 2%; minimum opponent conditional share at 10%; 20th percentile opponent share at 10%; and geometric mean (depth-normalized log probability) at 10%. All retain only observed routes. `Very low` means a selected route includes any opponent choice below 10%; `absurd` means below 2%. Held-out hit is the fraction of observed opponent decisions matched when the route prefix occurs in the later games; it is conditional and should not be interpreted as full-route frequency.

| Player | Games | Rule | Eligible routes | Very low / absurd in top 24 | Held-out decision hit | Median top-24 plies | Distinct Stockfish leaf FENs | Maia cap |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| EricRosen | 20 | old / minimum | 20 / 20 | 0 / 0 → 0 / 0 | .558 → .558 | 22 → 22 | 20 → 20 | 12 |
| EricRosen | 50 | old / minimum | 50 / 46 | 3 / 0 → 0 / 0 | .478 → .555 | 22 → 22 | 50 → 46 | 12 |
| EricRosen | 100 | old / minimum | 100 / 95 | 4 / 0 → 0 / 0 | .404 → .502 | 24 → 24 | 99 → 94 | 12 |
| EricRosen | 300 | old / minimum | 290 / 278 | 0 / 0 → 0 / 0 | .546 → .546 | 23 → 23 | 279 → 267 | 12 |
| EricRosen | 1000 | old / minimum | 923 / 892 | 1 / 0 → 0 / 0 | .537 → .543 | 22 → 22 | 596 → 596 | 12 |
| DrNykterstein | 20 | old / minimum | 20 / 18 | 2 / 0 → 0 / 0 | .237 → .261 | 23 → 24 | 20 → 18 | 12 |
| DrNykterstein | 50 | old / minimum | 50 / 41 | 3 / 0 → 0 / 0 | .151 → .219 | 26 → 24 | 50 → 41 | 12 |
| DrNykterstein | 100 | old / minimum | 97 / 79 | 11 / 0 → 0 / 0 | .256 → .226 | 27 → 25 | 97 → 79 | 12 |
| DrNykterstein | 300 | old / minimum | 263 / 257 | 2 / 0 → 0 / 0 | .167 → .145 | 24 → 24 | 259 → 253 | 12 |

The other low-cost definitions are weaker for this purpose. At 1,000 EricRosen games, full product admits one very-low top route (hit .537); lower percentile and geometric mean each admit seven (six absurd), with hits .487. At 300 DrNykterstein games, lower percentile and geometric mean each admit 14 very-low routes (four absurd), compared with zero under minimum. Full product still has intrinsic depth bias: six 50% opponent choices yield 1.56%, below its 2% gate. Minimum remains 50% regardless of how many such choices occur. The held-out rate varies by sample; minimum falls from .256 to .226 for DrNykterstein at 100, so the evidence supports plausibility filtering rather than a universal predictive gain.

The new rule gates a route when **any** opponent decision on its complete observed opening path is below 10%. A single whole-route game can still qualify if the opponent's choices at its positions were plausible. It neither penalizes our own replies nor rewards rarity. Production now stores all observed opening plies in the live trie, while compact display helpers retain their 16-ply default. No node-level Maia calls were added. The detailed [case trace](scout-plausibility-case-trace.json) records the position FEN, UCI move, parent and move game counts, conditional probability, and gate result at every opponent decision for selected and rejected EricRosen and DrNykterstein routes. For example, the rejected EricRosen line starts `1.Nf3 h6`: at the position after `1.Nf3`, `...h6` appeared in 1 of 37 games (2.7%); the old gate let that line through.

The Stockfish counts above are distinct leaf FENs after the existing candidate ceiling, not engine timing or evaluated results. Maia remains globally capped at 12. The benchmark computes conditional counts from the same observed game routes and trie routines used by production; it does not fetch new lines or generate legal alternatives.
