# Bishop-pair fact precision check

Each line of `items.jsonl` is one Coach card where the new bishop-pair fact is the reason. It has
the position (`fen`; the side to move plays the graded move), the played line, the engine's best
line and the Coach text. The fact says that, in the quoted line, a knight takes a bishop and is
taken back, and the side whose knight took keeps both its bishops while the other side has fewer
("lets ... trade a knight for the bishop on X, leaving <side> the bishop pair" for the played
line; "misses Y, which trades a knight for the bishop on X ..., leaving <side> the bishop pair"
for the best line).

Check every item against the board with python-chess (`pip install chess` if needed), replaying
the full lines given. For each item verify:

1. `exchange`: in the named line a knight captures the bishop on the named square and that knight
   is captured back on the same square on the next move.
2. `pair_kept`: after that, the side named keeps two bishops and the other side has fewer, through
   the whole given line (not traded or lost later in it).
3. `other_line`: in the other line the same side does not end up with the bishop pair against fewer
   bishops.
4. `wording`: the sentence claims nothing more than the line shows, and the quoted moves are the
   line's.
5. `reason`: judging the position as a strong player, is the bishop pair a fair main reason for why
   the graded move is worse than the best move, or an incidental detail (for example the line also
   loses material, or something much bigger happens)?

Write `out/check.jsonl`, one line per item, in order:
`{"i": <index>, "exchange": true/false, "pair_kept": true/false, "other_line": true/false,
"wording": true/false, "reason": true/false, "correct": true/false, "note": "<one sentence; required when anything is false>"}`.
`correct` is true when the first four are all true; `reason` is reported separately.
