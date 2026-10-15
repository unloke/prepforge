# "The best move stops the reply": precision check

Each line of `items.jsonl` is one Coach card. Its first sentence names the opponent's gain in the
played line, starting with the opponent's reply R. The new part is the last sentence: "<best> was
the move: after it, R loses the <piece> on <square> to <capture>." The claim: if the mover had
played the best move instead, the same reply R would be legal there, and the man R moves could be
taken by the named capture with a net gain of at least 3 points (static exchange); after the
played move, R is safe. Each item has the position (`fen`; the side to move plays the graded move),
the played line, the engine's best line and the Coach text.

Check every item against the board with python-chess (`pip install chess` if needed). Verify:

1. `facts`: R is legal after the best move; the named capture is legal there and wins the man
   (no adequate recapture or counter that makes it a bad trade, judged by static exchange and a
   quick look for an immediate check/mate refutation); after the played move R is not losing.
2. `wording`: the sentence is accurate and claims nothing more (for example, if R was not the
   opponent's sensible choice after the best move anyway, the sentence is still true as stated).
3. `helps`: as a strong player, does this last clause tell the reader something useful about why
   the best move was better (it prevents the opponent's idea), or is it trivial/noise?

Write `out/check.jsonl`, one line per item, in order:
`{"i": <index>, "facts": true/false, "wording": true/false, "helps": true/false, "note": "<one sentence>"}`.
