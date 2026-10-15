# Plan after sol (SOL.md) and Hark (chat, 2026-10-15)

Constraint: no LLM; rules, typed templates and small tables/scorers that run in the browser.
Kaggle does the offline work (mining, branch checks, thresholds, the selector's weights).

## Where they agree

- Cards 7 and 9 stay bare. A true but incidental fact (card 9's doubled pawns after gxh4) is not
  the reason.
- Classical evaluation terms (SF11-style mobility, king safety, structure) may select or rank a
  candidate but never become the sentence; a candidate must land on a concrete instance (which
  piece, square, move). Endpoint comparisons are confounded by different trades along the lines.
- The reasons that work are move-sequence relations, stated with the pieces, squares and moves
  that establish them, no stronger than one PV shows ("allows", not "forces").
- Offline: thresholds and a small linear selector trained on correct / main-reason labels, with
  abstention; templates with typed slots validated against the board.

## Rejected

- Hark's "另外還有局面因素" filler and "兩步都可以" for small losses: the user's rule is bare over
  vague.

## Build order (each: colour-flip check, sol board check of 20 triggers >= 19, then a targeted A/B;
## the user's 10 notes1 cards are development examples, not a test)

1. bishop_pair (card 6): within four plies an enemy knight takes the mover's bishop and is taken
   back; the opponent keeps two bishops, the mover has fewer; the best line saves that bishop and
   does not trade the pair off. "Kf1 lets ...Nxh2+ trade a knight for your bishop, leaving Black
   the bishop pair."
2. queen_chased (cards 1, 10): the same queen is attacked by a cheaper man and retreats without
   capture or check twice within eight plies, ending on its first rank, or (card 10) after a pawn
   grab it has at most two destinations not immediately capturable and the pawn is recovered by
   the same attacker. "Bd3 allows ...f5 and ...Nc6-d4 to chase your queen home."
3. promotion_allowed (card 4): the played move takes a piece off a passed pawn's file or
   promotion square, the pawn promotes in the played line and the promoted piece survives the
   capture tail, and the best line keeps the guard. "Re8 leaves the h-file: h7, Rg8 and h8=R."
4. allows / prevents (Hark D1, general): the opponent's first non-forced reply in the played line
   starts a verified motif; in the best line's position the same reply is illegal, loses material
   (SEE) or no longer attacks/checks. Board computation only.
5. Later: pawn wedge with tempo (card 5), pawn recapture with tempo and a supporting chain (card
   8), pawn-storm plan (card 3). Narrow, need hard negatives.

Then the selector: features per candidate (type, first ply, persistence, shared with other line,
explained share of the score gap), labels from sol (correct? main reason?) and the user, sparse
logistic weights shipped as JSON, threshold set for high precision; below it the card is bare.
