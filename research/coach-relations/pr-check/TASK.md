# Promotion fact precision check

Each line of `items.jsonl` is one Coach card where the new promotion fact is the reason. It has
the position (`fen`; the side to move plays the graded move), the played line, the engine's best
line and the Coach text. The fact says that in the named line a pawn that was already passed at
the start promotes (the quoted moves are that pawn's moves, or its first and last), its side is
still at least 3 points of material up on the starting balance at the end of the given line, and
in the other line that does not happen.

Check every item against the board with python-chess (`pip install chess` if needed), replaying
the full lines given. For each item verify:

1. `pawn`: the named pawn (named by its file at the start) was a passed pawn in the starting
   position, and the quoted moves are that pawn's moves in the line, ending with its promotion.
2. `gain`: the promoting side is at least 3 points up on the starting material balance at the
   end of the given line (the promoted piece was not simply traded back for nothing).
3. `other_line`: in the other line that side does not get a pawn through with such a gain.
4. `wording`: the sentence claims nothing more than the line shows.
5. `reason`: judging as a strong player, is the pawn getting through a fair main reason why the
   graded move is worse than the best move, or incidental to something else (a mating attack, a
   piece won by another tactic)?

Write `out/check.jsonl`, one line per item, in order:
`{"i": <index>, "pawn": true/false, "gain": true/false, "other_line": true/false,
"wording": true/false, "reason": true/false, "correct": true/false, "note": "<one sentence; required when anything is false>"}`.
`correct` is true when the first four are all true; `reason` is reported separately.
