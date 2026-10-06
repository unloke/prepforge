# Analyze speed study: results

**Verdict: no arm passes the frozen criteria (PROTOCOL.md). Production keeps its current order.**

## Run

- Kaggle kernel `vexylon/analyze-speed-20261006`, version 2 (run-02).
- 14 games and 924 moves within the 40-minute budget.
- Full summary in `run-02-SUMMARY.json`.

## Results

Accuracy columns compare each arm with depth 20 (`reference20`).
- **Exact:** percentage of moves graded the same tier.
- **Error:** percentage that agree on whether the move is an error (inaccuracy or worse).
- **Major:** percentage of major disagreements: two or more tiers apart, involving an error tier.

| arm | wall vs baseline | nodes vs baseline | exact % | error % | major % |
| --- | ---: | ---: | ---: | ---: | ---: |
| baseline | 1.000 | 1.000 | 72.64 | 95.38 | 0.66 |
| baselineRepeat | 0.982 | 0.994 | 70.44 | 95.60 | 0.77 |
| backChunks | 0.994 | 0.992 | 73.96 | 94.51 | 0.99 |
| backQuarters | 1.140 | 0.989 | 75.27 | 94.07 | 1.10 |
| backChunksHash64 | 1.012 | 0.967 | 74.62 | 95.38 | 0.66 |
| tiered1 | 0.784 | 0.714 | 73.85 | 95.05 | 0.88 |
| tiered3 | 0.544 | 0.496 | 70.99 | 94.40 | 2.31 |

## Findings

- **Backward ordering and a bigger hash don't help.** Fishnet-style backward ordering saves under 1% of nodes, and Hash 64 saves 3%. Wall time doesn't move: at depth 16 with a 16 MB hash, little of the previous position's search tree survives to be reused.
- **Run-to-run noise.** Two baseline runs agree on only 86% of exact tiers (0.22% major). Tier boundaries are noisy at depth 16, which bounds every accuracy comparison here.
- **tiered1** (depth 12 everywhere, depth 16 where a move loses at least 1 point or shows a mate) fails narrowly on both criteria:
  - wall time 0.784 × baseline, against a limit of 0.75;
  - major disagreements 0.88%, against a limit of 0.86%. That is about two moves out of 924, inside the baseline's own repeat spread.

  It is the only candidate for a later, larger study. It is not shipped.
- **tiered3** halves the cost but clearly loses accuracy (major disagreements 2.31%).
