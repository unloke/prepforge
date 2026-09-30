# Scout sparse-decision follow-up (PR #74)

Production path verified: parsed opponent games → observed opening branches and full-depth live trie → `rankedOpeningBranches` plausibility gate → bounded leaf-only Stockfish prefilter → globally capped Maia pool → game plan. The gate runs before Stockfish. Its numeric `routeReach` is now the minimum **supported** opponent conditional probability, or `null` when no opponent decision has enough parent games. Each route also carries `routePlausibility`: completeness, supported/unknown counts, and deepest supported ply. The Stockfish entry and game-plan line retain that evidence. Candidate generation and Maia scope are unchanged.

We compared `minParentGames ∈ {2, 3, 5}` and `probabilityGate ∈ {5%, 10%, 15%}` against PR #74's `minParentGames=1, gate=10%`. On these corpora, changing the parent threshold does not change route selection at a fixed probability gate: every decision below 5–15% already has enough parent games to be supported under all three sample thresholds. It **does** change the meaning of sparse decisions. We chose **3 parent games and 10%**: two observations are too few to call a local choice habitual; five leaves even more of the useful early branch unmeasured. The 10% gate preserves the previous PR's candidate and engine workload while still rejecting clearly off-habit choices. Unknown decisions neither pass as 100% evidence nor reject their observed route.

| Player | Profile | Eligible routes before→after | Selected routes | Held-out decision hit | Selected supported→unknown decisions | Deepest supported ply before→after | Low-probability route rejects | Stockfish leaf FENs | Maia cap |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| EricRosen | 20 | 20→20 | 20 | .558 | 238/0→28/210 | 41→4 | 0 | 20 | 12 |
| EricRosen | 50 | 46→46 | 24 | .555 | 284/0→38/246 | 41→4 | 4 | 46 | 12 |
| EricRosen | 100 | 95→95 | 24 | .502 | 305/0→40/265 | 41→4 | 5 | 94 | 12 |
| EricRosen | 300 | 278→278 | 24 | .546 | 293/0→38/255 | 41→8 | 21 | 267 | 12 |
| EricRosen | 1000 | 892→892 | 24 | .543 | 263/0→34/229 | 33→6 | 96 | 596 | 12 |
| DrNykterstein | 20 | 18→18 | 18 | .261 | 227/0→14/213 | 35→2 | 2 | 18 | 12 |
| DrNykterstein | 50 | 41→41 | 24 | .219 | 299/0→41/258 | 34→7 | 9 | 41 | 12 |
| DrNykterstein | 100 | 79→79 | 24 | .226 | 298/0→51/247 | 34→6 | 21 | 79 | 12 |
| DrNykterstein | 300 | 257→257 | 24 | .145 | 297/0→28/269 | 35→4 | 42 | 253 | 12 |

`Supported→unknown` reports counts among selected routes as `supported/unknown` before and after. Deepest supported ply is the maximum among those selected routes. Held-out hit and selected route identities are unchanged at 10% because the same low-probability decisions remain supported. Leaf FENs are distinct positions sent to the bounded Stockfish stage, not engine evaluations. Maia remains capped at 12. The [machine-readable results](scout-sparse-benchmark-results.json) retain all 2/3/5 × 5/10/15% metrics and the before/after selected route identities at every profile size.

At the largest EricRosen profile, probability gates 5/10/15% produce respectively 933/892/829 eligible routes, held-out hit .543/.543/.543, 55/96/159 low-probability rejects, and 595/596/594 Stockfish leaf FENs. At the largest DrNykterstein profile, the corresponding figures are 272/257/207 routes, hit .153/.145/.141, 27/42/92 rejects, and 268/253/204 leaf FENs. These numbers are the same at parent thresholds 2, 3, and 5; support labels differ. The benchmark JSON can be regenerated with `scripts/scout-sparse-plausibility-study.mjs` against the two parsed-game files used in the first PR.

The updated [case-level trace](scout-plausibility-case-trace.json) gives full FEN, UCI move, parent/move game counts, conditional probability, evidence class, and gate result for each opponent decision. In the selected EricRosen route `Nf3 d5 e3 Nf6 … O-O Nbd7`, `...d5` is **24/37 = 64.9%, supported, pass**. Each later 1/1 decision is **unknown**, with gate result `unknown`; none is described as 100% confidence. The rejected `Nf3 h6 …` route has `...h6` at **1/37 = 2.7%, supported, reject**. Whole-route repeats are not required.
