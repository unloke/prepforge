# Candidate reasons: which one is the main reason?

Each line of a `batch-NN.jsonl` file is one graded chess move (inaccuracy / mistake / blunder) with
the position before it (`fen`, `side_to_move` plays), the engine's line after the played move
(`played_line`), its best line (`best_line`), the evaluation loss in centipawns, and one or more
candidate Coach cards. Each candidate states one reason, written by a rule-based Coach whose facts
are computed from these two lines. Candidate order is random.

The reader is a ~2000-rated player who wants one short, correct reason they can follow on the board,
and prefers no reason over a vague, incidental or misleading one.

Check the board with python-chess (`pip install chess` if needed) and the given lines. For each
candidate decide:
- `correct`: everything it states is true in the given position and lines (moves, pieces, squares,
  counts), and it claims nothing stronger than the lines show.
- `main`: it is a fair main reason why the played move is worse than the best move: the thing a
  strong coach would say first. A true but incidental detail, a consequence that both moves share,
  or a fact that misses what actually decides the line is not main.
Then for the card:
- `best`: the `k` of the single best candidate to show, or null when none is both correct and a fair
  main reason (the card should stay without a reason).
- `confidence`: "high", "medium" or "low".
- `key`: one short sentence with what you think the real reason is.

Write `out/batch-NN.jsonl` (same NN), one line per card, in order:
{"n": <n>, "candidates": [{"k": 0, "correct": true, "main": false}, ...], "best": <k or null>,
 "confidence": "...", "key": "..."}
