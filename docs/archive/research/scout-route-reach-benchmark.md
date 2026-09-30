# Scout route reach check

This is a **candidate-stage diagnostic**, before Stockfish and Maia. It does not establish that the final game plan wins more games. Both versions use the same parsed public Lichess games, chronological order, and the same 50 held-out games per player. For each profile size, the script selects the latest `n` games before that holdout, ranks up to 12 routes per color, and measures their empirical opponent-only reach. The conditional hit counts opponent decisions where a selected route's prefix appeared in held-out games; one game can contribute multiple decisions.

The before run used Scout at `56a41e3`. The after run removes the `offModal` reward and rare-line pass, then gates routes below 2% opponent-only reach. Whole-route `n=1` remains eligible when its opponent decisions are plausible.

| Player | Profile games | Median reach before → after | Top-24 below 2% before → after | Held-out decision hit before → after |
| --- | ---: | ---: | ---: | ---: |
| EricRosen | 20 | .571 → .571 | 0 → 0 | .558 → .558 |
| EricRosen | 50 | .438 → .438 | 0 → 0 | .498 → .498 |
| EricRosen | 100 | .500 → .357 | 0 → 0 | .390 → .419 |
| EricRosen | 300 | .473 → .487 | 3 → 0 | .460 → .546 |
| EricRosen | 1000 | .262 → .523 | 7 → 0 | .450 → .551 |
| DrNykterstein | 20 | .200 → .200 | 0 → 0 | .237 → .237 |
| DrNykterstein | 50 | .154 → .125 | 0 → 0 | .162 → .173 |
| DrNykterstein | 100 | .067 → .067 | 0 → 0 | .242 → .242 |
| DrNykterstein | 300 | .019 → .244 | 13 → 0 | .152 → .167 |

EricRosen yielded 1,187 parsed games from a 1,200-game request, enough for a 1,000-game profile and 50 held-out games. DrNykterstein yielded 606 parsed games from a 1,000-game request, so there is no 1,000-game row for that player. At 50 games the DrNykterstein hit rate fell slightly; these small samples should not be read as a universal improvement. The change primarily removes implausible paths from the expensive candidate pool.

Reproduce with the repository's public-game fetcher and candidate benchmark:

```powershell
node scripts/scout-fetch-games.mjs EricRosen 1200 tmp/scout-ericrosen-1200.json
node scripts/scout-fetch-games.mjs DrNykterstein 1000 tmp/scout-drnykterstein-1000.json
node scripts/scout-route-reach-benchmark.mjs tmp/scout-ericrosen-1200.json
node scripts/scout-route-reach-benchmark.mjs tmp/scout-drnykterstein-1000.json
```
