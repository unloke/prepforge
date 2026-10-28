# PrepForge Chess

Build your opening repertoire. Rehearse it. Check what happened over the board.

[Open PrepForge](https://prepforge-w0c5.onrender.com) · [Getting started](docs/getting-started.md) · [Documentation](docs/README.md) · [繁體中文](docs/README.zh-TW.md)

[![CI](https://github.com/unloke/prepforge/actions/workflows/ci.yml/badge.svg)](https://github.com/unloke/prepforge/actions/workflows/ci.yml)
[![License: AGPL-3.0-or-later](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue)](LICENSE)

![Repertoire workspace with a Caro-Kann position, opening branches and Explorer statistics](docs/assets/repertoire-desktop.png)

PrepForge is a chess preparation app that connects opening study, spaced repetition
and game review. Keep your lines in a repertoire, practice the moves you need to
remember, then compare your Lichess games with what you prepared.

Stockfish evaluates positions on your device. Maia3 estimates human move choices
at a selected playing strength. Both run in the browser.

## Prepare, play, review

### Build a repertoire

Create lines on the board or import a PGN. Edit branches, choose a mainline and
add comments and board annotations. Compare Masters and Players data in Explorer,
or consult the engine. Generate continuations from a position and use Coverage
to find missing replies, preview them and add the ones you want to prepare.

### Remember your moves

Train with an FSRS spaced repetition schedule. The Due queue brings together
moves to review; Rehearse follows your repertoire's lines; Practice lets you play
against Maia, Lichess Explorer or your own repertoire. Use hints, retry mistakes
or turn on timed Blitz training.

### Check your games

Games compares Lichess play with your repertoire and separates forgotten
preparation, opponent novelties and positions you have not covered. Jump to the
deviation, review the expected move or open the game in Analyze.

### Analyze a position in context

Paste a PGN and use Open PGN inside the field, or load a recent Lichess or practice
game. Run Review to review move classifications,
the evaluation graph and turning points. Expand Game Report for player accuracy
and phase statistics. Hover over its error chart to preview a position; click
to select it, or tap on a phone. Move between Coach references or Engine moves
to preview consecutive positions without returning to the game between them.

### Prepare for an opponent

Scout reads a player's Lichess games, filters by colour and time control, and
surfaces opening lines to investigate. Inspect a line, analyze it or add it to a
repertoire. Deep scan checks games for engine-detected mistakes and refutations.

### Share your preparation

Share a repertoire with people or teams using View only, Can copy or Can edit
roles. Public links allow viewing or copying, depending on the owner's setting.
Personal training progress belongs to the player.

<details>
<summary>Training and mobile screenshots</summary>

![Training home with the review queue, rehearsal and practice modes](docs/assets/train-desktop.png)

<img src="docs/assets/repertoire-mobile.png" alt="Repertoire workspace on a narrow mobile viewport" width="300">

</details>

Screenshots use demonstration data in the current app. See [capture details](docs/assets/README.md).

## Run locally

Use Python 3.11, Node.js 22 and [uv](https://docs.astral.sh/uv/).
From a checkout of this repository:

```sh
uv sync --python 3.11 --extra server --extra dev
npm ci
npm run build
uv run alembic upgrade head
uv run uvicorn prepforge_chess.api.main:app --reload
```

Open [localhost:8000](http://127.0.0.1:8000). Development API documentation is at
[/docs](http://127.0.0.1:8000/docs). SQLite is the local default; migrations create
the schema. Rebuild after changing `web-src/`.

Maia3 needs separately hosted model weights. Configure `PREPFORGE_MAIA3_ASSET_BASE`
using [.env.example](.env.example) and the [engine setup guide](docs/DEPLOYMENT.md#hugging-face-asset-pin-required-in-production).
The first engine use downloads browser assets; available memory and browser
support affect which engine profile can run. Engine pages need cross-origin
isolation, which the app's server supplies.

## Inside the app

| Component | Runs on | Role |
| --- | --- | --- |
| JavaScript SPA, built with Vite | Browser | Board, repertoire editor and workspaces |
| Stockfish (WASM) | Browser | Position evaluation and candidate lines |
| Maia3 (ONNX) | Browser | Human move predictions and practice opponent |
| FastAPI | Server | Accounts, validation, classification, sharing and sync |
| PostgreSQL / SQLite | Server | Repertoires, games, analyses and training progress |

Engine search and model inference run on the client. Accounts and saved work use
the API and database. Lichess provides game and Explorer data, and model weights
are fetched separately.

## Documentation and development

- [Getting started](docs/getting-started.md): your first repertoire, review session and game check.
- [Development](docs/development.md): setup, validation commands, source map and storage design.
- [Deployment](docs/DEPLOYMENT.md): Docker, production configuration, model hosting and operations.
- [Technical documentation](docs/README.md#implementation): engines, Scout ranking, persistence and ownership.

For bug reports and feature requests, [open an issue](https://github.com/unloke/prepforge/issues).
Include the workspace, steps to reproduce, expected result and browser; remove
private games or account details from attachments. For code changes, run the
[checks for the area you changed](docs/development.md#validation).

## License and credits

PrepForge Chess is licensed under [AGPL-3.0-or-later](LICENSE).
It uses [Stockfish](https://github.com/official-stockfish/Stockfish),
[Maia](https://www.maiachess.com/), [Lichess](https://lichess.org/),
[chess.js](https://github.com/jhlywa/chess.js),
[python-chess](https://github.com/niklasf/python-chess) and
[FSRS](https://github.com/open-spaced-repetition/py-fsrs).
