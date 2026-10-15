# Describing advanced chess ideas without an LLM

PrepForge's Coach explains a graded move (inaccuracy / mistake / blunder) in one or two English
sentences. It must run on the user's own computer in the browser, free, so:

- **No LLM at runtime.** Earlier experiments: no model around 1B parameters could do the job, and a
  paid API is not affordable for a free service. Templates, rules and small non-LLM computations
  only (a tiny learned scorer is possible if it is cheap in the browser).
- **Engine data available per move:** Stockfish 19 lite (WASM), analysed at depth 12/16, single PV:
  the best line before the move (with its score) and the line after the played move (with its
  score), full PVs (median ~16 plies). Extra searches at Coach time must be rare and cheap.
- **Offline compute is fine** (Kaggle CPU/T4 GPU): mining patterns from many games, calibrating
  thresholds, building phrase tables, precomputing anything that ships as data.
- Current Coach: rule detectors compared between the best and played lines (settled material,
  mate, forks, a lost defender, passed pawn, doubled/isolated pawn, hole, outpost, chased piece,
  lost castling, trades). It beats the current production Coach in blind A/B, but on about a third
  of error cards it has no reason, and its blind judge marks ~34% "missed the key point".
- User taste (the target reader, ~2000 level): one reason per card, short; no "the evaluation
  changed" sentences (Analyze already shows the score); no side remarks that are not the reason
  (worse than saying nothing); a claim must be followable on the board; better to stay bare than
  to be vague or wrong.

## The cards

`cards.jsonl` has the 10 no-reason cards the user annotated (FEN, both lines with scores, the
current Coach text, and the user's reason in Chinese). The user calls these "really advanced".
In short (translation):

1. Bd3 (mistake): after ...f5 and ...Nc6 the white queen is forced back home; Na5 stops ...Nc6
   (nothing stops ...f5) and also hits b7. Prophylaxis plus tempo.
2. Kh2 (mistake, endgame): wastes a tempo, stops guarding f2, and the king ends up too far to stop
   the passed d-pawn.
3. fxe4 (mistake): ...g5 is a kingside expansion White cannot stop (g5 exf5 e4 forks; if White
   prepares with Nd2, ...f4 still comes), and White's king side gets bombarded.
4. Re8 (blunder, rook ending): wastes a move, and coming back wastes another, so Black's king is too
   late; Kf4 uses the tempo correctly. Stable explanation: Re8 lets the pawn promote.
5. Nf6 (inaccuracy): king safety and structure trade-off: the best line's structure is messy but
   has no fixed backward pawn and the exposed king cannot be attacked; the game line is a bit
   worse on both.
6. Kf1 (mistake): lets ...Nxh2+ take a bishop for a knight; the bishop is worth more.
7. h3 (blunder): engine horizon issue (the real best continuation is deeper); at most "h3 makes the
   opponent's pieces more active than the best line".
8. Rc1 (inaccuracy): lets ...Nc4 take a good square; after Bxc4 dxc4 the pawn gets a good square
   too and the queenside pawn chain will roll forward.
9. Kg4 (inaccuracy, endgame): ...h4 is hard to take, breaks White's structure, and sets up many
   tactical threats (Bd2 fork, Be1 hitting f2, Rc1+ and Rd1); a piece that should be easily won
   suddenly becomes useful.
10. Qc7 (blunder): ...Na6 hits the queen; after Qxb7 Nb4 wins c2 back so Black loses nothing, and
    the queen is much less mobile, with rooks hitting it on the way back.

## The question

How can a program, with no LLM, describe ideas like these in one short, correct, followable
sentence, from two single-PV engine lines and the positions? Specifically:

1. Which of these ideas can be stated reliably, and from what computable evidence? (For example:
   counting tempi a piece loses in the line; the square of a passed pawn and king distance;
   bishop-for-knight; pawn levers and the files they open; mobility of the worst piece; king-zone
   attackers.) What makes each one stable rather than an artefact of one PV?
2. For the trade-off cards (3, 5, 9), is there any non-LLM way to say something true and useful,
   such as decomposing the score gap into classical evaluation terms (Stockfish-11-style
   mobility, king safety, pawn structure, passed pawns, threats) between the two lines' end
   positions and naming the dominant term? Would that read as a reason or as noise?
3. What can offline mining (Kaggle, millions of positions) add that runs cheaply at Coach time:
   phrase tables keyed by pattern, learned thresholds, a tiny scorer choosing among candidate
   reasons, anything else?
4. Which cards should honestly stay bare (no reason), and how should the Coach decide that?

Give concrete definitions where you can (what is computed, on which plies of which line, with
which threshold), and the sentence each would produce on the matching card above.
