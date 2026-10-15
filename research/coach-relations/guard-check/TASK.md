# Defender-mechanism precision check

Each line of `items.jsonl` is one Coach card where the new defender mechanism fired. It has the
position (`fen`, side to move plays the graded move), the played line, the engine's best line, and
the Coach text. The mechanism says one of:

- "X leaves <man> undefended and loses ...": the played move itself took away the last guard of
  that man, and the man is then taken in the played line;
- "...: <move> pulls <guard> away from <man>": in the quoted line, that move forces the guard to
  leave (a check it answers, a piece it captures, or an attack on it), after which the man is
  taken without a guard;
- "takes <guard>, the last guard of <man>": the capture of that guard leaves the man unguarded,
  and it is then taken.

Check every item against the board, not against how plausible the sentence sounds. Use python-chess
(`pip install chess` if needed) to replay the lines. For each item verify:

1. `guard_before`: on the board right before the named move, the named guard really attacks the
   man's square (it is a guard of that man).
2. `unguarded_after`: after the named move, no piece of that side guards the man any more, and the
   man is still unguarded when it is taken.
3. `cause`: the named move is really what removed the guard, in the way the sentence says
   (the played move itself; or a check / lure capture / attack that the guard responds to; or a
   capture of the guard).
4. `taken`: the man is actually captured later in the quoted line, and the material claim in the
   sentence (what is lost or won) is correct for the line as quoted.
5. `wording`: the sentence does not claim more than the line shows (no "must", no claim that
   every defence fails, no overload claim). Also judge whether the mechanism is the real reason
   the man falls in this line, or a side detail (for example the man was attacked twice anyway).

Write `out/check.jsonl`, one line per item, in the same order:
`{"i": <index>, "guard_before": true/false, "unguarded_after": true/false, "cause": true/false,
"taken": true/false, "wording": true/false, "correct": true/false, "note": "<one sentence, required when anything is false>"}`.
`correct` is true only when all five are true.
