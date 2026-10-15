# "Leaves X undefended, and R hits it": precision check

Each line of `items.jsonl` is one Coach card: "<played> leaves the <piece> on <square> undefended,
and <reply> hits it. <best> was the move." The fact: the man had a guard before the played move
and none after it; the opponent's reply moves a man that newly attacks it; the mover's next move
in the line moves it, guards it again or removes the attacker; after the best move the man is
still guarded. Each item has the position (`fen`; the side to move plays the graded move), the
played line, the engine's best line and the Coach text.

Check every item against the board with python-chess (`pip install chess` if needed). Verify:

1. `facts`: every part of the fact above holds; the quoted moves are the line's.
2. `reason`: as a strong player, is this lost tempo a fair main reason for why the played move is
   worse than the best move? If not, say in the note what the real reason is.

Write `out/check.jsonl`, one line per item, in order:
`{"i": <index>, "facts": true/false, "reason": true/false, "note": "<one sentence>"}`.
