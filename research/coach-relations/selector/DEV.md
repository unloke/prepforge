# Development tempo audit

2026-10-15. **Recommendation: use the counts only as candidate-selector features; do not add a standalone development fact.** In the seeded sample, my board judgement is **10 yes, 9 no, 1 unclear** on development being the main reason. This is an exploratory review of 20 cards from 272 mechanical matches, not a calibrated precision estimate or a fresh engine validation.

## Reproduction and definitions

Run from `research/coach-relations`:

```powershell
py -B selector/dev.py --reads ../../artifacts/benchmarks/coach-relations-20261014/prod-depth/out
py -B -m unittest discover -s selector -p test_dev.py -v
```

`dev.py` reads the same four `fresh*` card/explain files and uses the same explain-success eligibility rule as `make_ab.py --reads`. All 2,000 games begin at the standard initial position; every game prefix was replayed and checked against its card FEN. There are 131,317 move cards, 23,454 error cards, and **23,449 eligible errors**; five lack a successful stored explanation (four inaccuracies, one mistake). Reviewed/A/B cards remain in this research pool. `v5` is excluded, matching `make_ab.py`.

Both lines are the **full supplied PVs** from `explain_cards.row`: played is the played move plus `after.pv`; best is `before.pv`. No cut, extension or equal-length normalization is applied to these counts. Existing fact selection is recomputed with current `explain.py`, which applies its own horizon/tail rules. Cache precedence matches `make_ab.py`: four kernel caches, 20 sorted `explain-*/*/explain/sf_cache-*.jsonl` caches (including v5 there), then the existing research `sf_cache.jsonl`. `tactics.analyse` is replaced by a lookup that raises on any miss. **No engine searches or cache writes; zero missing FENs in the calls made.** The first three gates are calculated for every card; event and selector checks are only needed after those gates, plus the two named cards. The full audit takes about a minute on this machine.

Operational choices for the otherwise underspecified counter:

- `H` is the number of friendly knights/bishops occupying their corresponding standard starting squares at the line end. Captured minors do not count. `L=1` if every castling right is gone and the game history plus line contains no castling by that side. `U=H+L`.
- `W` is cumulative game-history-plus-line wasted events. A round trip returns the same man to any square it left at most four plies earlier. A retreat is a non-capture, non-check move to a lower relative rank immediately after a newly appearing cheaper attacker; round trips are not limited to backward moves. Non-pawn pieces, including kings, qualify. Queen moves beyond the first are counted only in absolute game plies 1-12, not the first 12 plies of each PV. Categories are additive: one move can count twice. Prefix totals cancel in the swing, but prefix tracking matters for a return across the root and for the queen-move allowance.
- `D=(opponent U+W)-(mover U+W)`; swing is `D(best)-D(played)`. Opening means the reviewed move is game ply 1-30 inclusive. Equal material means equal net 1/3/3/5/9 balance for the root mover at the two full PV ends, not identical remaining armies and not necessarily equality to the root material.
- A concrete-event **proxy** must occur adversely for the mover in played or favorably against the opponent in best, with a contrast in the other line: new total loss of castling rights versus castled/rights retained; an endpoint piece restricted by the existing `positional.restricted` static-exchange predicate with no equally restricted piece of its type in the other endpoint; or a non-pawn/non-king piece moving from outside to within Chebyshev distance two of the enemy king, with no entry by that side and piece type in the other line. Entries can be captures and need not survive. Castling loss must start from rights at the root. Restriction is checked at endpoints; entries are checked throughout. These are observable contrasts, **not proof that development caused them**. The manual judgements below test that missing causal step.
- The last gate is literally no current fact chosen (`explain(row)["facts"] == []`). Quiet fallback prose does not constitute a fact. Existing facts are not suppressed to make development qualify.

`dev-results.json` records aggregates, all 272 passing IDs, the seed, and full quantitative evidence for the 20 sampled cards plus the two named examples. It deliberately omits unneeded per-card data for the rest of the pool.

## Distribution and gates

Swing distribution over all 23,449 eligible errors:

| Swing | Cards |
|---:|---:|
| -8 | 4 |
| -7 | 7 |
| -6 | 35 |
| -5 | 107 |
| -4 | 288 |
| -3 | 820 |
| -2 | 2,057 |
| -1 | 4,226 |
| 0 | 6,030 |
| 1 | 4,904 |
| 2 | 2,790 |
| 3 | 1,324 |
| 4 | 522 |
| 5 | 204 |
| 6 | 86 |
| 7 | 28 |
| 8 | 12 |
| 9 | 1 |
| 10 | 4 |

| Condition | Pass alone over pool | Pass cumulatively |
|---|---:|---:|
| Eligible error | 23,449 | 23,449 |
| Game ply <= 30 | 11,944 | 11,944 |
| Same endpoint material balance | 6,646 | 3,982 |
| Swing >= 2 | 4,971 | 1,084 |
| Contrastive concrete-event proxy | Evaluated after first three gates | 629 |
| No fact chosen | Evaluated after first three gates | 272 |

