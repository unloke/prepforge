# Two Coach cards for one move

Each line of a `batch-NN.jsonl` file is one graded chess move (inaccuracy / mistake / blunder) from a
real game: the position before it (`fen`, `side_to_move` plays), the engine's line after the played
move (`played_line`) and its best line (`best_line`), both in SAN from that position, and the loss
in centipawns. `A` and `B` are two versions of the Coach's card for this move, from two versions of
a rule-based program, in random order.

The reader is an advanced club player (about 2000) reviewing their own game in an analysis view that
already shows the engine score and both lines. Check everything on the board with python-chess
(`import chess`; `pip install chess` if needed): replay the lines, list attacks and threats (what
would mate if the other side passed), count material. There is no engine beyond the given lines; do
not install or run one.

## What this reader wants

- **Correct.** Moves, pieces, squares, counts and threats hold on the board. A false or misleading
  claim is the worst fault. A mate threat must be real at the move named, and must matter: one the
  other side simply ignores, or one that has nothing to do with the material, misleads.
- **Sound chess.** The reason is why the played move is worse than the best move, as a strong coach
  would say it first. When material falls because of a mate threat (the defence costs the man, or
  taking back walks into mate), saying both is the point; saying only one half is incomplete.
- **Short and concrete.** Name what falls and how; no evaluation talk, no side remarks, no second
  reason. Of two texts with the same substance, the shorter is better.
- **A correct but incomplete reason is better than no reason.** A wrong, misleading or irrelevant
  reason is worse than none ("X was the move" alone).

## For each card

- `verdict`: "A", "B", "tie" (equally good, or the same substance), or "both_bad" (neither is
  acceptable).
- `ok`: for each of A and B, true when it is acceptable to show (correct, not misleading, not
  irrelevant; incomplete is fine).
- `note`: one short sentence on what decided it.

Write `out/batch-NN.jsonl` (same NN), one line per card, in order:
{"n": <n>, "verdict": "A"|"B"|"tie"|"both_bad", "ok": {"A": true, "B": false}, "note": "..."}

Judge every card in the batch. Write only to `out/`, and write files with Python (not through a
PowerShell command line) so text is not mangled.
