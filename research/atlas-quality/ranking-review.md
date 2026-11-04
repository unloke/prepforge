# Ranking and calibration review

These are development comparisons over 38 saved studies / 45 side reports. Every source informed the method; there is no untouched quality holdout. The total describes demonstrated preparation, not chess strength or teaching quality. Low likes are never negative labels. See [content re-review](content-review.md) for sampled move evidence and failed assumptions.

## Controlled damage

Truncating every tree at eight relative plies increased 0/45 scores. Deleting the continuations of every fifth non-root own decision increased 0/45 scores. These transformations are deterministic and documented in calibrate-preparation.mjs; they test missing preparation, not whether authors are good or bad.

The first phase trial still rewarded truncating bbxmDYZV/black by 0.48 points. Horizon scoping alone did not fix it. Removing the second weighting of reply gaps and refusing depth credit for unanswered opponent moves fixes that counterexample. Frozen first-trial numbers are in calibration-baselines.json.

## Same-opening comparisons

| Broader example / compact example | Before | After | Interpretation |
| --- | --- | --- | --- |
| A4EBp7Ds / UzKIIAtz | 63.2 / 100.0 | 73.9 / 55.1 | French: explicit second-move sidelines versus mostly single chapter routes. |
| PDVt7Kbh / jtlLwUvh | 70.2 / 84.8 | 80.7 / 51.7 | Caro: branching two-knights/classical systems versus compact plans. |
| 2EaSmZtz / artuehhC | 72.2 / 94.1 | 79.2 / 75.8 | London: broader conditional repertoire versus connected narrower course/exercises; roles differ. |
| FwXo3Qhq / nYAJ7Km3 | 76.6 / 57.1 | 92.7 / 51.5 | Pirc: explicit Bc4/Be2/Bd3 and Nf3/e5 replies versus six compact chapters. |
| 1gqDv9cx / whCVdUeM | 47.0 / 74.4 | 70.8 / 76.7 | Stafford remains an ambiguity: broader investigation has less complete core routes; not a forced good/bad pair. |

## Sensitivity

Reach uses a smooth scale of four additional answered alternatives. Sensitivity is recorded rather than assumed: the London ordering flips at scale two, so that comparison is marginal, not validation of a definite quality preference. French/Caro/Pirc comparisons retain their direction at scales two and eight. The total contains no popularity fitting.

| Case | 16-ply bound | 24-ply bound | 32-ply bound |
| --- | --- | --- | --- |
| A4EBp7Ds | 90.3 | 81.6 | 73.9 |
| UzKIIAtz | 65.5 | 59.8 | 55.1 |
| PDVt7Kbh | 94.2 | 88.7 | 80.7 |
| jtlLwUvh | 73.1 | 59.7 | 51.7 |
| 1gqDv9cx | 88.1 | 78.5 | 70.8 |
| whCVdUeM | 90.0 | 82.6 | 76.7 |

The bound still matters for unresolved or undeveloped endpoints. A stable phase boundary makes completed openings independent of later game length, but short demonstration chapters cannot always be recognized from moves alone. The 32-ply bound avoids calling every long single line fully prepared at ply 16; it is not a validated universal opening length.

## All side reports

Sorted for inspection, not a universal quality leaderboard. Model-game collections and opening samplers have different intended scope. Likes are saved reception context; they do not enter the calculation.