Within the 1,084 first-three-gate matches, 533 have a king-zone entry, 286 a castling loss and 23 a restricted piece; these counts overlap. The union is 629. Of those, 357 already select an existing fact and 272 select none (**1.16% of the eligible pool**). Existing chosen facts on these 629 cards: none 272; piece_harassed 83; pawn_weakness 70; material 51; castling 47; trades 35; fork 20; mate_threat 14; passed_pawn 10; queen_chased 8; restricted 6; bishop_pair 5; outpost 5; mate 2; material+fork 1.

## Named ab12 examples

Count notation throughout: `home` lists H squares; `L` is the extra castling-loss unit; `U=H+L`; `W` includes the common game prefix. Material is from the root mover's viewpoint.

### ab12 pair-011: user development example - `88cl0uaw/21`

FEN: `rnbq1rk1/p3bppp/1pp5/3p4/4n3/4PQ2/PPPPBPPP/RNB1K1NR b KQ - 5 11`

Played: 11...Qd6 12.d3 Nf6 13.Qg3 Qd8 14.f4 Re8 15.Nf3 c5 16.O-O Bd6 17.Ne5 Nbd7 18.d4 Ne4 19.Qf3 f6 20.Ng4 Bb7 21.Nf2

Best: 11...Ng5 12.Qf4 Ne6 13.Qf3 Nd7 14.b3 Bf6 15.d4 Ng5 16.Qf4 Ne4 17.Bb2 c5 18.Nd2 cxd4 19.Bxd4 Bxd4 20.exd4

| Line | White home | L | U | W | Black home | L | U | W | D | Material |
|---|---|---:|---:|---:|---|---:|---:|---:|---:|---:|
| played | c1, b1 | 0 | 2 | 8 | - | 0 | 0 | 3 | 7 | -1 |
| best | g1 | 0 | 1 | 8 | c8 | 0 | 1 | 0 | 8 | -1 |

Game ply 22; mistake; loss 114cp; **swing +1**.

Concrete event: none under the stated proxy.

It passes opening and equal material, but fails swing >=2, the concrete-event proxy and the no-fact gate: current chosen fact is `queen_chased`. The common prefix has White W=6, Black W=0. Played adds Black Nf6 twice (return plus retreat), Qd8 once, White Qg3 once and Ng4 once. Best adds White Qf3 twice (return plus retreat). The board does support the user's development intuition: ...Qd6 spends a move on the queen while ...Ng5 attacks Qf3 with tempo. However, the full lines later contain different minor-piece moves, exchanges and returns, and the formula scores only +1. This is a failure to recover a positive example, not evidence that the user's reason is wrong.

### ab12 pair-002: Hark negative example - `joGFmaEx/13`

FEN: `rn2kbnr/ppp1q1pp/4bp2/8/2N1Q3/3B4/PPPP1PPP/RNB1K2R b KQkq - 2 7`

Played: 7...Bxc4 8.Qxe7+ Nxe7 9.Bxc4 Nd7 10.d4 c5 11.Nc3 Nc6 12.dxc5 Bxc5 13.Ne4 Nb4 14.O-O Nxc2 15.Rb1 b6 16.Nxc5 bxc5 17.Bf4

Best: 7...f5 8.Qe2 Nc6 9.O-O Nd4 10.Qd1 O-O-O 11.c3 Nc6 12.Be2 Qf7 13.Nba3 f4 14.Bg4 Nf6

| Line | White home | L | U | W | Black home | L | U | W | D | Material |
|---|---|---:|---:|---:|---|---:|---:|---:|---:|---:|
| played | - | 0 | 0 | 2 | - | 0 | 0 | 0 | 2 | 0 |
| best | c1 | 0 | 1 | 5 | f8 | 0 | 1 | 2 | 3 | -1 |

Game ply 14; blunder; loss 175cp; **swing +1**.

Concrete event: played: black king zone entered by enemy queen on e7 at line ply 2.

It passes opening but fails equal material (played 0, best -1), swing >=2 and no fact chosen (`queen_chased`). The queen entry Qxe7+ is immediately answered by ...Nxe7, illustrating how an ordinary exchange can satisfy the entry proxy. The common prefix has White W=2, Black W=0. Best adds three White wasted events (Qe2 twice, Qd1 once) and two Black events (...Nc6 twice). Played has no additional wasted event and neither side has a home minor at its endpoint. The board fits Hark's distinction: this is the specific ...f5 chase versus permitting a queen exchange, not a general failure to develop.

For pair-011, counting only equal PV prefixes gives swings **+3 at four plies, +5 at six, +6 at eight/ten, +2 at eighteen**, versus **+1 at the supplied full ends** (20 played plies and 18 best plies). These are sensitivity checks, not substituted results. They show that line length can determine whether the same development example crosses the threshold.

## Twenty random mechanical matches

`random.Random(20261015).sample(sorted(passing_ids), 20)`; the order below is the sampled order. All 20 pass all five mechanical gates and have no current chosen fact. "Yes/No/Unclear" is my separate board judgement that development is the main reason; all notes use the actual board and supplied lines, without fresh engine searches.

### 1. `MgL176RS/13` - Yes

FEN: `rn1qkb1r/ppp1pppp/1n2b3/3PB3/2P5/8/PP3PPP/RN1QKBNR b KQkq - 0 7`

Played: 7...Bd7 8.c5 Na4 9.c6 bxc6 10.Qxa4 cxd5 11.Qd1 c6 12.Bd3 e6 13.Ne2 f6

