# Sol's review after the two fixes (36 cards, one pass)

Muse (Muse Spark 1.3, the fallback while Sol had no quota) judged all 188 A/B cards of `../ab`:
new 172, old 15, both bad 1; acceptable new 180, old 177. Its first batch 06 (all threats "false")
came from mimo-v2.6-flash on a misrouted config, whose script tested `is_checkmate()` after a null
move (the passing side mated, never true); quarantined in `../ab/bad/mimo/`, rerun on Muse: 24 new.

Fixes, in `explain.py`:
- A threat made by the winning capture itself counts only when the loser could otherwise take back
  (Muse, 81 such cards: acceptable with a retake 50 vs 46 old; without one 23 vs 26 old). 21 pool
  cards go back to the material-only text.
- The material quote runs until the stated count stands after the reply, and quotes the reply when
  it takes elsewhere (the "for a pawn" was left past the quote, n=122/154). 1078 pool cards change.

Sol on this batch (sealed set excluded):
- disputed A/B cards still carrying a threat: 11; new better 9, old 2 (8dRrl55X/41, fXXRphIf/51:
  the line does not act on the threat; Muse agrees on both). Acceptable new 9, old 11.
- 25 random quote changes: new better 22, old 1, both bad 2 (the count itself is off: a later
  recapture outside the line's count, pre-existing). Acceptable new 23, old 23.

## The user's blind check (5 cards, human/)

Built by `human/make.py` from the review set's texts. Two quote cards: tie, tie. Three
material + mate threat cards: new better 3 of 3. On fXXRphIf/51 both texts missed the point: after
Rhe2 White has mate in 8, which the screen depth (12, +874) does not see; at depth 24 Stockfish lite
finds #8.
