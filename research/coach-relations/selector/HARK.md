# Hark vs sol on the 360 development cards

## Hark vs sol pass 1 (cand)

- candidates (696): good (correct and main) agreement 80%, kappa 0.60; correct agreement 87%, kappa 0.26
- speak or stay bare (360 cards): agreement 83%, kappa 0.56; speaks on 78% (sol pass 1 (cand)) vs 70% (Hark)
- multi-candidate cards where both pick one: 171; same pick 89%
- cards decided differently: 80

## Hark vs sol pass 2 (cand2)

- candidates (696): good (correct and main) agreement 80%, kappa 0.61; correct agreement 88%, kappa 0.30
- speak or stay bare (360 cards): agreement 83%, kappa 0.56; speaks on 79% (sol pass 2 (cand2)) vs 70% (Hark)
- multi-candidate cards where both pick one: 172; same pick 89%
- cards decided differently: 80

Speak / stay bare, sol pass 1 by Hark:

| | Hark speaks | Hark bare |
| --- | ---: | ---: |
| sol speaks | 235 | 45 |
| sol bare | 17 | 63 |

Good rate per candidate type (v2 weak types marked *):

| Type | n | sol | Hark |
| --- | ---: | ---: | ---: |
| material_small | 190 | 68% | 62% |
| trades * | 147 | 39% | 10% |
| material_big | 90 | 91% | 81% |
| passed_pawn * | 69 | 14% | 4% |
| pawn_weakness * | 52 | 27% | 25% |
| fork | 48 | 67% | 50% |
| mate_threat | 40 | 88% | 65% |
| piece_harassed | 22 | 77% | 41% |
| castling * | 15 | 33% | 20% |
| mate | 9 | 100% | 100% |
| forced_mate | 7 | 57% | 57% |
| restricted * | 4 | 50% | 50% |
| outpost * | 1 | 0% | 0% |
| queen_chased | 1 | 100% | 0% |
| promotion | 1 | 100% | 100% |

Policies scored with Hark's labels (pool-weighted; v2 was chosen on sol's labels):

| Policy | Coverage | Hit | Wrong: should abstain | Wrong: other was good | Recall | Utility |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| R0 | 100% | 61% | 34% | 5% | 92% | -0.16 |
| R1b (v1) | 68% | 75% | 12% | 5% | 77% | +0.18 |
| R1b (v2) | 72% | 76% | 13% | 4% | 82% | +0.19 |

Spot-check set (seed 20261015): 40 random (30 multi, 10 single) + 20 of the 68 disagreement cards outside the random 40, shuffled, in `spot/`.