Best: 7...Bf5 8.Nf3 N8d7 9.Bc3 e5 10.dxe6 fxe6 11.Be2 Be7 12.Nd4 Nc5 13.Nxf5 Qxd1+ 14.Kxd1 exf5 15.Bxg7

| Line | White home | L | U | W | Black home | L | U | W | D | Material |
|---|---|---:|---:|---:|---|---:|---:|---:|---:|---:|
| played | b1 | 0 | 1 | 2 | f8, b8 | 0 | 2 | 2 | -1 | -1 |
| best | b1 | 1 | 2 | 0 | - | 0 | 0 | 1 | 1 | -1 |

Game ply 14; mistake; loss 170cp; **swing +2**.

Concrete event: best: white loses all castling rights without castling; best: white king zone entered by enemy queen on d1 at line ply 13.

**Board judgement: Yes.** The retreat ...Bd7 obstructs Nb8 and lets c5-c6 drive the queenside sequence; Black ends with Nb8 and Bf8 still home. ...Bf5 allows ...N8d7, ...e5 and ...Be7. Development is the coherent main difference, although the reported king event is only a queen exchange followed by Kxd1, not an attack.

### 2. `KcOj5M5H/22` - No

FEN: `r3kb1r/pp1npp1p/3p1np1/8/1q2P3/2NBBN2/1PP2PPP/1Q1R2K1 w kq - 0 12`

Played: 12.Be2 Bg7 13.Qa2 O-O 14.Ng5 Rac8 15.Rd4 Qb6 16.Rd1 Qc6

Best: 12.Qa2 Rc8 13.Nb5 b6 14.Qa6 Kd8 15.c3 Qb3

| Line | White home | L | U | W | Black home | L | U | W | D | Material |
|---|---|---:|---:|---:|---|---:|---:|---:|---:|---:|
| played | - | 0 | 0 | 1 | - | 0 | 0 | 3 | 2 | -3 |
| best | - | 0 | 0 | 0 | f8 | 1 | 2 | 2 | 4 | -3 |

Game ply 23; blunder; loss 508cp; **swing +2**.

Concrete event: best: black loses all castling rights without castling.

**Board judgement: No.** White already has every minor developed. Qa2, Nb5 and Qa6 create concrete threats around c7 and the uncastled king; Be2 misses that initiative. The large 508cp loss is not explained by two units of development count. The played line is also ten plies against only six for best.

### 3. `pPRLXuGK/20` - No

FEN: `1rbqkb1r/p1p4p/1pp2p1p/4p3/4P3/P1NP1N2/1PP2PPP/R2Q1RK1 w k - 0 11`

Played: 11.d4 Bg7 12.Nh4 O-O 13.d5 cxd5 14.Nxd5 f5 15.Nxf5 Bxf5 16.exf5 e4 17.c3 Rxf5 18.Ne3 Qxd1 19.Raxd1 Rf7 20.Rd5 Re8 21.Rfd1 Bf8 22.Kf1 Bc5 23.Rd8 Rxd8 24.Rxd8+ Kg7 25.Ke2 h5 26.Rd5

Best: 11.Nh4 Be6 12.Qf3 Rg8 13.Nf5 Qd7 14.Rad1 Rd8 15.Rfe1 c5 16.b3

| Line | White home | L | U | W | Black home | L | U | W | D | Material |
|---|---|---:|---:|---:|---|---:|---:|---:|---:|---:|
| played | - | 0 | 0 | 0 | - | 0 | 0 | 2 | 2 | 0 |
| best | - | 0 | 0 | 0 | f8 | 1 | 2 | 2 | 4 | 0 |

Game ply 21; inaccuracy; loss 66cp; **swing +2**.

Concrete event: best: black loses all castling rights without castling.

**Board judgement: No.** Nh4-f5 and Qf3 put pressure on the damaged black kingside. The entire swing comes from Bf8 remaining home and ...Rg8 voluntarily surrendering the last castling right in best. Played runs 31 plies, best 11; these are very different stages of the game. This is a kingside pressure/line-end effect, not reliable proof of a development error.

### 4. `se3vqcyq/29` - Yes

FEN: `1k1r1b1r/pbp1q2p/1pn2p2/4pB2/4N3/2PP2P1/PP2QP1P/R1B1R1K1 b - - 0 15`

Played: 15...Rg8 16.Qh5 Rh8 17.Nd2 Qg7 18.Nc4 Ne7 19.Be4 Nd5 20.Bd2 Bc8 21.Qf3 Bg4 22.Qg2 Be6 23.d4 h5 24.h4 f5

Best: 15...Qf7 16.f4 Re8 17.Bh3 f5 18.Ng5 Qg6 19.Bg2 Bc5+ 20.Be3 Bxe3+ 21.Qxe3

| Line | White home | L | U | W | Black home | L | U | W | D | Material |
|---|---|---:|---:|---:|---|---:|---:|---:|---:|---:|
| played | - | 0 | 0 | 1 | f8 | 0 | 1 | 1 | -1 | -1 |
| best | - | 0 | 0 | 1 | - | 0 | 0 | 0 | 1 | -1 |

Game ply 30; mistake; loss 122cp; **swing +2**.

Concrete event: best: white king zone entered by enemy bishop on e3 at line ply 11.

