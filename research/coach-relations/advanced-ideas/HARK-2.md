# Hark on H1-H4 (2026-10-15, checked with an engine on the boards)

## H1 minor-piece trade and king safety (ab12 pair-006/007)

The user's reason is half right. In the original position after ...f5 exf6, gxf6 is illegal (g7
pinned by Qg4), Bxf6 drops the knight (Bxc5, +3.7), but Rxf6 is playable (+1.1). So a card may
say "only the rook can take back", not "...f5 is impossible". Nc5 is defended only by Be7 and
attacked by Bd4, which ties the bishop; after 14.Rxd3 ...f5 exf6 Bxf6 works (+0.6). The best line
also plays ...f5 (Qa5 guards c5); its edge comes from g4xf5 and Rg1 opening the g-file.

Proposed rule `trade_for_king_safety`: line L trades our X for their P; in the other line L' (P
still on) within 8 plies P takes part in a king-zone event:
- E1 forces a pawn of our king shield to advance (the alternative loses material, SEE or one probe);
- E2 every safe recapture after our lever fails in L' (pinned, SEE < 0, defender relation) while
  L has at least one; "only one safe recapture" counts but the sentence must say "only";
- E3 their rook takes a half-open file in front of our king in L' and not in L.
Supporting reason next to bishop_pair; main only when the bishop pair does not explain the gap.
Template: "12.Bd3 lets Black trade off the c5-knight, which frees the e7-bishop to recapture on f6
after ...f5; with 12.h4 White keeps the pieces and later opens the g-file with g4 and Rg1."

## H2 development speed (ab12 pair-002/011)

Only the second card is development; in the first, Black's minors are all out by the end of the
played line and White's Bc1 is still home. Tempo is the main reason only when it turns into a
concrete result.
- undeveloped(c) = minors on their start squares + 1 if the king cannot castle any more;
- wasted(c) = round trips (back to the start square within 4 plies) + retreats after being hit +
  queen moves beyond the first in the first 12 plies;
- D = (their undeveloped + wasted) - (ours); swing = D(best) - D(played).
Main reason when: opening (ply <= 30), the same material count in both lines, swing >= 2, the gap
turns into a concrete event (king cannot castle, a piece has no safe square, enemy pieces enter the
king zone), and no existing detector explains more. Only the first two: side note. Else nothing.

## H3 consolidation (ab12 pair-008)

Not bare: loose pieces explain it. After 40.h4 in the played line White has no undefended piece; in
the best line after Rxg7 the d1-rook is loose and falls to ...Qb3+ and ...Qxd1+. After ...Nb5 all
three White replies are about -2.5, so it is not one PV's accident.
- loose(c) = c's non-king, non-pawn pieces with no defender; plus overloaded (a sole defender of
  two targets);
- forcing(us) = our checks and captures with SEE >= 0 at that ply;
- played line: loose(opponent) drops to 0 within 6 plies and stays 0 to the end, and the last 4
  plies have forcing(us) = 0; best line: a loose or overloaded piece >= 1 that is won inside the
  window (material or defender relation confirms it).

## H4 king away from a passed pawn

Keep only narrowed: no rooks or queens; when the defence has pieces, a BFS shows none of them can
reach a square on the pawn's path before the pawn; the square rule flips (best line inside, played
outside, counting the side to move and the double step), KPK by bitbase; the pawn advances >= 2 or
promotes in the played PV and the swing >= 200cp. Otherwise route to: blockade (best line puts a
piece on the stop square or the path, played does not), rook activity (rook behind the passer,
cutting the king off, side checks), race count (promotion steps plus king-takes-pawn steps per line).
