# Which candidate reason would this reader show?

Each line of a `batch-NN.jsonl` file is one graded chess move (inaccuracy / mistake / blunder): the
position before it (`fen`, `side_to_move` plays), the engine's line after the played move
(`played_line`), its best line (`best_line`), the evaluation loss in centipawns, and one or more
candidate Coach cards. Each candidate states one reason, written by a rule-based Coach whose facts
are computed from these two lines. Candidate order is random; two candidates can have the same text.

The reader is an advanced club player (about 2000) reviewing their own game in an analysis view
that already shows the engine score, the evaluation graph and both engine lines. The card's only
job is a reason a human can follow on the board. A card without a reason still says "X was the
move", so choosing no candidate is a normal outcome, not an empty card.

Check the board with python-chess (`import chess`; `pip install chess` if needed): replay the lines,
list attacks, count material. There is no engine beyond the given lines; do not install or run one.

## What this reader wants

1. **Correct.** Every claim holds on the board: moves, pieces, squares, counts, threats. A false or
   misleading claim is the worst fault.
2. **The point.** It names what a strong coach would say first about why the played move is worse
   than the best move.
3. **Short and followable.** Concrete beats vague; short beats long when they say the same.

Specifically:

- **The score is not a reason.** "Is not the best move", "comes out a pawn better" or any restated
  evaluation gives nothing the screen does not already show. A candidate whose only content is that
  is not main.
- **A true remark that is not the point is worse than nothing.** "Allows g4, which attacks the pawn
  on f5" when the real issue is something else teaches the wrong lesson: not main.
- **Material claims must be followable.** Which piece or pawn falls and how. A gain that rests on
  an unnatural sequence (material given up and not taken back, quiet moves a human would not find)
  with no word on the mechanism is not main. Gambit-like gains of a pawn in the best line are too
  abstract to claim.
- **A followable material count is enough.** A correct win or loss of material the reader can see
  on the board is a main reason; do not also demand the strategic purpose. A short, natural line
  that shows which pawn or piece falls ("misses Re1, which wins a pawn (8.Re1 Qxg5 9.Bxd5 Be7
  10.Rxe5)") is followable.
- **Half the story is not the reason.** When the decisive point has two parts that belong together
  (material lost and the mate threat or king exposure that forces it; a pawn lost and the king
  losing castling in the same sequence), a candidate that tells only one part and leaves out the
  other is not main. Choose none rather than half.
- **A reply that attacks something is a side remark** ("allows Nxc4, which attacks the bishop on
  d6") unless that attack wins or forces something. The real reason may be positional (helping the
  opponent develop with tempo, damaging one's own pawn structure); when no candidate says it, choose
  none.
- **Name the tactic.** When two candidates give the same material, the one that says what wins it
  (a fork, a pin, a hanging piece) is better than a bare count.
- **Counts must not stop at the edge of the line.** If the line ends on a capture that can simply
  be taken back, or the count only holds because the line stops there, the claim is not correct.
- **Name the plan correctly.** A piece driven back by a standard pawn advance (h3 and g4 against a
  pinning bishop) is not "losing time". Structural endgame reasons (making or stopping a passed
  pawn, pawn majorities, isolated pawns) are main when they decide the comparison; a passed pawn
  that does not decide it is a side remark.
- **One reason, no padding.** A mechanism sentence followed by a long quoted line, or a clause that
  adds no new understanding, makes a candidate worse. Of two candidates with the same substance,
  prefer the shorter.
- **Same substance, same value.** Do not choose on wording ("hangs" or "loses") or a square name.

## For each card

For each candidate decide:
- `correct`: everything it states is true in the given position and lines, and it claims nothing
  stronger than the lines show.
- `main`: it is a fair main reason in the sense above.
Then for the card:
- `best`: the `k` of the single candidate this reader would show, or null when none is both correct
  and main (the card stays without a reason).
- `confidence`: "high", "medium" or "low".
- `key`: one short English sentence with what you think the real reason is.

Write `out/batch-NN.jsonl` (same NN), one line per card, in order:
{"n": <n>, "candidates": [{"k": 0, "correct": true, "main": false}, ...], "best": <k or null>,
 "confidence": "...", "key": "..."}

Judge every card in the batch. Write only to `out/`, and write files with Python (not through a
PowerShell command line) so non-ASCII text is not mangled.