**Board judgement: Yes.** ...Rg8-h8 spends two moves returning the rook while Bf8 remains shut in. ...Qf7, ...Re8 and ...Bc5+ bring that bishop into play and support central pressure. Development/activity is a fair main reason, but the zone event ...Bxe3+ is just an exchange, not independent evidence of a dangerous invasion.

### 5. `0drtgreY/3` - Unclear

FEN: `rnbqkbnr/pppp1ppp/4p3/8/2PP4/8/PP2PPPP/RNBQKBNR b KQkq - 0 2`

Played: 2...c5 3.d5 Nf6 4.Nc3 g6 5.e4 d6 6.h3 Bg7 7.Nf3 O-O 8.Bd3 exd5 9.cxd5 Re8 10.O-O c4 11.Bxc4 Nxe4 12.Nxe4 Rxe4 13.Bg5 Qb6

Best: 2...Nf6 3.Nf3 b6 4.Nc3 Bb7 5.e3 Bb4 6.Bd2 Bxc3 7.Bxc3 Ne4 8.Bb4 c5 9.Ba3 O-O 10.Bd3 Qf6

| Line | White home | L | U | W | Black home | L | U | W | D | Material |
|---|---|---:|---:|---:|---|---:|---:|---:|---:|---:|
| played | - | 0 | 0 | 0 | c8, b8 | 0 | 2 | 0 | -2 | 0 |
| best | - | 0 | 0 | 1 | b8 | 0 | 1 | 0 | 0 | 0 |

Game ply 4; inaccuracy; loss 57cp; **swing +2**.

Concrete event: best: white king zone entered by enemy bishop on c3 at line ply 9.

**Board judgement: Unclear.** ...c5 is a recognizable central counterstrike, not an obviously idle opening move. Both lines contain substantial development; ...Bxc3 in best is a routine exchange beside the still-central white king. Different PV lengths and traded minors influence the count. The board does not establish development as the main reason for this 57cp error.

### 6. `39UkMPI7/18` - No

FEN: `2rqkb1r/1p3ppp/p1n1pn2/3pN3/Q2P1Bb1/2P5/PP1N1PPP/R3KB1R w KQk - 2 10`

Played: 10.Nxc6 Qd7 11.h3 Bf5 12.g4 Bg6 13.Nf3 Qxc6 14.Qxc6+ Rxc6 15.Ne5 Rb6 16.O-O-O Bd6 17.Be3 Nd7 18.Nxg6 hxg6

Best: 10.f3 Bf5 11.g4 Bg6 12.h4 h5 13.Nxg6 fxg6 14.Qc2 Kf7 15.g5 Nd7 16.Bd3 Ne7 17.O-O-O Rc6 18.Kb1

| Line | White home | L | U | W | Black home | L | U | W | D | Material |
|---|---|---:|---:|---:|---|---:|---:|---:|---:|---:|
| played | f1 | 0 | 1 | 0 | - | 0 | 0 | 2 | 1 | 0 |
| best | - | 0 | 0 | 0 | f8 | 1 | 2 | 3 | 5 | 0 |

Game ply 19; mistake; loss 145cp; **swing +4**.

Concrete event: best: black loses all castling rights without castling.

**Board judgement: No.** f3-g4-h4 chases Bg4 and keeps queens for an attack against the uncastled king; Nxc6 permits a queen exchange and reduces that attack. ...Kf7 and Bf8 explain why the attack is attractive, but the actionable reason is preserving the attack and gaining tempi on the bishop, not the aggregate development score.

### 7. `2Wuw6z0U/27` - No

FEN: `rn3rk1/pp2nppp/2p5/2p2bN1/8/2NB4/PPP2PPP/2KR3R b - - 3 14`

Played: 14...h6 15.Rhe1 Bxd3 16.Rxe7 Bf5 17.Nge4 b6 18.Nd6 Bg4 19.f3 Bc8 20.f4

Best: 14...Bxd3 15.Rxd3 h6 16.Nge4 b6 17.Rhd1 Nf5 18.Ng3 Nd4 19.Nce4 f5 20.Nd6 f4 21.Nge4 Nd7 22.c3 Ne6

| Line | White home | L | U | W | Black home | L | U | W | D | Material |
|---|---|---:|---:|---:|---|---:|---:|---:|---:|---:|
| played | - | 0 | 0 | 0 | c8, b8 | 0 | 2 | 3 | -5 | 1 |
| best | - | 0 | 0 | 1 | - | 0 | 0 | 2 | -1 | 1 |

Game ply 28; inaccuracy; loss 107cp; **swing +4**.

Concrete event: played: black king zone entered by enemy rook on e7 at line ply 4.

**Board judgement: No.** The move order ...Bxd3 first removes Bd3 before ...h6. Playing ...h6 immediately allows Rhe1 and Rxe7, trading the e7-knight for the bishop while admitting a rook to the seventh rank. The concrete rook entry and move order are more informative than calling this development; best also has 19 plies against 11 in played.

### 8. `KWStdWd8/19` - No

FEN: `r3kb1r/pp1qppp1/2n4p/2ppP2n/5Pb1/2NP4/PPPNB1PP/R1B1QRK1 b kq - 2 10`

Played: 10...Nb4 11.f5 Nxc2 12.e6 fxe6 13.Bxg4 Nxe1 14.fxe6 Qd6 15.Bxh5+ Kd8 16.Rxe1 g5 17.Bf3 Bg7 18.Nxd5 Rf8

