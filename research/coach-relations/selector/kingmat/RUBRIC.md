# Material and king safety: one part, or both?

Each line of a `batch-NN.jsonl` file is one graded chess move (inaccuracy / mistake / blunder) from a
real game: the position before it (`fen`, `side_to_move` plays), the engine's line after the played
move (`played_line`) and its best line (`best_line`), both in SAN from that position, and the loss
in centipawns. `candidates` are cards a rule-based Coach can write for this move, each with one
reason, in random order. In every card some material changes hands in one of the lines and, in the
same line, there is a mate threat or a king that loses the right to castle.

The reader is an advanced club player (about 2000) reviewing their own game in an analysis view that
already shows the engine score and both lines. Check everything on the board with python-chess
(`import chess`; `pip install chess` if needed): replay the lines, list attacks and threats, count
material. There is no engine beyond the given lines; do not install or run one.

## What this reader wants

- **Correct.** Moves, pieces, squares, counts and threats hold on the board. A false or misleading
  claim is the worst fault.
- **Sound chess.** The reason is why the played move is worse than the best move, as a strong coach
  would say it first.
- **Short and concrete.** Name the piece or pawn that falls and how; no evaluation talk ("comes out
  better" says nothing the screen does not show), no side remarks, no second reason.
- **A correct but incomplete reason is better than no reason.** A wrong, misleading or irrelevant
  reason is worse than none.

## For each card

- For each candidate: `correct` (everything it states is true and it claims nothing stronger than
  the lines show) and `ok` (acceptable to show: correct, not misleading, not irrelevant; incomplete
  is fine).
- `relation`, how the material and the king-safety part relate in this line:
  - `causal`: one is how the other happens. A mate threat (or check) forces a reply that drops the
    material; material cannot be taken back because the recapture walks into mate; a capture comes
    with check and costs the king its castling.
  - `both`: two separate consequences of the same sequence, each worth a word.
  - `material`: the material is the point; the king part is incidental.
  - `king`: the king part is the point (an attack, a mate threat that wins by itself, a king stuck in
    the centre); the material is incidental or only a by-product.
  - `neither`: the real reason is something else.
- `needs_both`: true when a single candidate would leave out what makes the reason understandable:
  the reader would ask "why can't I just take back / defend?" or "how is that winning?". False when
  one part already gives a fair main reason.
- `best`: the `k` of the candidate this reader would show, or null when none is ok.
- `ideal`: one short sentence in the Coach's voice ("<move> loses ... / misses <best>, which ...")
  with the reason this reader wants, using only moves from the given lines. Name the mate square or
  the castling loss only when it matters.
- `note`: one short sentence on what you found.

Write `out/batch-NN.jsonl` (same NN), one line per card, in order:
{"n": <n>, "candidates": [{"k": 0, "correct": true, "ok": true}, ...], "relation": "causal",
 "needs_both": true, "best": 0, "ideal": "...", "note": "..."}

Judge every card in the batch. Write only to `out/`, and write files with Python (not through a
PowerShell command line) so text is not mangled.
