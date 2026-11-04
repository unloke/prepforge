# Facet validation

Targets were committed at c3554909 before candidate extraction/fitting. Frozen label SHA256: `187b56f83b62f52062a29a8a280e33db33089bf710145e62cdcdb965d0a4907a`.

Single Codex rater, previously exposed to scores. Sampled move inspection, about ±10-point target uncertainty. Leave-one-family-out evaluation covers nine groups; model/feature choices used these results, so this is exploratory development validation, not an untouched test set. Mixed studies overlap named opening families.

| Metric | Previous MAE | Family-held-out MAE (same available rows) | Previous ranking | Held-out ranking (same rows) |
| --- | ---: | ---: | ---: | ---: |
| replies | 26.1 | 11.2 | 72.5% | 84.6% |
| reach | 13.5 | 9.8 | 90.4% | 88.8% |
| depth | 14.1 | 11.7 | 81.7% | 81.8% |
| moveOrders | 34.4 | 10.1 | 75.7% | 81.8% |
| ease | 26.6 | 9.4 | 60.5% | 83.4% |
| overall | 10.6 | 10.2 | 85.2% | 86.8% |

MAE uses a 100-point scale. Ranking compares pairs whose judgments differ by at least 10 points, counts ties as incorrect, and is descriptive. Previous Consistency had 42 measured rows; all other comparisons have 45. The new Consistency model supplies 45 estimates; its all-row results are in the JSON report.

## Largest remaining held-out errors

- replies: 8eyxyvBh/white target 75, held-out 43; HHZpRszr/black target 45, held-out 73; rZyGzD67/white target 75, held-out 48.
- reach: e01yoGqe/white target 35, held-out 69; HHZpRszr/black target 45, held-out 72; e01yoGqe/black target 30, held-out 53.
- depth: HHZpRszr/white target 50, held-out 83; oBsew7N6/white target 65, held-out 96; oBsew7N6/black target 60, held-out 91.
- moveOrders: bbxmDYZV/black target 45, held-out 90; e01yoGqe/black target 35, held-out 63; CfSYkcMp/white target 90, held-out 66.
- ease: 8eyxyvBh/white target 35, held-out 9; NGpnogsw/black target 45, held-out 67; 2EaSmZtz/white target 80, held-out 58.
- overall: HHZpRszr/black target 40, held-out 70; HHZpRszr/white target 45, held-out 72; e01yoGqe/white target 35, held-out 61.

## Every reviewed side

Cells are **judgment / shipped fit / family-held-out prediction**. The shipped fit uses all development labels. Consult facet-judgments.json for five separate move-content rationales for every row.