Best: 10...Bxe2 11.Qxe2 g6 12.f5 Nd4 13.Qd1 Nxf5 14.Nb3 Nhg7 15.Nxc5 Qc6 16.Nb3

| Line | White home | L | U | W | Black home | L | U | W | D | Material |
|---|---|---:|---:|---:|---|---:|---:|---:|---:|---:|
| played | c1 | 0 | 1 | 0 | - | 1 | 1 | 0 | 0 | 0 |
| best | c1 | 0 | 1 | 2 | f8 | 0 | 1 | 0 | 2 | 0 |

Game ply 20; blunder; loss 218cp; **swing +2**.

Concrete event: played: black loses all castling rights without castling; best: white king zone entered by enemy bishop on e2 at line ply 1.

**Board judgement: No.** ...Nb4 goes after the c2/e1 fork while f5-e6 opens the king position. White loses the queen on e1 but takes the g4-bishop and h5-knight; equal endpoint material hides that tactical transformation. ...Bxe2 instead eliminates an attacker and meets f5 with ...Nd4. Tactics and king exposure are the main story.

### 9. `ytR8qwlM/5` - Yes

FEN: `rnbqkbnr/pppp1pp1/8/4p2p/4P3/3P1N2/PPP2PPP/RNBQKB1R b KQkq - 1 3`

Played: 3...d5 4.Nxe5 Qe7 5.d4 dxe4 6.Nc3 Nd7 7.Nd5 Qd8 8.Bb5 Bd6 9.Nc4 a6 10.Nxd6+ cxd6 11.Be2

Best: 3...Nc6 4.Nc3 Nf6 5.Bg5 Be7 6.Qd2 O-O 7.Be2 d6 8.d4 Bg4 9.d5 Bxf3 10.Bxf3 Nd4 11.O-O-O Nxd5 12.Bxe7 Nxe7 13.Bxh5 c6

| Line | White home | L | U | W | Black home | L | U | W | D | Material |
|---|---|---:|---:|---:|---|---:|---:|---:|---:|---:|
| played | c1 | 0 | 1 | 0 | g8, c8 | 0 | 2 | 1 | -2 | 0 |
| best | - | 0 | 0 | 0 | - | 0 | 0 | 0 | 0 | 0 |

Game ply 6; inaccuracy; loss 72cp; **swing +2**.

Concrete event: played: black king zone entered by enemy knight on d6 at line ply 14; best: white king zone entered by enemy bishop on f3 at line ply 13.

**Board judgement: Yes.** ...d5 with almost every minor home starts a forcing sequence in which Qe7 is chased back to d8 and the g8-knight/c8-bishop remain undeveloped. ...Nc6, ...Nf6 and castling are a direct improvement. The counted entries are exchanged pieces, but completing development is still the best broad reason on this board.

### 10. `n3MCK8xW/5` - Yes

FEN: `rnb1kbnr/ppp1pppp/8/3q4/3P4/8/PPP2PPP/RNBQKBNR b KQkq - 0 3`

Played: 3...Qe4+ 4.Be3 Nf6 5.Nc3 Qf5 6.Nf3 Qa5 7.Ne5 c6 8.Qf3 Be6 9.Bc4 Bxc4 10.Nxc4 Qh5 11.Qxh5 Nxh5 12.O-O-O Nf6

Best: 3...Nc6 4.Nf3 e5 5.Nc3 Bb4 6.Bd2 Bxc3 7.Bxc3 e4 8.Ne5 Nxe5 9.dxe5 Ne7 10.Qxd5 Nxd5 11.Bd2 O-O 12.O-O-O Re8 13.Ba5 c6

| Line | White home | L | U | W | Black home | L | U | W | D | Material |
|---|---|---:|---:|---:|---|---:|---:|---:|---:|---:|
| played | - | 0 | 0 | 0 | f8, b8 | 0 | 2 | 5 | -7 | 0 |
| best | f1 | 0 | 1 | 0 | c8 | 0 | 1 | 0 | 0 | 0 |

Game ply 6; mistake; loss 118cp; **swing +7**.

Concrete event: best: white king zone entered by enemy bishop on c3 at line ply 7.

**Board judgement: Yes.** ...Qe4+ lets Be3, Nc3 and Nf3 arrive with tempo while the queen keeps moving. ...Nc6 and ...e5 develop and contest the centre instead. This is a clear development error. The score of seven exaggerates independent evidence because Qf5 counts both as a retreat and an extra queen move, and late ...Nf6 is another counted return.

### 11. `joGFmaEx/19` - No

FEN: `r3kb1r/ppp1n1pp/2n2p2/8/2B5/3P4/PPP2PPP/RNB1K2R b KQkq - 0 10`

Played: 10...Ne5 11.Be6 Rd8 12.Nc3 N7c6 13.Be3 Nd4 14.Bxd4 Rxd4 15.Bb3 Kd8 16.Ne2 Rd6 17.d4 Nd7 18.h4

Best: 10...Nd4 11.Kd2 b5 12.Bb3 h5 13.c3 Nxb3+ 14.axb3 Kf7 15.b4

