# Scout sample-aware plausibility follow-up

The production path builds a full-depth trie from observed opponent games, ranks only observed opening branches, gates on the weakest opponent decision, then trims candidates before Stockfish. Maia remains capped at 12. The former `parentGames >= 3` gate lost most deep evidence (EricRosen 1000: deepest supported ply 6; DrNykterstein 300: 4).

## Estimators at the same position

| Move/parent | Raw | Laplace Beta(1,1) mean | Jeffreys Beta(.5,.5) mean | Wilson 95% lower |
|---|---:|---:|---:|---:|
| 24/37 | 64.86% | 64.10% | 64.47% | 48.76% |
| 1/37 | 2.70% | 5.13% | 3.95% | 0.48% |
| 1/1 | 100% | 66.67% | 75.00% | 20.65% |
| 2/2 | 100% | 75.00% | 83.33% | 34.24% |
| 1/2 | 50% | 50.00% | 50.00% | 9.45% |

Jeffreys posterior mean is selected with the existing 10% weakest-decision gate. It gives every observed opponent choice a finite estimate, rejects 1/37, and does not suppress a 1/2 choice like Wilson does. The route score is a minimum, so length alone does not multiply down its score. Our moves are excluded. This is an estimate of move probability, not a confidence claim.

## Real-game benchmark

Chronological last 50 games held out; profile sizes are the latest N remaining games. `Hit` is matched held-out opponent decisions among the top 24 routes. `Routes` is eligible candidates; `low` is eligible routes with any raw opponent decision below 5%; `depth` is median selected route plies; `SF` is distinct Stockfish leaf FENs after production-style trim; `Maia` is its unchanged upper bound. Reproduce with `node scripts/scout-sparse-plausibility-study.mjs tmp/scout-ericrosen-1200.json` and the DrNykterstein counterpart. Full route identities and case traces are in the adjacent JSON files.

| Player | Games | Previous cutoff hit/routes/SF | Jeffreys hit/routes/low/depth/SF/Maia |
|---|---:|---|---|
| EricRosen | 20 | 247/443; 20; 20 | 247/443; 20; 0; 22; 20; 12 |
| EricRosen | 50 | 334/602; 46; 46 | 334/602; 46; 0; 22; 46; 12 |
| EricRosen | 100 | 318/633; 95; 94 | 318/633; 95; 0; 24; 94; 12 |
| EricRosen | 300 | 280/513; 278; 267 | 280/513; 281; 0; 23; 270; 12 |
| EricRosen | 1000 | 228/420; 892; 596 | 228/420; 904; 0; 22; 595; 12 |
| DrNykterstein | 20 | 86/329; 18; 18 | 89/376; 20; 0; 23; 20; 12 |
| DrNykterstein | 50 | 106/483; 41; 41 | 69/456; 44; 0; 26; 44; 12 |
| DrNykterstein | 100 | 98/433; 79; 79 | 90/436; 84; 0; 26; 84; 12 |
| DrNykterstein | 300 | 64/442; 257; 253 | 64/442; 260; 0; 24; 256; 12 |

DrNykterstein has 606 parsed games, so 1000 profile games plus 50 holdout are unavailable. Raw, Laplace, Jeffreys and Wilson results at every available size are in the JSON files. At EricRosen 1000, raw/Laplace/Jeffreys/Wilson have 892/913/904/686 candidates; held-out hits are 228/420, 228/420, 228/420, 239/407. At DrNykterstein 300 they have 257/263/260/110 candidates and 64/442, 66/432, 64/442, 84/385 hits. Wilson gets higher conditional hit in some sizes by discarding many actual historical routes; at DrNykterstein 20 it retains only 2 of 20. Laplace admits more low frequency decisions than Jeffreys. All four methods keep zero raw-below-5% routes at the 10% gate.

## Case trace

EricRosen route `Nf3 d5 e3 Nf6 c4 e6 Nc3 Be7 b3 O-O Bb2 b6 d4 Bb7 Bd3 a6 O-O Nbd7`:

| Position (FEN before decision) | Move | Move/parent | Raw | Jeffreys | Gate |
|---|---|---:|---:|---:|---|
| `rnbqkbnr/pppppppp/8/8/8/5N2/PPPPPPPP/RNBQKB1R b KQkq - 1 1` | d7d5 | 24/37 | 64.86% | 64.47% | pass |
| `rnbqkbnr/ppp1pppp/8/3p4/8/4PN2/PPPP1PPP/RNBQKB1R b KQkq - 0 2` | g8f6 | 1/1 | 100% | 75.00% | pass |
| `rnbqkbnr/pppppppp/8/8/8/5N2/PPPPPPPP/RNBQKB1R b KQkq - 1 1` | h7h6 (different observed route) | 1/37 | 2.70% | 3.95% | reject |

Every subsequent opponent decision is retained in the JSON trace with its FEN, move, counts, raw probability, estimate and gate result. A 1/37 decision estimates 3.95% and fails the gate. The case trace is evidence at each actual position; 1/1 does not mean 100% confidence.
