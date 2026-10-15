# Reason selector: offline evaluation (cards both sol passes label alike)

298 labelled cards (sol, candidate level), 558 candidates; 232 cards have a good (correct and main) candidate; 187 have two or more candidates; 267 have every candidate correct.

Rates are weighted to the pool's mix (among cards with a candidate: one candidate 59%, two or more 41%); the 27% of error cards with no candidate stay bare under every policy, so pool coverage = coverage x 0.73. Wrong = shown a reason that is not good: 'should abstain' when no candidate on the card is good, 'other was good' when another one was.

## Rules

| Policy | Coverage | Hit | Wrong: should abstain | Wrong: other was good | Recall |
| --- | ---: | ---: | ---: | ---: | ---: |
| oracle | 73% | 100% | 0% | 0% | 100% |
| R0 current Coach (rank 1, always) | 100% | 68% | 27% | 5% | 93% |
| R1 rank 1 unless a weak type | 67% | 83% | 9% | 2% | 76% |
| R1b first non-weak candidate | 67% | 83% | 9% | 2% | 76% |
| R2 rank 1 unless loss < 100cp | 81% | 72% | 18% | 4% | 81% |
| R3 R1b unless loss < 100cp | 64% | 83% | 9% | 2% | 72% |
| R2 rank 1 unless loss < 200cp | 52% | 76% | 10% | 2% | 54% |
| R3 R1b unless loss < 200cp | 44% | 85% | 5% | 1% | 51% |

## T: per-type hit table, rank-1 candidate (out of fold, threshold sweep)

| Policy | Coverage | Hit | Wrong: should abstain | Wrong: other was good | Recall |
| --- | ---: | ---: | ---: | ---: | ---: |
| threshold 0.0 | 100% | 68% | 27% | 5% | 93% |
| threshold 0.3 | 86% | 74% | 21% | 2% | 86% |
| threshold 0.4 | 72% | 83% | 10% | 2% | 82% |
| threshold 0.5 | 70% | 83% | 10% | 2% | 80% |
| threshold 0.6 | 69% | 84% | 9% | 2% | 79% |
| threshold 0.7 | 29% | 94% | 1% | 1% | 38% |
| threshold 0.8 | 25% | 97% | 0% | 0% | 33% |

## T': per-type hit table, best-scored candidate (out of fold, threshold sweep)

| Policy | Coverage | Hit | Wrong: should abstain | Wrong: other was good | Recall |
| --- | ---: | ---: | ---: | ---: | ---: |
| threshold 0.0 | 100% | 68% | 27% | 5% | 93% |
| threshold 0.3 | 93% | 71% | 23% | 5% | 90% |
| threshold 0.4 | 74% | 82% | 10% | 3% | 83% |
| threshold 0.5 | 73% | 82% | 10% | 3% | 82% |
| threshold 0.6 | 71% | 83% | 10% | 3% | 81% |
| threshold 0.7 | 32% | 90% | 2% | 2% | 39% |
| threshold 0.8 | 26% | 97% | 0% | 0% | 34% |

## L: logistic, rank-1 candidate (out of fold, threshold sweep)

| Policy | Coverage | Hit | Wrong: should abstain | Wrong: other was good | Recall |
| --- | ---: | ---: | ---: | ---: | ---: |
| threshold 0.0 | 100% | 68% | 27% | 5% | 93% |
| threshold 0.3 | 98% | 68% | 27% | 5% | 92% |
| threshold 0.4 | 87% | 73% | 21% | 3% | 87% |
| threshold 0.5 | 85% | 73% | 21% | 2% | 85% |
| threshold 0.6 | 74% | 81% | 12% | 2% | 82% |
| threshold 0.7 | 58% | 85% | 7% | 2% | 68% |
| threshold 0.8 | 27% | 95% | 0% | 1% | 35% |

## L': logistic, best-scored candidate (out of fold, threshold sweep)

| Policy | Coverage | Hit | Wrong: should abstain | Wrong: other was good | Recall |
| --- | ---: | ---: | ---: | ---: | ---: |
| threshold 0.0 | 100% | 68% | 27% | 5% | 93% |
| threshold 0.3 | 99% | 68% | 27% | 5% | 92% |
| threshold 0.4 | 88% | 72% | 21% | 3% | 87% |
| threshold 0.5 | 87% | 72% | 21% | 3% | 85% |
| threshold 0.6 | 75% | 80% | 12% | 3% | 82% |
| threshold 0.7 | 58% | 85% | 7% | 2% | 68% |
| threshold 0.8 | 27% | 95% | 0% | 1% | 35% |

## Same coverage as R1b, threshold chosen on the training folds only

| Policy | Coverage | Hit | Wrong: should abstain | Wrong: other was good | Recall |
| --- | ---: | ---: | ---: | ---: | ---: |
| R1b first non-weak candidate | 67% | 83% | 9% | 2% | 76% |
| T' nested | 71% | 83% | 10% | 3% | 81% |
| L' nested | 66% | 85% | 8% | 2% | 77% |

- T' minus R1b, paired bootstrap 95% CI: hit -2.8% to +2.1%; cards shown a bad reason -0.8% to +2.8%
- L' minus R1b, paired bootstrap 95% CI: hit -0.9% to +4.8%; cards shown a bad reason -3.7% to +0.7%

## Choice among two or more candidates (cards with a good one)

161 cards. Picks a good candidate:
- rank 1: 86%
- first non-weak (R1b, when it picks): 92%
- type table: 86%
- logistic: 85%