| Line | White home | L | U | W | Black home | L | U | W | D | Material |
|---|---|---:|---:|---:|---|---:|---:|---:|---:|---:|
| played | - | 0 | 0 | 2 | f8 | 1 | 2 | 2 | -2 | -1 |
| best | c1, b1 | 1 | 3 | 3 | f8 | 1 | 2 | 0 | 4 | -1 |

Game ply 20; inaccuracy; loss 107cp; **swing +6**.

Concrete event: played: black king zone entered by enemy bishop on e6 at line ply 2; best: white loses all castling rights without castling.

**Board judgement: No.** ...Nd4 creates the concrete threat ...Nxc2+ against the king/rook, explaining the awkward Kd2 in best. ...Ne5 allows Be6 and queenside pressure instead. Development and castling counts register the consequences, but the knight fork threat and king placement are the more specific main reason.

### 12. `jIB5KwF1/15` - Yes

FEN: `r1b1kbnr/ppp5/2np1q1p/4ppp1/2B1P3/2NP1N1P/PPP1KPP1/R1BQR3 b kq - 2 8`

Played: 8...Be6 9.Nd5 Bxd5 10.exd5 Nce7 11.c3 Qg6 12.Qa4+ Kd8 13.Qb3 b6 14.Kd1 Nf6 15.a4 a5 16.Bd2 Nd7

Best: 8...g4 9.Ng1 Nge7 10.Qd2 gxh3 11.Nxh3 Bd7 12.Kd1 O-O-O 13.Rh1 f4

| Line | White home | L | U | W | Black home | L | U | W | D | Material |
|---|---|---:|---:|---:|---|---:|---:|---:|---:|---:|
| played | - | 1 | 1 | 0 | f8 | 1 | 2 | 1 | -2 | 0 |
| best | c1 | 1 | 2 | 1 | f8 | 0 | 1 | 0 | 2 | 0 |

Game ply 16; mistake; loss 131cp; **swing +4**.

Concrete event: played: black loses all castling rights without castling.

**Board judgement: Yes.** ...g4 drives Nf3 back to g1 and buys time for ...Nge7, ...Bd7 and long castling. ...Be6 trades away the bishop and Qa4+ drives the king to d8. Here the tempo actually connects the retreat to finishing development and king safety, so development is a defensible main reason.

### 13. `QaTZBr39/22` - No

FEN: `rn1q1rk1/pbp1bppp/1p6/3p4/3P4/P1NQB3/1P3PPP/2KR1B1R w - - 0 12`

Played: 12.g3 Ba6 13.Qc2 Bxf1 14.Rhxf1 Qd7 15.Rfe1 Nc6 16.Bf4 Rfd8 17.Kb1 Bf8 18.h4 Na5 19.h5 h6

Best: 12.Qf5 Qd7 13.Qf3 c6 14.Bd3 Bc8 15.Qh5 f5 16.g4 Qe8 17.Qxe8 Rxe8 18.gxf5 Rf8 19.Rhg1 Bxf5

| Line | White home | L | U | W | Black home | L | U | W | D | Material |
|---|---|---:|---:|---:|---|---:|---:|---:|---:|---:|
| played | - | 0 | 0 | 1 | f8 | 0 | 1 | 0 | 0 | -1 |
| best | - | 0 | 0 | 0 | b8 | 0 | 1 | 1 | 2 | -1 |

Game ply 23; mistake; loss 128cp; **swing +2**.

Concrete event: best: black king zone entered by enemy queen on e8 at line ply 11.

**Board judgement: No.** Qf5 uses the queen actively against d5/h7 and supports the kingside pawn advance; g3 lets ...Ba6 exchange Bf1 and Black coordinate. The reported invasion is Qxe8, immediately met by ...Rxe8. An ordinary queen trade does not substantiate a development explanation; the two-point swing is mostly retreat/return bookkeeping.

### 14. `uV7Tz1VK/11` - Yes

FEN: `rnbqk1nr/2pp1ppp/1p2p3/p7/2PPP3/P1P5/5PPP/R1BQKBNR b KQkq - 0 6`

Played: 6...Ra6 7.Qg4 Kf8 8.Bd3 d6 9.Qe2 Ra8 10.f4 Qh4+ 11.Kd1 Ba6 12.Nf3 Qg4 13.h3 Qg3 14.Be3 Ke8

Best: 6...Ne7 7.Bd3 d6 8.Ne2 O-O 9.O-O Nd7 10.Ng3 Ba6 11.Ra2 c5 12.Qg4 cxd4 13.cxd4 Rc8

| Line | White home | L | U | W | Black home | L | U | W | D | Material |
|---|---|---:|---:|---:|---|---:|---:|---:|---:|---:|
| played | - | 1 | 1 | 0 | g8, b8 | 1 | 3 | 0 | -2 | 0 |
| best | c1 | 0 | 1 | 0 | - | 0 | 0 | 0 | 1 | 0 |

Game ply 12; mistake; loss 121cp; **swing +3**.

Concrete event: played: black loses all castling rights without castling.

**Board judgement: Yes.** ...Ra6 mobilizes a rook before the knights and lets Qg4 force ...Kf8. ...Ne7, ...O-O and ...Nd7 give the king shelter and develop both knights. The castling loss and two home knights are a concrete cost of neglecting development.

### 15. `47RJcEJR/18` - Yes

FEN: `rn1qk2r/ppp2ppp/3bpnb1/3p4/3P4/4PP1P/PPPNB1PB/RN1QK2R w KQkq - 1 10`