| Study / side | Role | Likes | Before | After | Shortened | Missing replies |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| [Complete Repertoire](https://lichess.org/study/2XxhfIAJ) / white | repertoire | 36 | 57.2 | 97.7 | 45.4 | 39.7 |
| [London System Master Games!](https://lichess.org/study/GNlZ2WKx) / white | repertoire-and-model-games | 1425 | 82.3 | 96.4 | 40.9 | 40.0 |
| [English Opening Repertoire](https://lichess.org/study/fTpa2qZW) / white | repertoire | 7 | 74.8 | 96.2 | 43.8 | 37.5 |
| [My Repertoire Against e4: The Caro Kann Defense](https://lichess.org/study/yteYURRC) / black | repertoire-and-model-games | 11 | 56.8 | 95.9 | 43.7 | 34.9 |
| [Complete Repertoire](https://lichess.org/study/2XxhfIAJ) / black | repertoire | 36 | 73.8 | 95.1 | 48.8 | 34.9 |
| [Greatest Caro Kann: Living Repertoire](https://lichess.org/study/8Uztu7Xx) / black | repertoire-and-model-games | 1484 | 68.6 | 94.4 | 49.2 | 48.9 |
| [🌵  1. e4 Nc6 - A Nice Defense 🏆](https://lichess.org/study/sEo8o4Rm) / black | opening-guide | 122 | 71.0 | 93.9 | 44.4 | 28.0 |
| [Pirc Defense: Opening Repertoire for Black](https://lichess.org/study/FwXo3Qhq) / black | repertoire-and-traps | 52 | 76.6 | 92.7 | 41.6 | 31.4 |
| [White Repertoire](https://lichess.org/study/AKbQXhWw) / white | repertoire | 12 | 76.3 | 91.7 | 44.8 | 37.4 |
| [♦ All about the Sicilian Defense ♦](https://lichess.org/study/8c8bmUfy) / black | opening-guide | 34172 | 59.6 | 90.1 | 46.7 | 44.4 |
| [A Gambit Repertoire for White](https://lichess.org/study/D8QPC8Zr) / white | repertoire | 14 | 66.2 | 84.2 | 41.8 | 39.0 |
| [Caro-Kann Defense Repertoire](https://lichess.org/study/PDVt7Kbh) / black | repertoire | 9724 | 70.2 | 80.7 | 46.0 | 29.1 |
| [London System Repertoire](https://lichess.org/study/2EaSmZtz) / white | repertoire | 2615 | 72.2 | 79.2 | 42.3 | 44.8 |
| [Hippopotamus Defense](https://lichess.org/study/vPqdbuqZ) / black | repertoire-and-model-games | 35 | 78.8 | 77.5 | 38.7 | 26.5 |
| [répertoire 1500 élo avec les blancs (solide)](https://lichess.org/study/LLNDy032) / white | repertoire | 15 | 60.8 | 77.1 | 43.1 | 36.7 |
| [Stafford Gambit Traps](https://lichess.org/study/whCVdUeM) / black | repertoire-and-traps | 13621 | 74.4 | 76.7 | 22.4 | 22.4 |
| [Crush the Caro-Kann! White Repertoire](https://lichess.org/study/CfSYkcMp) / white | repertoire | 194 | 67.0 | 76.4 | 33.1 | 37.3 |
| [The London System (Lifetime Repertoire)](https://lichess.org/study/artuehhC) / white | repertoire-and-exercises | 10 | 94.1 | 75.8 | 36.2 | 30.3 |
| [Full Black Repertoire 1. d4 Nf6](https://lichess.org/study/dgUQNQ2B) / black | repertoire | 7 | 73.5 | 75.4 | 47.7 | 34.1 |
| [The Sicilian](https://lichess.org/study/NGpnogsw) / black | repertoire-and-model-games | 462 | 79.5 | 75.3 | 22.4 | 22.4 |
| [🍄 Ideas in the London System 🍄](https://lichess.org/study/KjivNw7F) / white | opening-guide | 26623 | 71.6 | 74.8 | 41.8 | 39.8 |
| [🏆Repertoire for the D4 PLAYER 🏆](https://lichess.org/study/bmWAylqe) / black | repertoire | 5860 | 68.0 | 74.3 | 47.7 | 30.8 |
| [French Defense Repertoire](https://lichess.org/study/A4EBp7Ds) / black | repertoire | 3682 | 63.2 | 73.9 | 44.4 | 32.3 |
| [🏆Repertoire for the D4 PLAYER 🏆](https://lichess.org/study/bmWAylqe) / white | repertoire | 5860 | 76.2 | 73.6 | 43.6 | 43.8 |
| [Openings](https://lichess.org/study/HHZpRszr) / white | opening-guide | 538 | 42.8 | 73.1 | 40.1 | 35.7 |
| [Openings](https://lichess.org/study/HHZpRszr) / black | opening-guide | 538 | 57.7 | 72.7 | 41.7 | 33.5 |
| [The Alien and Martian Gambits](https://lichess.org/study/tU7Nq5nE) / white | repertoire | 2899 | 100.0 | 71.0 | 20.9 | 37.8 |
| [Stafford Gambit](https://lichess.org/study/1gqDv9cx) / black | repertoire-and-traps | 33 | 47.0 | 70.8 | 38.7 | 30.6 |
| [🏆 Opening Systems YOU can USE in your games](https://lichess.org/study/oBsew7N6) / white | opening-guide | 691 | 97.9 | 69.8 | 36.2 | 23.0 |
| [✨Pirc/Czech System for Black: Lifetime Repertoire⁉️✨ 👀 🦾💖](https://lichess.org/study/nRiq9SZx) / black | repertoire-and-model-games | 59 | 54.4 | 69.1 | 45.2 | 35.9 |
| [King's Gambit / Full Repertoire](https://lichess.org/study/ACmyH8gC) / white | repertoire-and-model-games | 955 | 57.2 | 67.7 | 43.8 | 46.6 |
| [🏆 Opening Systems YOU can USE in your games](https://lichess.org/study/oBsew7N6) / black | opening-guide | 691 | 66.1 | 64.0 | 35.4 | 26.4 |
| [CRUSH the Ruy Lopez and Italian!](https://lichess.org/study/ztgulNGx) / black | repertoire | 3989 | 74.1 | 59.9 | 39.9 | 27.0 |
| [Jerome Gambit](https://lichess.org/study/8eyxyvBh) / white | repertoire-and-exercises | 22 | 80.3 | 59.4 | 20.9 | 20.9 |
| [🇫🇷  French Defense 🇫🇷](https://lichess.org/study/UzKIIAtz) / black | repertoire | 23669 | 100.0 | 55.1 | 32.7 | 20.9 |
| [Punishing 👊 Bad 😱 Openings ✌️](https://lichess.org/study/e01yoGqe) / black | repertoire-and-traps | 127 | 48.1 | 54.6 | 51.2 | 42.7 |
| [Smash the QGD with the Queen ATTACK!](https://lichess.org/study/rZyGzD67) / white | repertoire | 12 | 47.5 | 54.2 | 20.9 | 42.1 |
| [🇷🇺 Petrov Defense 🇷🇺](https://lichess.org/study/OnPMlzHT) / black | repertoire | 3331 | 77.9 | 53.3 | 32.7 | 25.0 |
| [🏰 Caro-Kann Defense🔥](https://lichess.org/study/jtlLwUvh) / black | repertoire | 50151 | 84.8 | 51.7 | 37.3 | 34.1 |
| [🔥🔥Pirc Defense Repertoire🔥🔥](https://lichess.org/study/nYAJ7Km3) / black | repertoire | 752 | 57.1 | 51.5 | 35.4 | 15.8 |
| [Punishing 👊 Bad 😱 Openings ✌️](https://lichess.org/study/e01yoGqe) / white | repertoire-and-traps | 127 | 46.7 | 47.0 | 38.7 | 34.3 |
| [List of Openings from Beginner to Grandmaster](https://lichess.org/study/2MMWpcNI) / black | opening-guide | 235 | 42.0 | 36.0 | 29.6 | 22.4 |
| [List of Openings from Beginner to Grandmaster](https://lichess.org/study/2MMWpcNI) / white | opening-guide | 235 | 72.5 | 29.9 | 22.6 | 22.8 |
| [🏆What is your Ideal Opening? 🤔](https://lichess.org/study/bbxmDYZV) / black | opening-guide | 12862 | 52.0 | 29.5 | 29.4 | 26.0 |
| [🏆What is your Ideal Opening? 🤔](https://lichess.org/study/bbxmDYZV) / white | opening-guide | 12862 | 26.2 | 26.6 | 26.4 | 20.6 |

| Pair | Scale 2 | Scale 4 | Scale 8 |
| --- | --- | --- | --- |
| A4EBp7Ds / UzKIIAtz | 75.1 / 65.2 | 73.9 / 55.1 | 71.7 / 44.0 |
| PDVt7Kbh / jtlLwUvh | 82.3 / 57.8 | 80.7 / 51.7 | 77.7 / 43.7 |
| 2EaSmZtz / artuehhC | 80.9 / 81.0 | 79.2 / 75.8 | 76.2 / 67.8 |
| FwXo3Qhq / nYAJ7Km3 | 95.2 / 59.5 | 92.7 / 51.5 | 88.1 / 42.1 |
| 1gqDv9cx / whCVdUeM | 71.4 / 79.5 | 70.8 / 76.7 | 69.5 / 71.9 |
