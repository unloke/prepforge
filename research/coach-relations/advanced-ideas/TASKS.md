# Work to hand out (2026-10-15)

freebuff: strong, local access, one unstoppable hour per run, so it gets one package that fills
the hour, ordered so the most useful part lands first. Hark: strong, no local access, no time
limit, so it gets chess-judgement questions with the boards and lines pasted in.

## freebuff: one-hour package (paste the block below)

```
Repository: D:\auto_art\PrepForge Chess, folder research/coach-relations. It is a rule-based chess
Coach that writes one short English reason for a graded move from two single-PV Stockfish lines
(best, played). No LLM at runtime. Read advanced-ideas/PLAN.md, positional.py and explain.py first.
Rules: no legacy code or compatibility shims; keep code small; do not edit explain.py,
positional.py, pick.py or enumerate.py (write new files only, under research/coach-relations/selector/);
do not commit; do not touch research/coach-ab-review. Engine reads are cached: use make_ab.py's
--reads setup (artifacts/benchmarks/coach-relations-20261014/prod-depth/out plus the
explain-*/*/explain/sf_cache-*.jsonl caches); never start a fresh engine search over the pool.
Work in this order and write findings to selector/FINDINGS.md as you go, so a partial run is useful.

1. Label table (selector/labels.py -> selector/labels.jsonl). One row per judged Coach candidate:
   sol board checks (guard-check, bp-check, qc-check, pr-check, kl-check and their r1/r2 folders:
   out/check.jsonl joined to items.jsonl by index), sol A/B verdicts (ab*/run-output/judge/out/
   *.jsonl with ab*/run-output/BLIND-KEY.json) and the user's reviews (ab*/human-review/
   HUMAN-REVIEW.json; verdict A/B mapped through BLIND-KEY). Columns: card id, fact type, line
   (played/best), first ply, loss in cp, grade, whether the other line shares the fact, labels
   (correct, main reason, won/lost, missed_key_point, user note). Report counts per fact type.

2. Development tempo. The user's notes often give "development speed" as the reason (ab12
   pair-002 and pair-011). Define a count from one line over its first 8 plies: minor pieces
   leaving the back rank, castling, moves made with tempo (newly attacking a more valuable piece)
   versus moves spent retreating or moving the queen twice. Compute the gap between the two lines
   on every error card in the pool. Report the distribution, then 20 examples with gap >= 2 tempi
   (FEN, both lines, the counts) and say for each whether development is plausibly the main
   reason. Conclude: usable as a fact sentence, only as a selector feature, or not at all.

3. queen_chased with no net tempo. positional.queen_chases counts a chase even when the chasing
   piece must go back or is lost (qc-check r2 item 18). In a copy under selector/, add the check
   that each chaser stays on its square for two more plies or is traded evenly, rerun over the
   pool's triggers and list which ones drop, with a one-line judgement each.

4. If time remains: a first sparse logistic selector on labels.jsonl (features from step 1 plus
   the development gap), leave-one-round-out accuracy, and the threshold that keeps main-reason
   precision >= 90%. Weights as JSON.
```

## Hark (paste one question at a time; each has what it needs)

H1. Bishop trade and king safety. FEN `r1bq1rk1/pp2bppp/4p3/2npP3/3B1PQ1/2N5/PPP3PP/2KR1B1R w - - 5 12`.
    Played 12.Bd3 Bd7 13.Kb1 Nxd3 14.Rxd3 f5 15.Qg3 Rf7 16.Qf2 b6 17.h3 Qe8 (+0.34).
    Best 12.h4 Qa5 13.Kb1 f5 14.Qh3 b5 15.g4 Bd7 16.Rg1 b4 17.gxf5 Rxf5 (+1.02).
    The user's reason: beyond the bishop pair, Bd3 lets Black play ...f5 safely; before, f5 exf6
    could not be met by the pawn and the bishop recapture was missing; once the knight takes d3 the
    bishop can take back on f6 and Black's king is safe. What board facts would let a program say
    this (which recapture becomes available, which pawn break), and what one-sentence wording would
    a coach use? A second card with the same theme: FEN
    `r1bqk2r/2ppbppp/p2n4/np2N3/8/1B6/PP3PPP/RNBQ1RK1 b kq - 1 12`, played 12...Bb7 13.Bc2 O-O
    14.Nc3 Bf6 15.Qd3 g6 16.Ng4 (-2.30), best 12...Nxb3 13.Qxb3 O-O 14.Nc3 Bb7 15.Nd5 Re8 (-3.48);
    the user: the knight should take the bishop for king safety too. Is there a shared rule?

H2. Development as the reason. FEN `rn2kbnr/ppp1q1pp/4bp2/8/2N1Q3/3B4/PPPP1PPP/RNB1K2R b KQkq - 2 7`,
    played 7...Bxc4 8.Qxe7+ Nxe7 9.Bxc4 Nd7 10.d4 c5 11.Nc3 Nc6 12.dxc5 Bxc5 13.Ne4 (+2.01),
    best 7...f5 8.Qe2 Nc6 9.O-O Nd4 10.Qd1 O-O-O 11.c3 Nc6 (+0.26). Second: FEN
    `rnbq1rk1/p3bppp/1pp5/3p4/4n3/4PQ2/PPPPBPPP/RNB1K1NR b KQ - 5 11`, played 11...Qd6 12.d3 Nf6
    13.Qg3 Qd8 14.f4 Re8 15.Nf3 (+0.34), best 11...Ng5 12.Qf4 Ne6 13.Qf3 Nd7 14.b3 Bf6 15.d4 (-0.80).
    The user's reason for both: development speed. For a ~2000 reader, when is "lets the opponent
    develop with tempo" the main reason rather than a side note? Propose counts a program can make
    on the two lines (tempi, pieces developed, queen moves) with thresholds, and the sentence for
    each card.

H3. Consolidation. FEN `8/p1n1k1r1/3R1p2/8/1Pq1P3/P4KPP/5P2/2BR4 b - - 0 37`, played
    37...Qb3+ 38.R1d3 Qa4 39.Be3 Ne6 40.h4 Qb5 41.R6d5 Qc4 42.Rd1 Rg8 43.Rc1 (-0.87), best
    37...Nb5 38.Rd7+ Ke6 39.Rxg7 Qb3+ 40.Be3 Qxd1+ 41.Kg2 Qd3 42.Bc5 Qxe4+ (-2.96). The user: the
    doubled rooks make White too solid to beat. Is there a concrete, checkable way to say "lets the
    opponent consolidate" (pieces coordinated, no loose targets), or should such cards stay bare?

H4. A failed detector, for the record. "The played king move walks away from an enemy passed
    pawn and the pawn advances at once" was correct on 9/9 cards but the main reason on only 2/9
    (sol: the real reasons were a missed blockade, a missed rook activation, a tempo race).
    Is there a narrower condition (pure pawn endings, square rule, no blockader available) where
    it is reliably the reason, or should the idea be dropped?