Played: 10.g4 c5 11.c3 Bxh2 12.Rxh2 Nc6 13.Kf2 Qb6 14.Qb3 Qc7 15.Rg2 h5 16.g5

Best: 10.Bxd6 Qxd6 11.O-O c5 12.c3 O-O 13.Rf2 Nc6 14.Nf1 e5 15.dxe5 Qxe5 16.Nbd2 Rad8 17.Qb3

| Line | White home | L | U | W | Black home | L | U | W | D | Material |
|---|---|---:|---:|---:|---|---:|---:|---:|---:|---:|
| played | b1 | 1 | 2 | 0 | - | 0 | 0 | 0 | -2 | 0 |
| best | - | 0 | 0 | 0 | - | 0 | 0 | 0 | 0 | 0 |

Game ply 19; inaccuracy; loss 77cp; **swing +2**.

Concrete event: played: white loses all castling rights without castling; best: black king zone entered by enemy bishop on d6 at line ply 1.

**Board judgement: Yes.** g4 leaves Nb1 home and the king in the centre while ...Bxh2, Rxh2 and Kf2 disrupt completion of development. Bxd6 removes the active bishop and permits immediate castling, followed by Nbd2. Development and getting the king safe are a reasonable main reason; the best-line bishop entry itself is only a capture/exchange.

### 16. `JB1JDGYx/6` - No

FEN: `rnbqkbnr/ppp1pp1p/6p1/8/2pP4/2N5/PP2PPPP/R1BQKBNR w KQkq - 0 4`

Played: 4.e3 Bg7 5.Bxc4 Nf6 6.Nf3 c5 7.Qa4+ Nfd7 8.dxc5 Nc6 9.Qa3 Qa5 10.Qxa5 Nxa5 11.Be2 Nxc5 12.Nd5 Be6

Best: 4.e4 Bg7 5.Bxc4 Nc6 6.Nf3 Bg4 7.Bxf7+ Kxf7 8.Ng5+ Ke8 9.Qxg4 Nxd4 10.Qd1 h6

| Line | White home | L | U | W | Black home | L | U | W | D | Material |
|---|---|---:|---:|---:|---|---:|---:|---:|---:|---:|
| played | c1 | 0 | 1 | 0 | - | 0 | 0 | 0 | -1 | 0 |
| best | c1 | 0 | 1 | 1 | g8 | 1 | 2 | 2 | 2 | 0 |

Game ply 7; inaccuracy; loss 57cp; **swing +3**.

Concrete event: best: black loses all castling rights without castling; best: black king zone entered by enemy knight on g5 at line ply 9; best: black king zone entered by enemy bishop on f7 at line ply 7.

**Board judgement: No.** e4 permits the concrete Bxf7+, Ng5+ and Qxg4 sequence against the loose g4-bishop and uncastled king. King moves count as both a round trip and a retreat, inflating the apparent development swing. The tactical use of the open diagonal and loose bishop explains this line more directly than development.

### 17. `4XBssZXD/12` - Yes

FEN: `rn1qk2r/pppbbppp/3p1n2/4p3/4P3/2NP1N1P/PPP1BPP1/R1BQK2R w KQkq - 1 7`

Played: 7.Bg5 c5 8.Nd2 O-O 9.O-O Nc6 10.f4 Nd4 11.Bxf6 Bxf6 12.f5 Bg5 13.Bg4 Bc6 14.Nd5 Bxd5 15.exd5 Be3+ 16.Kh2 Bf4+ 17.Kh1 Bxd2 18.Qxd2 b5

Best: 7.g4 c5 8.g5 Ng8 9.h4 h6 10.Rg1 Nc6 11.Nd5 hxg5 12.hxg5 Bf8 13.c3

| Line | White home | L | U | W | Black home | L | U | W | D | Material |
|---|---|---:|---:|---:|---|---:|---:|---:|---:|---:|
| played | - | 0 | 0 | 1 | - | 0 | 0 | 1 | 0 | 0 |
| best | c1 | 0 | 1 | 0 | g8, f8 | 0 | 2 | 2 | 3 | 0 |

Game ply 13; inaccuracy; loss 64cp; **swing +3**.

Concrete event: played: white king zone entered by enemy bishop on e3 at line ply 18; played: white king zone entered by enemy bishop on f4 at line ply 20.

**Board judgement: Yes.** g4-g5 drives Nf6 to g8, gains space and makes Black work around its home pieces; ...Bf8 later retreats too. Bg5 instead lets Black castle and develop freely. Development with tempo is a fair main reason. The played-line bishop checks happen much later, and differing PV lengths strengthen the endpoint effect.

### 18. `VrZ2Ahqm/12` - No

FEN: `rn2kbnr/pp2pppp/2p3b1/q7/3PP3/2N5/PP1B1PPP/R2QKBNR w KQkq - 1 7`

Played: 7.Nf3 Nd7 8.Bc4 Qc7 9.Rc1 e6 10.O-O Ngf6 11.Re1 Bb4 12.e5 Bxc3 13.Bxc3 Ne4

Best: 7.f4 e6 8.g4 h6 9.f5 Bh7 10.Bc4 Nd7 11.Nf3 Ngf6 12.O-O Qb6 13.Qe2 O-O-O 14.e5 Nxg4 15.fxe6 fxe6 16.Bxe6

