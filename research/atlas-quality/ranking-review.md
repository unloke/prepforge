# Ranking and calibration review

These are development comparisons over 38 saved studies / 45 side reports. Every source informed the method; there is no untouched quality holdout. The total describes demonstrated preparation, not chess strength or teaching quality. Low likes are never negative labels. See [content re-review](content-review.md) for sampled move evidence and failed assumptions.

## Controlled damage

Truncating every tree at eight relative plies increased 0/45 scores. Deleting the continuations of every fifth non-root own decision increased 0/45 scores. These transformations are deterministic and documented in calibrate-preparation.mjs; they test missing preparation, not whether authors are good or bad.

Baseline values are frozen at bab295f5. Current formulas fit the independent move-content judgments in facet-judgments.json; see [per-facet targets and family validation](facet-validation.md) and [failure/revision review](facet-calibration-review.md). These are development judgments, not external expert labels.

## Same-opening comparisons

| Broader example / compact example | Before | After | Interpretation |
| --- | --- | --- | --- |
| A4EBp7Ds / UzKIIAtz | 73.9 / 55.1 | 77.0 / 44.4 | French: explicit second-move sidelines versus mostly single chapter routes. |
| PDVt7Kbh / jtlLwUvh | 80.7 / 51.7 | 78.4 / 47.5 | Caro: branching two-knights/classical systems versus compact plans. |
| 2EaSmZtz / artuehhC | 79.2 / 75.8 | 78.2 / 62.1 | London: broader conditional repertoire versus connected narrower course/exercises; roles differ. |
| FwXo3Qhq / nYAJ7Km3 | 92.7 / 51.5 | 81.1 / 35.9 | Pirc: explicit Bc4/Be2/Bd3 and Nf3/e5 replies versus six compact chapters. |
| 1gqDv9cx / whCVdUeM | 70.8 / 76.7 | 77.2 / 71.4 | Stafford: broader noncooperative defenses now outrank the narrower trap set; both are legitimate scoped resources. |

## Sensitivity

Coefficients were fitted at the 32-ply bound. Other bounds change the available evidence and are development sensitivity checks, not separately calibrated models. Stored branch weights are not opponent frequencies.

| Case | 16-ply bound | 24-ply bound | 32-ply bound |
| --- | --- | --- | --- |
| A4EBp7Ds | 74.1 | 78.6 | 77.0 |
| UzKIIAtz | 47.7 | 46.5 | 44.4 |
| PDVt7Kbh | 75.8 | 80.3 | 78.4 |
| jtlLwUvh | 53.6 | 49.8 | 47.5 |
| 1gqDv9cx | 75.1 | 78.1 | 77.2 |
| whCVdUeM | 71.4 | 71.8 | 71.4 |

The bound still matters for unresolved or undeveloped endpoints. A stable phase boundary makes completed openings independent of later game length, but short demonstration chapters cannot always be recognized from moves alone. The 32-ply bound avoids calling every long single line fully prepared at ply 16; it is not a validated universal opening length.

## All side reports

Sorted for inspection, not a universal quality leaderboard. Model-game collections and opening samplers have different intended scope. Likes are saved reception context; they do not enter the calculation.

