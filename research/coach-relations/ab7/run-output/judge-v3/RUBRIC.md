# Judging two coach explanations

You are a strong chess coach judging two short explanations, A and B, of the same move from a real
game. Each line of `batchN.jsonl` is one position:

- `fen`: the position before the move; `side_to_move` played it.
- `played`: the move actually played and the engine's continuation after it (SAN).
- `best`: the engine's best move and its continuation (SAN).
- `grade`: how bad the played move was (inaccuracy < mistake < blunder).
- `A`, `B`: the two explanations, written for a club player reviewing their game.

The reader is an advanced club player looking at the game in an analysis view that already shows
the engine score, the evaluation graph and both engine lines. The explanation's only job is the
reason a human can follow.

The two come from different programs, in random order. Statements about the evaluation ("you were
clearly better; now you are slightly better") come from the engine: take them as true, but they
are already on the reader's screen and add nothing. Everything
else must be checked on the board. You may use python-chess (`import chess`) to replay the lines,
list attacks, count material and so on. There is no engine here beyond the given continuations; do
not install or run one.

## What makes an explanation better

1. **Correct.** Every claim holds on the board: the moves exist, the material counts are right,
   the threats are real. A false or misleading claim is the worst fault.
2. **Gets the point.** It names the main reason the played move is worse than the best move, as a
   coach would explain it.
3. **Useful and clear.** A club player understands what went wrong and what to do instead.
   Concrete is better than vague; short is better than long when they say the same.

Specifically:

- **No credit for the evaluation change.** Restating the score is not a reason. If it is all an
  explanation offers, mark `missed_key_point`; if it pads a real reason, it makes the text worse.
- **A true remark that is not the point is worse than saying nothing.** "It allows g4, which
  attacks the pawn on f5" when the real issue is something else gives the reader a wrong lesson.
  Mark it `missed_key_point`, and prefer a bare "X was the move" over it.
- **Material claims must be followable.** Say which piece or pawn falls and how. "Wins a pawn
  (long line)" where the gain rests on an unnatural sequence (material given up and not taken
  back, quiet moves a human would not find) with no word on the mechanism is not useful: mark
  `missed_key_point`, and `unnatural` when it confuses.
- **Name the plan correctly.** A piece driven back by a standard pawn advance (h3 and g4 against
  a pinning bishop) is not "losing time"; if the trouble is that the piece is shut in, say that.
  Structural endgame reasons (making or stopping a passed pawn, pawn majorities, isolated pawns)
  are key points when they decide the comparison.
- **One reason.** A second sentence that adds no new understanding counts against the text.
- **No reason on either side is `both_bad`.** When neither text gives a real reason (a bare "X was
  the move", the score, a reply named without why), the verdict is `both_bad`, not the shorter or
  less padded one. Identical texts are a `tie` (or `both_bad` if neither gives a reason).
- **A followable material count is a reason.** A correct win or loss of material that the reader
  can see on the board is enough; do not also demand the strategic purpose of the move.
- **Name the tactic.** Saying what wins the material (a fork, a pin, a hanging piece) beats a bare
  count of the same material.
- **Counts must not stop at the edge of the line.** If the supplied line ends on a capture that the
  other side can simply take back, or the count only holds because the line stops there, the
  material claim is unproven: mark `hallucination`.
- **Coach voice.** Plain words a coach would say ("wins a knight") are fine; extra precision
  ("for a pawn") is welcome but not required.

## Output

Append one JSON object per position, one per line, to `out/batchN.jsonl` (same N as the input):

```json
{"pair_id": "pair-001", "verdict": "A", "issues": {"A": [], "B": ["missed_key_point"]},
 "main_reason": "Bg5 drops the f7 pawn after Rxf8+ and Rc8+.", "confidence": "high",
 "why": "B names the pawn loss; A's king-cover claim is about Black's own pawn and misleads."}
```

- `verdict`: `A`, `B`, `tie` (equally good), or `both_bad` (neither is acceptable).
- `issues`: for each side, any of `factual_error` (a claim is false on the board),
  `missed_key_point` (does not say the main reason), `hallucination` (asserts something the lines
  do not support), `unnatural` (awkward or confusing wording).
- `main_reason`: one sentence, your own view of why the played move is worse.
- `confidence`: `high` when the verdict is clear, `low` when it is close or you are unsure.
- `why`: one or two sentences on the verdict.

Judge every position in the batch. Write only to `out/`.
