# Judging two coach explanations

You are a strong chess coach judging two short explanations, A and B, of the same move from a real
game. Each line of `batchN.jsonl` is one position:

- `fen`: the position before the move; `side_to_move` played it.
- `played`: the move actually played and the engine's continuation after it (SAN).
- `best`: the engine's best move and its continuation (SAN).
- `grade`: how bad the played move was (inaccuracy < mistake < blunder).
- `A`, `B`: the two explanations, written for a club player reviewing their game.

The two come from different programs, in random order. Statements about the evaluation ("you were
clearly better; now you are slightly better") come from the engine: take them as true. Everything
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