| Line | White home | L | U | W | Black home | L | U | W | D | Material |
|---|---|---:|---:|---:|---|---:|---:|---:|---:|---:|
| played | - | 0 | 0 | 0 | - | 0 | 0 | 2 | 2 | 0 |
| best | - | 0 | 0 | 0 | f8 | 0 | 1 | 3 | 4 | 0 |

Game ply 13; inaccuracy; loss 96cp; **swing +2**.

Concrete event: best: black knight on g4 has no safe square by the restriction predicate; best: black king zone entered by enemy bishop on e6 at line ply 19.

**Board judgement: No.** f4-g4-f5 gains space and restricts Bg6, while Nf3 lets ...Bb4, ...Bxc3 and ...Ne4 establish activity. The g4-knight is restricted only after the best PV grabs a pawn with ...Nxg4. Space, restriction and the specific pawn storm are the main reason; the late trapped knight does not prove that the original error was development.

### 19. `5FL2ZjQc/13` - Yes

FEN: `r1bqkb1r/pp1p1p1p/2n2np1/4p3/2B1P3/2N2N2/PPPQ1PPP/R1B1K2R b KQkq - 1 7`

Played: 7...Qe7 8.Qd3 Qd6 9.Qe2 Bg7 10.O-O O-O 11.Rd1 Qb8 12.Bg5 h6 13.Bxf6 Bxf6 14.Nd5

Best: 7...h6 8.Qd3 a6 9.Be3 d6 10.O-O-O Be7 11.Kb1 b5 12.Bb3 Be6 13.Nh4 Bxb3 14.cxb3 Rc8 15.f4 exf4 16.Bxf4

| Line | White home | L | U | W | Black home | L | U | W | D | Material |
|---|---|---:|---:|---:|---|---:|---:|---:|---:|---:|
| played | - | 0 | 0 | 2 | c8 | 0 | 1 | 1 | 0 | 0 |
| best | - | 0 | 0 | 3 | - | 0 | 0 | 0 | 3 | 0 |

Game ply 14; inaccuracy; loss 75cp; **swing +3**.

Concrete event: played: black king zone entered by enemy bishop on f6 at line ply 12; best: white king zone entered by enemy bishop on b3 at line ply 13.

**Board judgement: Yes.** ...Qe7 obstructs Bf8 and is followed by ...Qd6-b8 while Bc8 never develops. ...h6, ...d6, ...Be7, ...Be6 and long castling produce a coherent setup instead. Lost tempi and incomplete development are a good main reason, although the two bishop-entry events are routine captures.

### 20. `et3hCRq8/9` - Yes

FEN: `rnbqkbnr/pp4pp/2p1pp2/3pP3/3P1P2/3B4/PPP3PP/RNBQK1NR b KQkq - 1 5`

Played: 5...Nd7 6.Qh5+ Ke7 7.Nf3 Qe8 8.Qh3 Kd8 9.O-O Nh6 10.Nc3 Kc7 11.Ne2 a5 12.Bd2 b6 13.b3 Ba6 14.c4

Best: 5...Nh6 6.Nf3 c5 7.O-O Nc6 8.c3 Be7 9.exf6 gxf6 10.Kh1 O-O 11.dxc5 Bxc5 12.b4 Bd6

| Line | White home | L | U | W | Black home | L | U | W | D | Material |
|---|---|---:|---:|---:|---|---:|---:|---:|---:|---:|
| played | - | 0 | 0 | 0 | f8 | 1 | 2 | 0 | -2 | 0 |
| best | c1, b1 | 0 | 2 | 0 | c8 | 0 | 1 | 1 | 0 | 0 |

Game ply 10; mistake; loss 165cp; **swing +2**.

Concrete event: played: black loses all castling rights without castling.

**Board judgement: Yes.** ...Nd7 allows Qh5+ and a king walk through e7, d8 and c7 while Bf8 stays home. ...Nh6 followed by ...Nc6, ...Be7 and castling avoids that disruption. This is a concrete development/king-safety failure with equal material, rather than a generic recommendation to develop.

## Conclusion

**Only a selector feature.** The count is computable cheaply from supplied lines and can nominate otherwise unexplained opening cards, but these gates yield only 10 convincing main-reason cases in this 20-card board review, miss the user's pair-011 example, and mix actual loss of tempo with forced returns, king moves, captured minors, routine king-zone exchanges and unequal PV horizons. Keep U, W and swing as separate measured features alongside the actual event, material and chosen fact; the present evidence does not justify a development sentence. A template such as "{played} loses time with {wasted move}; {best} develops with tempo and {concrete consequence}" would require an independently verified causal move/event pair, which this aggregate does not establish. This audit therefore does not propose adding that template to the Coach.

## Verification

- Replayed both supplied PVs and the complete game prefix for every eligible card; illegal PVs fail rather than truncate.
- Nine focused unit tests pass: same-man/time-window round trips, overlap with cheaper-piece retreats, global queen window, actual castling versus loss of rights, tracking across the root, illegal PV rejection, contrastive castling/zone events, and cache misses blocked before engine launch.
- Repeated full-pool run gives the same histogram, funnel and seeded sample; no fresh searches, no commits, and task outputs are under `selector/`.
