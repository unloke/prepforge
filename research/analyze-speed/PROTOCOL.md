# Analyze speed study: protocol (frozen before the first Kaggle run)

## Question

Can the whole-game Analyze pass get cheaper without worse move grades? Today the
browser runs every position at depth 16 (1.5M-node cap) on 4 single-thread Stockfish
workers. Those workers pull positions forward from one shared queue, so neighbouring
plies land on different workers and a worker's hash rarely holds the next position's tree.

## Arms (same 48 games, same engine, 4 workers)

| arm | change |
| --- | --- |
| `baseline` | production order (forward, shared queue), Hash 16 |
| `baselineRepeat` | `baseline` again: run-to-run noise floor |
| `backChunks` | fishnet-style: 8-ply blocks from the end, each read backwards |
| `backQuarters` | four static quarters, each backwards |
| `backChunksHash64` | `backChunks` with Hash 64 |
| `tiered1` / `tiered3` | depth 12 everywhere (`backChunks`), then depth 16 for both positions of any move whose shallow win-chance loss is ≥ 1 / ≥ 3 points or that shows a mate, re-read on the worker that searched it shallow |
| `reference20` | depth 20 (6M-node cap), Hash 64: the grades' truth |

- **Engine:** Stockfish 19 lite single-thread from the pinned npm package, the same net and search as the browser build.
- **Games:** rated Lichess games of 40–100 plies from `datasnaek/chess`, sampled by a hash of the game id.
- **Arm order:** rotated per game.

## Grades

A move is graded the way the server does it:
- `best` when it is the engine's first choice.
- Otherwise by win-chance loss: ≤2 excellent, ≤5 good, ≤10 inaccuracy, ≤15 mistake, else blunder.

Each arm is scored against `reference20` on four measures:
- exact tier match;
- agreement on "is an error" (inaccuracy or worse);
- major disagreements: two or more tiers apart, involving an error tier;
- agreement on Brilliant eligibility (best or excellent).

## Decision (fixed in advance)

**Baseline's accuracy** means `baseline` scored against `reference20`. **Noise** means `baselineRepeat` scored against `baseline`.

- **An ordering or hash arm** (`backChunks*`, `backQuarters`) ships if both hold:
  - total wall ≤ 0.90 × baseline;
  - accuracy versus `reference20` is no worse than baseline's: exact tier match within 1.0 point, major disagreements within 0.2 points, error agreement within 0.5 points.
- **A tiered arm** ships if both hold:
  - total wall ≤ 0.75 × baseline;
  - the same accuracy bounds as above.

  It also needs the saved-analysis depth metadata handled. Positions left at depth 12 must not mark the analysis `partial-shallow`.
- **If no arm passes,** production keeps its current order.

Wall time on Kaggle CPUs is a proxy for the browser. Nodes are reported too, because
node savings carry across machines better than wall time does.
