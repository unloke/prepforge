# King walks away from a passed pawn: precision check

Each line of `items.jsonl` is one Coach card: "<king move> takes the king away from the <file>-pawn:
<the pawn's moves>". The fact: the graded king move increases the king's distance to the queening
square of an enemy pawn that was passed before the move; in the played line that pawn steps forward
at once and is still on the board at the end of the line; in the best line it does not step forward
on the opponent's first reply. Each item has the position (`fen`; the side to move plays the graded
move), the played line, the engine's best line and the Coach text.

Check every item against the board with python-chess (`pip install chess` if needed). Verify:

1. `facts`: the passed pawn, the distance increase, the immediate advance, the pawn surviving the
   played line and the best line's first reply are all as stated; the quoted moves are the line's.
2. `reason`: judging as a strong player, is "the king walked away from this pawn" a fair main reason
   for why the graded move is worse than the best move? If not, say what the real reason is.

Write `out/check.jsonl`, one line per item, in order:
`{"i": <index>, "facts": true/false, "reason": true/false, "note": "<one sentence>"}`.
