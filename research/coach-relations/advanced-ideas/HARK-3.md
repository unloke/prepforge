# Hark on R1-R3 (2026-10-15, engine-checked)

## R1 blockade (notes1 card 002, Kh2)

The card's mechanism is not a blockade: 24.Nd2 hits the undefended e4-knight, so ...d3? 25.Nxe4 is
+4.1; Nd2 stands on d2, not d3; 24.Kf1 is as good (-0.24), so the card must not say "only".
- Blockader: a defending man on a square of the passer's path (stop square first), or controlling
  the stop square so the push loses by SEE. Quality: knight > bishop (stop square of its colour) >
  king (only with at most one rook or minor each) > rook/queen (counts, but the sentence says "tied").
- Lasts >= 4 plies in the best line or to the window's end; a hand-over (Nd2 then Bd2) counts.
- Worth saying when the played line's pawn reaches relative rank >= 6 (or >= 5 with support), goes
  at least one square further than in the best line, and the swing >= 80cp.
- A one-node "cost of the push" probe settles the rest.

## R2 good square and pawn chain (user card 8, Rc1)

Statable, but not as "a good square": Rc1 takes the rook off d1, leaving the d2-bishop undefended,
so ...Nc4 comes with tempo on d2 (after Rc1 Nc4, e4? Nxd2+ is -8.3). The best line also has
17...Nc4, met by Bc1; so Nc4 itself is not the difference. A "lets the knight onto a good square"
reason needs: the jump does not work or comes without tempo after the best move but with tempo in
the played line (defender relation confirms the loose man); the tempo forces a valuable trade (Bd3
for the knight, losing the bishop pair); the recapturing pawn holds the square, protected, to the
end of the line; and the best line has no such square with tempo. "The queenside chain rolls" is
not in the PV (only ...b5): do not write it.

## R3 pawn expansion (user card 3, fxe4)

Say only the concrete part: 19.exf5? e4 forks d3 and f3 (-2.7 to -3.7); after 19.Nd2, ...f4 still
comes (-1.45); fxe4 Nxe4 gives White a permanent outpost on e4 (no black d- or f-pawn can chase
it). Do not write "the kingside gets bombarded" or "cannot be stopped". A computable form,
tension_release: the played move is a pawn capture that releases tension; afterwards an enemy piece
takes a square no pawn of ours can attack (the outpost detector) and holds it to the line's end;
the best line keeps the tension and really advances >= 2 times inside the window; a one-node probe
shows the obvious capture of the advance runs into a known motif. A space count is support only.

## Priority

First allows/prevents with a one-node cost probe (try the opponent's push or capture in the best
line's position and see whether it loses material or hits a known motif); then blockade; space last.
