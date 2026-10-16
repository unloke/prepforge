# Fork claims and card texts

Each line of a `batch-NN.jsonl` file is one graded chess move (inaccuracy / mistake / blunder) from a
real game: the position before it (`fen`, `side_to_move` plays), the engine's line after the played
move (`played_line`) and its best line (`best_line`), both in SAN from that position, and the loss
in centipawns. Then:

- `removed`: sentences a rule-based Coach used to write about a fork in one of the two lines.
- `A`, `B`: two versions of the Coach's card for this move, from two versions of the program, in
  random order; both null when the card text did not change.

The reader is an advanced club player (about 2000) reviewing their own game in an analysis view that
already shows the engine score and both lines. Check everything on the board with python-chess
(`import chess`; `pip install chess` if needed): replay the lines, list attacks, count material.
There is no engine beyond the given lines; do not install or run one.

## What this reader wants

- **Correct.** Moves, pieces, squares, counts and threats hold on the board. A false or misleading
  claim is the worst fault.
- **Sound chess.** A fork is a fork when the double attack actually costs the other side something
  in the given line: the forking side wins one of the attacked men (or more material than it gives)
  as a result. A check that attacks a rook which is never taken, or a "fork" answered by a plain
  recapture that only trades pieces, is not a fork worth naming: it misleads.
- **Short and concrete.** Names what happens; no padding.
- **The main point if possible.** A correct but incomplete reason is better than no reason. A
  wrong, misleading or irrelevant reason is worse than no reason ("X was the move" alone).
- The score is not a reason: "is not the best move" or "comes out a pawn better" alone says nothing.

## For each card

- `removed`: for each sentence, `real`: true when the fork it names really wins material in that
  line as described (so the Coach was right to say it), false when it is a trade, never pays off, or
  is otherwise wrong or misleading.
- If A and B are given:
  - `verdict`: "A", "B", "tie" (equally good, or the same substance), or "both_bad" (neither is
    acceptable: each is wrong, misleading or irrelevant);
  - `ok`: for each of A and B, true when it is acceptable to show (correct, not misleading, not
    irrelevant; incomplete is fine).
- `note`: one short sentence on what you found.

Write `out/batch-NN.jsonl` (same NN), one line per card, in order:
{"n": <n>, "removed": [{"k": 0, "real": false}, ...], "verdict": "A"|"B"|"tie"|"both_bad"|null,
 "ok": {"A": true, "B": false} or null, "note": "..."}

Judge every card in the batch. Write only to `out/`, and write files with Python (not through a
PowerShell command line) so text is not mangled.
