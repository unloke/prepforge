# Bishop pair with doubled pawns: precision check

Each line of `items.jsonl` is one Coach card where the bishop-pair fact is the reason and now also
says the recapture leaves doubled pawns: "... trade a knight for the bishop on X, leaving <side>
the bishop pair and <other side> doubled <file>-pawns". It has the position (`fen`; the side to
move plays the graded move), the played line, the engine's best line and the Coach text.

Check every item against the board with python-chess (`pip install chess` if needed), replaying
the full lines given. For each item verify:

1. `exchange`: in the named line a knight captures the bishop on X and a pawn captures that knight
   back on X on the next move.
2. `pair_kept`: after that, the side named keeps two bishops and the other side has fewer, through
   the whole given line.
3. `doubled`: that recapture makes the named side's pawns doubled on the named file (they were not
   before), and they are still doubled at the end of the given line.
4. `wording`: the sentence claims nothing more than the line shows, and the quoted moves are the
   line's.
5. `reason`: judging the position as a strong player, are the bishop pair and the doubled pawns
   together a fair main reason for why the graded move is worse than the best move, or incidental
   (the line also loses material, or something much bigger happens)?
6. `doubled_helps`: does mentioning the doubled pawns make the card better (true) or is it noise
   for this position (false)?

Write `out/check.jsonl`, one line per item, in order:
`{"i": <index>, "exchange": true/false, "pair_kept": true/false, "doubled": true/false,
"wording": true/false, "reason": true/false, "doubled_helps": true/false, "correct": true/false,
"note": "<one sentence; required when anything is false>"}`.
`correct` is true when the first four are all true.