| Study / side | Role | Likes | Before | After | Shortened | Missing replies |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| [Complete Repertoire](https://lichess.org/study/2XxhfIAJ) / white | repertoire | 36 | 97.7 | 90.4 | 56.1 | 58.5 |
| [Greatest Caro Kann: Living Repertoire](https://lichess.org/study/8Uztu7Xx) / black | repertoire-and-model-games | 1484 | 94.4 | 89.5 | 60.3 | 62.0 |
| [London System Master Games!](https://lichess.org/study/GNlZ2WKx) / white | repertoire-and-model-games | 1425 | 96.4 | 88.8 | 33.8 | 35.8 |
| [Complete Repertoire](https://lichess.org/study/2XxhfIAJ) / black | repertoire | 36 | 95.1 | 88.5 | 61.4 | 50.4 |
| [English Opening Repertoire](https://lichess.org/study/fTpa2qZW) / white | repertoire | 7 | 96.2 | 88.4 | 53.1 | 50.8 |
| [White Repertoire](https://lichess.org/study/AKbQXhWw) / white | repertoire | 12 | 91.7 | 87.1 | 51.6 | 49.2 |
| [My Repertoire Against e4: The Caro Kann Defense](https://lichess.org/study/yteYURRC) / black | repertoire-and-model-games | 11 | 95.9 | 85.5 | 42.5 | 25.7 |
| [🌵  1. e4 Nc6 - A Nice Defense 🏆](https://lichess.org/study/sEo8o4Rm) / black | opening-guide | 122 | 93.9 | 85.4 | 42.6 | 10.4 |
| [♦ All about the Sicilian Defense ♦](https://lichess.org/study/8c8bmUfy) / black | opening-guide | 34172 | 90.1 | 84.3 | 46.6 | 46.5 |
| [A Gambit Repertoire for White](https://lichess.org/study/D8QPC8Zr) / white | repertoire | 14 | 84.2 | 82.0 | 43.5 | 48.5 |
| [Pirc Defense: Opening Repertoire for Black](https://lichess.org/study/FwXo3Qhq) / black | repertoire-and-traps | 52 | 92.7 | 81.1 | 21.7 | 18.8 |
| [Caro-Kann Defense Repertoire](https://lichess.org/study/PDVt7Kbh) / black | repertoire | 9724 | 80.7 | 78.4 | 42.6 | 14.7 |
| [Full Black Repertoire 1. d4 Nf6](https://lichess.org/study/dgUQNQ2B) / black | repertoire | 7 | 75.4 | 78.3 | 50.4 | 44.0 |
| [London System Repertoire](https://lichess.org/study/2EaSmZtz) / white | repertoire | 2615 | 79.2 | 78.2 | 47.9 | 48.6 |
| [Stafford Gambit](https://lichess.org/study/1gqDv9cx) / black | repertoire-and-traps | 33 | 70.8 | 77.2 | 26.6 | 14.7 |
| [🏆Repertoire for the D4 PLAYER 🏆](https://lichess.org/study/bmWAylqe) / black | repertoire | 5860 | 74.3 | 77.1 | 59.3 | 43.9 |
| [French Defense Repertoire](https://lichess.org/study/A4EBp7Ds) / black | repertoire | 3682 | 73.9 | 77.0 | 46.2 | 18.4 |
| [🏆Repertoire for the D4 PLAYER 🏆](https://lichess.org/study/bmWAylqe) / white | repertoire | 5860 | 73.6 | 76.7 | 53.4 | 46.8 |
| [King's Gambit / Full Repertoire](https://lichess.org/study/ACmyH8gC) / white | repertoire-and-model-games | 955 | 67.7 | 76.1 | 41.8 | 54.9 |
| [Crush the Caro-Kann! White Repertoire](https://lichess.org/study/CfSYkcMp) / white | repertoire | 194 | 76.4 | 75.3 | 6.6 | 25.5 |
| [répertoire 1500 élo avec les blancs (solide)](https://lichess.org/study/LLNDy032) / white | repertoire | 15 | 77.1 | 74.6 | 53.4 | 43.9 |
| [🍄 Ideas in the London System 🍄](https://lichess.org/study/KjivNw7F) / white | opening-guide | 26623 | 74.8 | 73.4 | 45.1 | 41.1 |
| [Stafford Gambit Traps](https://lichess.org/study/whCVdUeM) / black | repertoire-and-traps | 13621 | 76.7 | 71.4 | 10.5 | 10.5 |
| [Openings](https://lichess.org/study/HHZpRszr) / white | opening-guide | 538 | 73.1 | 69.1 | 48.2 | 26.7 |
| [Hippopotamus Defense](https://lichess.org/study/vPqdbuqZ) / black | repertoire-and-model-games | 35 | 77.5 | 67.2 | 35.5 | 20.7 |
| [✨Pirc/Czech System for Black: Lifetime Repertoire⁉️✨ 👀 🦾💖](https://lichess.org/study/nRiq9SZx) / black | repertoire-and-model-games | 59 | 69.1 | 66.9 | 49.3 | 31.2 |
| [Openings](https://lichess.org/study/HHZpRszr) / black | opening-guide | 538 | 72.7 | 66.3 | 47.6 | 31.9 |
| [The Alien and Martian Gambits](https://lichess.org/study/tU7Nq5nE) / white | repertoire | 2899 | 71.0 | 62.6 | 7.0 | 17.1 |
| [🏆 Opening Systems YOU can USE in your games](https://lichess.org/study/oBsew7N6) / white | opening-guide | 691 | 69.8 | 62.4 | 40.8 | 10.6 |
| [The London System (Lifetime Repertoire)](https://lichess.org/study/artuehhC) / white | repertoire-and-exercises | 10 | 75.8 | 62.1 | 18.8 | 18.3 |
| [The Sicilian](https://lichess.org/study/NGpnogsw) / black | repertoire-and-model-games | 462 | 75.3 | 61.0 | 7.4 | 7.4 |
| [CRUSH the Ruy Lopez and Italian!](https://lichess.org/study/ztgulNGx) / black | repertoire | 3989 | 59.9 | 58.0 | 14.5 | 10.4 |
| [Punishing 👊 Bad 😱 Openings ✌️](https://lichess.org/study/e01yoGqe) / white | repertoire-and-traps | 127 | 47.0 | 57.2 | 47.4 | 39.0 |
| [🇷🇺 Petrov Defense 🇷🇺](https://lichess.org/study/OnPMlzHT) / black | repertoire | 3331 | 53.3 | 51.3 | 19.3 | 8.3 |
| [🏰 Caro-Kann Defense🔥](https://lichess.org/study/jtlLwUvh) / black | repertoire | 50151 | 51.7 | 47.5 | 23.5 | 21.8 |
| [🏆 Opening Systems YOU can USE in your games](https://lichess.org/study/oBsew7N6) / black | opening-guide | 691 | 64.0 | 46.3 | 27.4 | 14.1 |
| [Punishing 👊 Bad 😱 Openings ✌️](https://lichess.org/study/e01yoGqe) / black | repertoire-and-traps | 127 | 54.6 | 45.9 | 41.6 | 23.2 |
| [Smash the QGD with the Queen ATTACK!](https://lichess.org/study/rZyGzD67) / white | repertoire | 12 | 54.2 | 45.7 | 7.0 | 22.1 |
| [🇫🇷  French Defense 🇫🇷](https://lichess.org/study/UzKIIAtz) / black | repertoire | 23669 | 55.1 | 44.4 | 19.3 | 7.0 |
| [Jerome Gambit](https://lichess.org/study/8eyxyvBh) / white | repertoire-and-exercises | 22 | 59.4 | 41.9 | 9.8 | 9.8 |
| [🔥🔥Pirc Defense Repertoire🔥🔥](https://lichess.org/study/nYAJ7Km3) / black | repertoire | 752 | 51.5 | 35.9 | 9.4 | 5.3 |
| [List of Openings from Beginner to Grandmaster](https://lichess.org/study/2MMWpcNI) / black | opening-guide | 235 | 36.0 | 22.8 | 20.3 | 11.5 |
| [List of Openings from Beginner to Grandmaster](https://lichess.org/study/2MMWpcNI) / white | opening-guide | 235 | 29.9 | 20.8 | 16.8 | 5.9 |
| [🏆What is your Ideal Opening? 🤔](https://lichess.org/study/bbxmDYZV) / black | opening-guide | 12862 | 29.5 | 16.2 | 16.2 | 14.9 |
| [🏆What is your Ideal Opening? 🤔](https://lichess.org/study/bbxmDYZV) / white | opening-guide | 12862 | 26.6 | 5.6 | 5.6 | 4.0 |
