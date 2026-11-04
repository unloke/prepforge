# Public Lichess opening-study corpus

38 distinct real study exports; 724 chapters; 2,746,984 bytes.
No synthetic ablations count as studies. Every raw `.pgn` preserves original bytes, including comments.
Eight samples were copied byte-for-byte from prior review acquisitions; others were serial HTTP GETs.
`manifest.json` contains exact source URLs, author attributions, hashes, acquisition provenance,
scope/color/role, chapter lists, legal parse checks, and evidence limitations. `summary.json` gives totals.

## Integrity and use

All hashes and byte lengths were rechecked. No identical byte hashes or identical normalized
chapter-root-and-terminal-move-tree hashes occur. This does not prove genealogical independence:
authors may adapt each other's lines or share opening theory. Each study counts once, irrespective
of chapter count. This is a public English-heavy convenience sample, not a random population sample.
Model-game guides, exercises and opening samplers are explicitly distinguished from repertoires.
For mixed-color samples select the relevant chapters before assessment; do not score both colors as
one player's policy. First-variation order alone is not verified author intent.

Acquisition made one request at a time. HTTP failures are recorded in `acquisition_failures.json`.
The downloader immediately waits at least 60 seconds on HTTP 429 before any next request.
No retry or failed-response body is counted as a PGN. The raw PGNs were not comment-stripped.
Reproduce with `.venv313\Scripts\python.exe research\atlas-quality\acquire_corpus.py`
and finalize with `.venv313\Scripts\python.exe research\atlas-quality\acquire_finalize.py`.
The environment has python-chess 1.11.2. Rerunning skips manifest entries already acquired.

## Quality evidence without circular labels

No study is labelled good/bad from its title, length, popularity, author's rating or gambit identity.
`quality_label` stays null because whole-study expert quality has not been adjudicated.
Sampled move-quality labels and evidence are saved in `../evaluate-evidence.json`.
Legal moves and stored mating traps are
observable properties, not proof of soundness, completeness or learning effectiveness.
Source eval annotations are preserved but not independently verified by this acquisition agent.
The offline engine audit supplies diagnostic move-quality evidence.

An independent expert warning is available for the Stafford family: IM Eric Rosen describes
White's advantage with precise defense while teaching practical traps in
[his video description](https://lichess.org/video/nH_fiqlLp2U). This distinguishes objective
opening soundness from instructional quality; his trap study can teach its stated purpose well.
The Jerome study's own warning is an author claim, not independent validation.

The [comparison forum](https://lichess.org/forum/general-chess-discussion/how-much-do-leninperez-studies-matter)
supplied matched Caro-Kann and French pairs. Its claims of differing detail are disputed community
opinion, not accepted good/bad ground truth. This motivates inspecting actual moves and coverage
rather than inheriting popularity or author-status judgments.

## Inventory

| Study ID | Exported title | Side | Content role | Chapters | Move occurrences | Terminal paths |
|---|---|---|---|---:|---:|---:|
| 2EaSmZtz | London System Repertoire | white | repertoire | 18 | 705 | 80 |
| artuehhC | The London System (Lifetime Repertoire) | white | repertoire-and-exercises | 22 | 324 | 37 |
| D8QPC8Zr | A Gambit Repertoire for White | white | repertoire | 9 | 807 | 93 |
| ACmyH8gC | King's Gambit / Full Repertoire | white | repertoire-and-model-games | 38 | 1244 | 162 |
| NGpnogsw | The Sicilian | black | repertoire-and-model-games | 9 | 381 | 19 |
| 8Uztu7Xx | Greatest Caro Kann: Living Repertoire | black | repertoire-and-model-games | 64 | 22199 | 1627 |
| 8c8bmUfy | ♦ All about the Sicilian Defense ♦ | black | opening-guide | 21 | 4160 | 707 |
| fTpa2qZW | English Opening Repertoire | white | repertoire | 34 | 11393 | 1146 |
| CfSYkcMp | Crush the Caro-Kann! White Repertoire | white | repertoire | 17 | 636 | 106 |
| yteYURRC | My Repertoire Against e4: The Caro Kann Defense | black | repertoire-and-model-games | 11 | 1343 | 77 |
| vPqdbuqZ | Hippopotamus Defense | black | repertoire-and-model-games | 9 | 627 | 24 |
| 2XxhfIAJ | Complete Repertoire | both | repertoire | 31 | 30745 | 3411 |
| oBsew7N6 | 🏆 Opening Systems YOU can USE in your games | both | opening-guide | 8 | 185 | 45 |
| tU7Nq5nE | The Alien and Martian Gambits | white | repertoire | 10 | 108 | 8 |
| rZyGzD67 | Smash the QGD with the Queen ATTACK! | white | repertoire | 9 | 58 | 8 |
| ztgulNGx | CRUSH the Ruy Lopez and Italian! | black | repertoire | 12 | 170 | 15 |
| AKbQXhWw | White Repertoire | white | repertoire | 13 | 3384 | 248 |
| 2MMWpcNI | List of Openings from Beginner to Grandmaster | both | opening-guide | 9 | 53 | 7 |
| sEo8o4Rm | 🌵  1. e4 Nc6 - A Nice Defense 🏆 | black | opening-guide | 16 | 1152 | 73 |
| GNlZ2WKx | London System Master Games! | white | repertoire-and-model-games | 30 | 2177 | 93 |
| KjivNw7F | 🍄 Ideas in the London System 🍄 | white | opening-guide | 16 | 877 | 84 |
| 1gqDv9cx | Stafford Gambit | black | repertoire-and-traps | 23 | 1697 | 256 |
| 8eyxyvBh | Jerome Gambit | white | repertoire-and-exercises | 14 | 106 | 18 |
| dgUQNQ2B | Full Black Repertoire 1. d4 Nf6 | black | repertoire | 19 | 1737 | 231 |
| whCVdUeM | Stafford Gambit Traps | black | repertoire-and-traps | 10 | 249 | 27 |
| OnPMlzHT | 🇷🇺 Petrov Defense 🇷🇺 | black | repertoire | 8 | 64 | 8 |
| PDVt7Kbh | Caro-Kann Defense Repertoire | black | repertoire | 38 | 1665 | 83 |
| jtlLwUvh | 🏰 Caro-Kann Defense🔥 | black | repertoire | 7 | 64 | 7 |
| A4EBp7Ds | French Defense Repertoire | black | repertoire | 40 | 1523 | 85 |
| UzKIIAtz | 🇫🇷  French Defense 🇫🇷 | black | repertoire | 6 | 80 | 10 |
| bbxmDYZV | 🏆What is your Ideal Opening? 🤔 | both | opening-guide | 19 | 66 | 13 |
| nRiq9SZx | ✨Pirc/Czech System for Black: Lifetime Repertoire⁉️✨ 👀 🦾💖 | black | repertoire-and-model-games | 13 | 494 | 67 |
| HHZpRszr | Openings | both | opening-guide | 32 | 471 | 40 |
| bmWAylqe | 🏆Repertoire for the D4 PLAYER 🏆 | both | repertoire | 50 | 1592 | 115 |
| nYAJ7Km3 | 🔥🔥Pirc Defense Repertoire🔥🔥 | black | repertoire | 6 | 47 | 6 |
| FwXo3Qhq | Pirc Defense: Opening Repertoire for Black | black | repertoire-and-traps | 10 | 673 | 67 |
| LLNDy032 | répertoire 1500 élo avec les blancs (solide) | white | repertoire | 9 | 703 | 118 |
| e01yoGqe | Punishing 👊 Bad 😱 Openings ✌️ | both | repertoire-and-traps | 14 | 250 | 29 |
