# Reason selector: offline evaluation

360 labelled cards (sol, candidate level), 696 candidates; 280 cards have a good (correct and main) candidate; 240 have two or more candidates; 318 have every candidate correct.

Rates are weighted to the pool's mix (among cards with a candidate: one candidate 59%, two or more 41%); the 27% of error cards with no candidate stay bare under every policy, so pool coverage = coverage x 0.73. Wrong = shown a reason that is not good: 'should abstain' when no candidate on the card is good, 'other was good' when another one was.

## Rules

| Policy | Coverage | Hit | Wrong: should abstain | Wrong: other was good | Recall |
| --- | ---: | ---: | ---: | ---: | ---: |
| oracle | 72% | 100% | 0% | 0% | 100% |
| R0 current Coach (rank 1, always) | 100% | 66% | 28% | 5% | 92% |
| R1 rank 1 unless a weak type | 68% | 79% | 11% | 3% | 75% |
| R1b first non-weak candidate | 68% | 79% | 11% | 3% | 75% |
| R2 rank 1 unless loss < 100cp | 82% | 70% | 20% | 5% | 79% |
| R3 R1b unless loss < 100cp | 65% | 79% | 11% | 3% | 71% |
| R2 rank 1 unless loss < 200cp | 54% | 72% | 12% | 3% | 54% |
| R3 R1b unless loss < 200cp | 46% | 81% | 7% | 2% | 52% |

## T: per-type hit table, rank-1 candidate (out of fold, threshold sweep)

| Policy | Coverage | Hit | Wrong: should abstain | Wrong: other was good | Recall |
| --- | ---: | ---: | ---: | ---: | ---: |
| threshold 0.0 | 100% | 66% | 28% | 5% | 92% |
| threshold 0.3 | 88% | 71% | 22% | 4% | 86% |
| threshold 0.4 | 76% | 76% | 15% | 3% | 80% |
| threshold 0.5 | 71% | 80% | 11% | 3% | 80% |
| threshold 0.6 | 68% | 81% | 10% | 3% | 77% |
| threshold 0.7 | 27% | 92% | 1% | 1% | 35% |
| threshold 0.8 | 25% | 93% | 1% | 1% | 32% |

## T': per-type hit table, best-scored candidate (out of fold, threshold sweep)

| Policy | Coverage | Hit | Wrong: should abstain | Wrong: other was good | Recall |
| --- | ---: | ---: | ---: | ---: | ---: |
| threshold 0.0 | 100% | 66% | 28% | 6% | 92% |
| threshold 0.3 | 94% | 68% | 24% | 6% | 89% |
| threshold 0.4 | 80% | 74% | 16% | 5% | 82% |
| threshold 0.5 | 74% | 79% | 12% | 4% | 81% |
| threshold 0.6 | 71% | 80% | 11% | 4% | 79% |
| threshold 0.7 | 29% | 90% | 2% | 1% | 36% |
| threshold 0.8 | 25% | 91% | 1% | 1% | 32% |

## L: logistic, rank-1 candidate (out of fold, threshold sweep)

| Policy | Coverage | Hit | Wrong: should abstain | Wrong: other was good | Recall |
| --- | ---: | ---: | ---: | ---: | ---: |
| threshold 0.0 | 100% | 66% | 28% | 5% | 92% |
| threshold 0.3 | 95% | 68% | 25% | 5% | 90% |
| threshold 0.4 | 89% | 70% | 22% | 4% | 87% |
| threshold 0.5 | 82% | 73% | 19% | 3% | 83% |
| threshold 0.6 | 72% | 79% | 12% | 3% | 79% |
| threshold 0.7 | 61% | 82% | 8% | 2% | 69% |
| threshold 0.8 | 24% | 94% | 1% | 1% | 31% |

## L': logistic, best-scored candidate (out of fold, threshold sweep)

| Policy | Coverage | Hit | Wrong: should abstain | Wrong: other was good | Recall |
| --- | ---: | ---: | ---: | ---: | ---: |
| threshold 0.0 | 100% | 66% | 28% | 6% | 91% |
| threshold 0.3 | 96% | 67% | 25% | 6% | 89% |
| threshold 0.4 | 91% | 69% | 23% | 5% | 87% |
| threshold 0.5 | 84% | 72% | 19% | 4% | 84% |
| threshold 0.6 | 74% | 78% | 12% | 4% | 80% |
| threshold 0.7 | 61% | 82% | 9% | 3% | 69% |
| threshold 0.8 | 24% | 94% | 1% | 1% | 31% |

## Same coverage as R1b, threshold chosen on the training folds only

| Policy | Coverage | Hit | Wrong: should abstain | Wrong: other was good | Recall |
| --- | ---: | ---: | ---: | ---: | ---: |
| R1b first non-weak candidate | 68% | 79% | 11% | 3% | 75% |
| T' nested | 70% | 80% | 10% | 3% | 78% |
| L' nested | 69% | 80% | 11% | 3% | 77% |

- T' minus R1b, paired bootstrap 95% CI: hit -1.1% to +2.7%; cards shown a bad reason -1.4% to +1.1%
- L' minus R1b, paired bootstrap 95% CI: hit -1.2% to +2.8%; cards shown a bad reason -1.8% to +1.2%

## Choice among two or more candidates (cards with a good one)

205 cards. Picks a good candidate:
- rank 1: 84%
- first non-weak (R1b, when it picks): 88%
- type table: 83%
- logistic: 82%