| Study / side | Replies | Reach | Depth | Consistency | Ease | Preparation |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| [2EaSmZtz](https://lichess.org/study/2EaSmZtz) / white | 85 / 81 / 82 | 85 / 81 / 82 | 85 / 80 / 80 | 75 / 79 / 80 | 80 / 60 / 58 | 85 / 78 / 78 |
| [artuehhC](https://lichess.org/study/artuehhC) / white | 80 / 66 / 66 | 60 / 64 / 64 | 80 / 64 / 62 | 90 / 93 / 94 | 85 / 67 / 64 | 75 / 62 / 62 |
| [D8QPC8Zr](https://lichess.org/study/D8QPC8Zr) / white | 80 / 86 / 90 | 75 / 83 / 86 | 85 / 90 / 94 | 90 / 91 / 89 | 40 / 55 / 56 | 80 / 82 / 86 |
| [ACmyH8gC](https://lichess.org/study/ACmyH8gC) / white | 85 / 78 / 77 | 90 / 86 / 85 | 85 / 66 / 65 | 70 / 72 / 72 | 30 / 47 / 48 | 85 / 76 / 75 |
| [NGpnogsw](https://lichess.org/study/NGpnogsw) / black | 70 / 68 / 67 | 40 / 52 / 54 | 80 / 100 / 100 | 85 / 71 / 68 | 45 / 65 / 67 | 60 / 61 / 61 |
| [8Uztu7Xx](https://lichess.org/study/8Uztu7Xx) / black | 90 / 94 / 93 | 95 / 91 / 90 | 95 / 93 / 92 | 65 / 70 / 69 | 50 / 56 / 57 | 90 / 90 / 89 |
| [8c8bmUfy](https://lichess.org/study/8c8bmUfy) / black | 85 / 88 / 88 | 95 / 86 / 85 | 85 / 79 / 79 | 55 / 60 / 59 | 40 / 58 / 59 | 80 / 84 / 84 |
| [fTpa2qZW](https://lichess.org/study/fTpa2qZW) / white | 90 / 93 / 92 | 95 / 87 / 86 | 95 / 92 / 91 | 70 / 69 / 69 | 55 / 58 / 58 | 90 / 88 / 88 |
| [CfSYkcMp](https://lichess.org/study/CfSYkcMp) / white | 90 / 78 / 77 | 85 / 79 / 78 | 85 / 68 / 67 | 90 / 69 / 66 | 45 / 39 / 38 | 85 / 75 / 74 |
| [yteYURRC](https://lichess.org/study/yteYURRC) / black | 80 / 91 / 90 | 75 / 80 / 80 | 90 / 94 / 93 | 85 / 69 / 69 | 55 / 59 / 60 | 80 / 85 / 85 |
| [vPqdbuqZ](https://lichess.org/study/vPqdbuqZ) / black | 65 / 74 / 74 | 45 / 58 / 58 | 85 / 100 / 100 | 75 / 66 / 65 | 90 / 77 / 74 | 60 / 67 / 66 |
| [2XxhfIAJ](https://lichess.org/study/2XxhfIAJ) / white | 90 / 95 / 99 | 95 / 86 / 85 | 95 / 94 / 97 | 55 / 53 / 69 | 35 / 38 / 43 | 85 / 90 / 95 |
| [2XxhfIAJ](https://lichess.org/study/2XxhfIAJ) / black | 90 / 93 / 97 | 95 / 89 / 91 | 95 / 88 / 91 | 55 / 67 / 73 | 40 / 50 / 53 | 85 / 88 / 93 |
| [oBsew7N6](https://lichess.org/study/oBsew7N6) / white | 60 / 68 / 71 | 45 / 56 / 58 | 65 / 92 / 96 | 50 / 65 / 68 | 65 / 71 / 72 | 50 / 62 / 65 |
| [oBsew7N6](https://lichess.org/study/oBsew7N6) / black | 40 / 53 / 55 | 35 / 33 / 32 | 60 / 87 / 91 | 45 / 46 / 62 | 65 / 62 / 66 | 40 / 46 / 47 |
| [tU7Nq5nE](https://lichess.org/study/tU7Nq5nE) / white | 80 / 67 / 67 | 60 / 62 / 61 | 80 / 79 / 78 | 95 / 93 / 92 | 35 / 50 / 51 | 70 / 63 / 62 |
| [rZyGzD67](https://lichess.org/study/rZyGzD67) / white | 75 / 48 / 48 | 60 / 51 / 50 | 65 / 49 / 49 | 95 / 93 / 92 | 80 / 66 / 64 | 65 / 46 / 45 |
| [ztgulNGx](https://lichess.org/study/ztgulNGx) / black | 85 / 60 / 59 | 75 / 65 / 63 | 80 / 51 / 51 | 95 / 91 / 90 | 50 / 55 / 53 | 80 / 58 / 57 |
| [AKbQXhWw](https://lichess.org/study/AKbQXhWw) / white | 90 / 91 / 91 | 95 / 88 / 87 | 90 / 89 / 88 | 80 / 76 / 76 | 60 / 62 / 61 | 90 / 87 / 86 |
| [2MMWpcNI](https://lichess.org/study/2MMWpcNI) / white | 35 / 23 / 24 | 25 / 18 / 18 | 30 / 35 / 37 | 45 / 42 / 62 | 60 / 55 / 59 | 30 / 21 / 21 |
| [2MMWpcNI](https://lichess.org/study/2MMWpcNI) / black | 25 / 24 / 25 | 20 / 28 / 31 | 25 / 26 / 27 | 60 / 62 / 70 | 60 / 65 / 67 | 25 / 23 / 24 |
| [sEo8o4Rm](https://lichess.org/study/sEo8o4Rm) / black | 85 / 90 / 89 | 80 / 82 / 82 | 85 / 95 / 94 | 75 / 73 / 73 | 55 / 54 / 51 | 80 / 85 / 85 |
| [GNlZ2WKx](https://lichess.org/study/GNlZ2WKx) / white | 75 / 94 / 95 | 75 / 84 / 84 | 90 / 100 / 100 | 65 / 74 / 75 | 70 / 60 / 58 | 75 / 89 / 89 |
| [KjivNw7F](https://lichess.org/study/KjivNw7F) / white | 75 / 76 / 76 | 75 / 78 / 78 | 80 / 71 / 71 | 70 / 78 / 78 | 65 / 57 / 56 | 75 / 73 / 73 |
| [1gqDv9cx](https://lichess.org/study/1gqDv9cx) / black | 80 / 79 / 78 | 90 / 80 / 80 | 85 / 73 / 71 | 75 / 77 / 76 | 35 / 37 / 30 | 80 / 77 / 76 |
| [8eyxyvBh](https://lichess.org/study/8eyxyvBh) / white | 75 / 44 / 43 | 60 / 47 / 45 | 65 / 44 / 44 | 95 / 92 / 91 | 35 / 20 / 9 | 60 / 42 / 41 |
| [dgUQNQ2B](https://lichess.org/study/dgUQNQ2B) / black | 85 / 80 / 80 | 90 / 85 / 84 | 80 / 67 / 67 | 85 / 84 / 84 | 55 / 60 / 60 | 85 / 78 / 77 |
| [whCVdUeM](https://lichess.org/study/whCVdUeM) / black | 70 / 75 / 74 | 65 / 73 / 72 | 75 / 77 / 76 | 95 / 93 / 92 | 40 / 39 / 33 | 65 / 71 / 71 |
| [OnPMlzHT](https://lichess.org/study/OnPMlzHT) / black | 80 / 54 / 53 | 65 / 55 / 54 | 75 / 61 / 59 | 95 / 92 / 91 | 80 / 67 / 67 | 70 / 51 / 51 |
| [PDVt7Kbh](https://lichess.org/study/PDVt7Kbh) / black | 85 / 81 / 81 | 90 / 82 / 81 | 90 / 76 / 75 | 70 / 73 / 73 | 55 / 65 / 66 | 85 / 78 / 77 |
| [jtlLwUvh](https://lichess.org/study/jtlLwUvh) / black | 65 / 49 / 49 | 55 / 56 / 55 | 60 / 44 / 43 | 95 / 91 / 90 | 75 / 63 / 64 | 60 / 48 / 47 |
| [A4EBp7Ds](https://lichess.org/study/A4EBp7Ds) / black | 85 / 80 / 80 | 90 / 82 / 82 | 90 / 76 / 75 | 70 / 70 / 70 | 50 / 62 / 62 | 85 / 77 / 77 |
| [UzKIIAtz](https://lichess.org/study/UzKIIAtz) / black | 70 / 50 / 48 | 50 / 40 / 39 | 70 / 75 / 75 | 95 / 91 / 91 | 75 / 70 / 71 | 60 / 44 / 43 |
| [bbxmDYZV](https://lichess.org/study/bbxmDYZV) / white | 25 / 7 / 7 | 20 / 1 / 0 | 20 / 18 / 19 | 45 / 43 / 65 | 55 / 56 / 60 | 20 / 6 / 5 |
| [bbxmDYZV](https://lichess.org/study/bbxmDYZV) / black | 20 / 17 / 18 | 20 / 24 / 28 | 20 / 15 / 16 | 45 / 79 / 90 | 55 / 54 / 56 | 20 / 16 / 17 |
| [nRiq9SZx](https://lichess.org/study/nRiq9SZx) / black | 70 / 68 / 68 | 70 / 76 / 76 | 70 / 52 / 53 | 75 / 66 / 64 | 75 / 64 / 62 | 65 / 67 / 67 |
| [HHZpRszr](https://lichess.org/study/HHZpRszr) / white | 50 / 73 / 76 | 45 / 65 / 65 | 50 / 80 / 83 | 40 / 39 / 57 | 45 / 45 / 50 | 45 / 69 / 72 |
| [HHZpRszr](https://lichess.org/study/HHZpRszr) / black | 45 / 70 / 73 | 45 / 68 / 72 | 50 / 70 / 73 | 40 / 51 / 62 | 45 / 56 / 60 | 40 / 66 / 70 |
| [bmWAylqe](https://lichess.org/study/bmWAylqe) / white | 80 / 79 / 83 | 85 / 76 / 76 | 85 / 76 / 80 | 60 / 44 / 62 | 50 / 47 / 53 | 75 / 77 / 81 |
| [bmWAylqe](https://lichess.org/study/bmWAylqe) / black | 75 / 80 / 84 | 80 / 82 / 85 | 80 / 76 / 80 | 55 / 57 / 66 | 50 / 54 / 57 | 70 / 77 / 82 |
| [nYAJ7Km3](https://lichess.org/study/nYAJ7Km3) / black | 65 / 39 / 39 | 55 / 36 / 35 | 65 / 54 / 54 | 80 / 69 / 65 | 70 / 61 / 60 | 60 / 36 / 35 |
| [FwXo3Qhq](https://lichess.org/study/FwXo3Qhq) / black | 85 / 86 / 86 | 85 / 77 / 77 | 85 / 95 / 95 | 80 / 80 / 79 | 60 / 57 / 56 | 80 / 81 / 81 |
| [LLNDy032](https://lichess.org/study/LLNDy032) / white | 75 / 77 / 81 | 80 / 81 / 85 | 80 / 65 / 67 | 80 / 79 / 78 | 60 / 57 / 58 | 75 / 75 / 79 |
| [e01yoGqe](https://lichess.org/study/e01yoGqe) / white | 40 / 57 / 60 | 35 / 66 / 69 | 45 / 39 / 42 | 40 / 43 / 61 | 40 / 34 / 39 | 35 / 57 / 61 |
| [e01yoGqe](https://lichess.org/study/e01yoGqe) / black | 30 / 48 / 51 | 30 / 50 / 53 | 35 / 47 / 48 | 35 / 52 / 63 | 40 / 46 / 49 | 30 / 46 / 48 |
