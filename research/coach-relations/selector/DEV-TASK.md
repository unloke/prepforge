# Development tempo: can it be counted?

Folder: research/coach-relations (rule-based chess Coach; read explain.py, positional.py briefly).
Write only under selector/. Do not edit other files, do not commit. Keep code short.

The user often gives "development speed" as the reason. Hark proposed (advanced-ideas/HARK-2.md,
section H2): per line end,
- undeveloped(c) = c's knights and bishops still on their start squares + 1 if c's king has lost
  every castling right without castling;
- wasted(c) = round trips (a piece back on a square it left within 4 plies) + retreats right after
  being newly attacked by a cheaper man + queen moves beyond the first, in the first 12 plies;
- D(line) = (opponent undeveloped + wasted) - (mover undeveloped + wasted); swing = D(best) - D(played).
Main reason only when: ply <= 30 (opening), same material balance at both line ends, swing >= 2,
the gap turns into a concrete event (a king can no longer castle, a piece has no safe square, enemy
pieces enter the king zone), and no other fact is chosen.

Write `selector/dev.py` computing this over the pool's error cards (use make_ab.py's --reads setup
with artifacts/benchmarks/coach-relations-20261014/prod-depth/out and the explain-* caches; lines
are in each card's row; never start fresh engine searches over the pool). Report in `selector/DEV.md`:
- the swing distribution, and how many cards pass each condition;
- ab12 pair-011 (88cl0uaw/21, the user says development) and pair-002 (joGFmaEx/13, Hark says
  not development): their counts;
- 20 random cards passing all conditions: FEN, both lines (SAN), counts, the concrete event, and
  your own judgement on the board whether development is the main reason;
- a one-paragraph conclusion: a fact sentence (give the template), only a selector feature, or not
  usable.
