# Concept router and the Coach: findings 2026-10-12

Labels: 29,850 GameKnot comments, 58 concepts (research/concept-labels). Coach reads: the 860
coach-prod-v2 positions. Nothing here changes production Coach.

## 1. Reranking proven points: little value

`candidates.mjs` lists every point the Coach could prove for a position; `pick.py` lets the
router choose among them.

- 387 of 860 positions have fewer than two proven candidates in different kept concepts, so there
  is nothing to rerank.
- Only 19 positions would change their point (swaps.jsonl), and about half of those changes read
  worse.

The router is not useful as a direct ranker over the current detectors. The limit is the
detector set, not the ranking.

## 2. What the engine-free Coach can say (coverage.json)

`coverage.mjs` runs `describeMove` and `motifPhrase` on each labelled move and asks how often
they name a concept the comment mentions. Engine-line reasons (material won, defends, reply
and cost lines) need engine reads, so for defense and winning_material this is only a floor.

Recall where a detector exists: threat 0.44, development 0.41, centre 0.29, castling 0.27, pin
0.16, open file 0.11, fork 0.10, passed pawn 0.10, mate threat 0.09, trades 0.07. The other 45
concepts are never named.

## 3. Reason-attribution errors

### Not a production bug: PV trades credited to a quiet move

In the rerank study, "a3 gives a knight for a bishop" credited a trade that happens six plies
into the PV to the current quiet move. The error was in the research enumerator:
`candidates.mjs` adds `tradePhrase` for quiet moves. Production does not:

- `goodPoint` uses `own`/`tradePhrase` only when the move itself captures;
- `replyTrade` only describes a capturing reply.

None of the 860 production reads (after.jsonl) credits a trade to a quiet move. Rule for future
tooling: a reason belongs to the current move only if the current move or the immediate reply
carries it, never a later PV ply.

### Production bug: the king as the front piece of a "pin"

`web-src/coach/tactics.js` `detectPinsSkewers` treats an attacked king with a piece behind it as
a pin, which produces "pins the king to the pawn/knight". That is a check plus an X-ray (a skewer
at most), never a pin.

- Affected reads: 4 of 860 (ne1TIdVV/27, yZwB2tve/37, tpAQVFdP/65, ne1TIdVV/26).
- Repro: Rh7+ in `4r3/1p2qpk1/p1p5/5Q2/1P1p2P1/P1P1P3/3P1PP1/RN2K2R w KQ - 0 26`.
- Handle separately (task chip "Fix king-as-pinned-piece").

## 4. Move-aware probe vs after-only (probe-move/RESULTS.json)

`move-mlp` adds, to the after-move Maia activations, the before-move activations, their
difference and 143 move features. Same split, same MLP, game-grouped paired bootstrap.

| router | test macro AUC | val macro AUC |
|---|---|---|
| maia-mlp (after only) | 0.725 | 0.720 |
| move-mlp | 0.722 | 0.720 |
| rich-mlp (board rules) | 0.659 | 0.665 |

- Overall there is no gain. Move minus after-only, macro: −0.007…+0.002.
- Per output, 8 of 45 are significantly better and 5 significantly worse.
  - Better: castling +0.03…+0.07, pawn_structure, king_safety, defense, material_advantage,
    trades, development. These are concepts about what the move does.
  - Worse: weak_pawn, space, fork, threat, promotion.
- Validation picks move-mlp by 0.0006, which is a tie. The value of the move inputs is in a few
  move-type concepts, not in the router as a whole.

## 5. Next detectors (PRIORITY.md)

Reliable means kept on validation and test AUC 0.75 or higher.

Concepts the Coach cannot say at all, which Maia identifies reliably:

| concept | AUC | lift | note |
|---|---|---|---|
| king_activity | 0.92 | 11.9 | Strongest. Endgame king centralisation or approach; a simple board rule. |
| draw | 0.77 | 5.4 | A verdict, not a detector; belongs to the eval and summary layer. |
| piece_coordination | 0.75 | 3.8 | AP 0.06, too vague to act on. |

Near-reliable: pawn_break 0.78 (too few validation positives to keep), material_advantage 0.75,
sacrifice 0.74, endgame 0.74. Below 0.70 (weak_square, space, initiative, counterplay,
pressure) Maia offers no reliable signal; that is not worth a detector yet.

Existing detectors with low recall where Maia sees the concept well:

| concept | recall | AUC |
|---|---|---|
| promotion | 0.05 | 0.92 |
| mate_threat | 0.09 | 0.87 |
| passed_pawn | 0.10 | 0.82 |
| fork | 0.10 | 0.77 |
| open_file | 0.11 | 0.76 |

Comments name these as plans and threats, while the detectors fire only on the move that
executes them. Widening these to "threatens or prepares" is the other half of the next batch.

Order: king_activity, pawn_break, then widening promotion/passed pawn and mate threat, then
sacrifice. The router is evidence of what is learnable, not a runtime component (no ONNX).

## 6. Spatial probe: is pooling the bottleneck? (probe-spatial/RESULTS.json)

`spatial_job.py` reads Maia's 64 square tokens (layers 5 and last, 1024 dims) through one
transformer layer and one attention query per concept, instead of mean/max pooling them. Same
labels, split and bootstrap.

| router | test macro AUC |
|---|---|
| spatial (after the move) | 0.717 |
| spatial-move (adds after-minus-before tokens and a move token) | 0.704 |
| pooled maia-mlp, retrained in the same run with the same recipe | 0.705 |
| pooled maia-mlp from probe v1 (its own recipe) | 0.725 |

- Against the same-recipe pooled baseline, spatial is better: +0.007…+0.018, with 14 outputs
  better and 2 worse. The gains are on weak_square (+0.06), piece_coordination, pawn_structure,
  blunder, material_advantage and defense.
- It does not beat the best pooled router: 0.717 against 0.725.
- Pin, the concept spatial reading should help most, got worse (0.69 against 0.76 pooled).
  king_activity also dropped.
- Adding the move again does not help (−0.018…−0.008 against spatial).

Conclusion: pooling costs a little on square-bound concepts, but it is not the main ceiling.
With 30k comment labels at about 77% agreement, the labels are. The next step should not depend
on these labels: engine-grounded targets (Stockfish 11 eval-term deltas), and concepts
discovered from Maia itself (sparse autoencoder) named by those targets and the comments.
