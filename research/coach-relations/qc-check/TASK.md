# Queen-chase fact precision check

Each line of `items.jsonl` is one Coach card where the new queen-chase fact is the reason. It has
the position (`fen`; the side to move plays the graded move), the played line, the engine's best
line and the Coach text. The fact says that in the named line the same queen is newly attacked by
a cheaper enemy man twice (the two quoted moves make those attacks), each time moves away without
capturing or checking, and ends on the square named (on its first two ranks, or where it started),
while in the other line that queen is not chased like that.

Check every item against the board with python-chess (`pip install chess` if needed), replaying
the full lines given. For each item verify:

1. `attacks`: each quoted move newly attacks that queen with a man cheaper than a queen (it was
   not attacked by a cheaper man just before), and the queen is the piece that moves next.
2. `retreats`: each time the queen moves away without capturing and without giving check, and it
   ends on the named square.
3. `other_line`: in the other line the same queen is not chased twice like that.
4. `wording`: the sentence claims nothing more than the line shows, and the quoted moves are the
   line's.
5. `reason`: judging as a strong player, is the queen losing time this way a fair main reason why
   the graded move is worse than the best move, or an incidental detail?

Write `out/check.jsonl`, one line per item, in order:
`{"i": <index>, "attacks": true/false, "retreats": true/false, "other_line": true/false,
"wording": true/false, "reason": true/false, "correct": true/false, "note": "<one sentence; required when anything is false>"}`.
`correct` is true when the first four are all true; `reason` is reported separately.
