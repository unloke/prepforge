# PrepForge Chess

PrepForge Chess is a local-first chess preparation suite that combines:

- Game Analysis: PGN/Lichess import, Stockfish analysis, move classification, eval graph, and critical moment review.
- Opening Builder: repertoire tree generation using Stockfish for objective choices and Maia-style human move probabilities for practical branches.
- Opening Trainer: saved review sessions, mistake queues, spaced repetition, and Lichess game matching against all relevant repertoires.

The repository starts from a shared core architecture. Chess rules, FEN/PGN conversion, move records, engine results, opening nodes, and training progress are shared across every module instead of being duplicated in the UI.

## Current State

This is the first project baseline:

- Architecture document: `docs/ARCHITECTURE.md`
- SQLite schema: `src/prepforge_chess/storage/schema.sql`
- Core data models: `src/prepforge_chess/core/models.py`
- Phase 1 chess core: `src/prepforge_chess/core/chess_core.py`
- PGN import service: `src/prepforge_chess/services/pgn_import.py`
- UI-independent board contract: `src/prepforge_chess/ui/board_contract.py`
- SQLite initialization helper: `src/prepforge_chess/storage/database.py`
- SQLite repository layer: `src/prepforge_chess/storage/repositories.py`
- Stockfish process adapter and official release installer.
- Game analysis report service with eval curve and critical moment jump targets.
- Opening Builder tree generation, context-menu style operations, filters, and JSON/PGN export.
- Training session/progress persistence for saved random line order, mistakes, mastered nodes, and spaced repetition state.
- Service foundations for classification, brilliant scoring, matching, and practical game matching.

## Local Development

```powershell
py -m pip install -e .
py -m pytest
prepforge-chess smoke
prepforge-chess demo-viewer --ply 4
prepforge-chess analyze-demo --depth 8
prepforge-chess demo-build --depth 3 --max-nodes 12
prepforge-chess demo-build --depth 3 --max-nodes 12 --export
prepforge-chess demo-train --seed 13
prepforge-chess ui
```

The current core uses `python-chess` behind the `ChessCore` adapter. Future phases can add a UI layer, Stockfish process adapter, Maia model adapter, and Lichess API client behind the service boundaries already defined here.

The smoke command runs a minimal end-to-end check:

```text
PGN text -> ChessCore normalization -> SQLite save/load -> game navigation -> BoardState
```

The terminal viewer can render the built-in demo game or a PGN file:

```powershell
prepforge-chess demo-viewer --ply 4
prepforge-chess demo-viewer --interactive
prepforge-chess view-pgn path\to\game.pgn --ply 12
```

Interactive mode supports `n`/right for next, `p`/left for previous, number jump, and `q`.

The analysis pipeline can use either the deterministic `MockEngine` or a real
Stockfish UCI binary:

```powershell
prepforge-chess analyze-demo --depth 8
prepforge-chess analyze-pgn path\to\game.pgn --depth 8
prepforge-chess analyze-demo --engine stockfish --depth 8 --progress
prepforge-chess analyze-demo --engine stockfish --depth 8 --workers 2 --progress
```

The analysis command prints a structured terminal report with summary, an ASCII eval curve, jump targets for key moments, and the move-by-move classification table. `MockEngine` is deterministic and intended for development only. Real analysis uses Stockfish scores, WDL-aware win probability loss, mate handling, and phase-aware thresholds instead of raw centipawn loss alone. If an Lc0 binary and a Maia weight are available under `engines/lc0/`, the brilliant-move scorer marks a move brilliant when a human-like Maia net undervalues it at a glance (1-node search) but the objective Stockfish evaluation is high — i.e. a large "reveal" between the human first impression and the truth, with the move still sound. Download a Maia weight (and pick its strength) from Settings.
Analysis services also support progress callbacks and `CancellationToken`; the web UI uses those callbacks for the Analyze progress bar.
Use `--workers N` to split independent ply analysis across multiple engine workers. For Stockfish, each worker owns a separate UCI process; completion progress can arrive out of ply order, but final results are written back in game order.

Opening Builder foundation:

```powershell
prepforge-chess demo-build --depth 3 --max-nodes 12
prepforge-chess demo-build --engine stockfish --depth 2 --engine-depth 12 --max-nodes 6
prepforge-chess demo-build --depth 2 --max-nodes 8 --demo-operations
prepforge-chess demo-build --depth 2 --max-nodes 8 --filter human-likely
prepforge-chess demo-build --depth 3 --max-nodes 12 --export
prepforge-chess demo-build --depth 3 --max-nodes 12 --export-json out\demo-repertoire.json --export-pgn out\demo-mainline.pgn
```

The builder uses the real Maia3 adapter when the official CSSLab `maia3` package is installed, defaulting to the 23M model (`maia3-23m`, Hugging Face `UofTCSSLab/Maia3-23M`). If the package is not installed, it falls back to `MockMaia` so local tests and demos remain deterministic. To cache the 23M checkpoint explicitly:

```powershell
python -m pip install git+https://github.com/CSSLab/maia3.git
maia3-cache --model maia3-23m
```

Do not use old Maia/Maia2 files for this adapter.
The builder service already exposes context-menu style node operations: set mainline, mark prepared, add comment, add tag, disable/enable branch, and tree reports with filters.
Repertoires can now be exported as a full PrepForge JSON package for backup/import or as PGN mainline text for quick inspection. The JSON package stores full node metadata, UCI/SAN, FEN before/after, source labels, engine evaluations, Maia probability, comments, tags, and prepared/mainline flags.

Opening Trainer foundation:

```powershell
prepforge-chess demo-train --seed 13
prepforge-chess demo-train --seed 13 --mode high_priority
```

The trainer service loads trainable lines from a repertoire tree, creates a saved random line order, resumes the latest session instead of re-randomizing it, keeps wrong moves on the same prompt, removes corrected mistakes, advances to the next prepared move, and persists session/progress state in SQLite.

Local Web UI:

```powershell
prepforge-chess ui
prepforge-chess ui --port 8765 --db-path data\prepforge.sqlite3
```

The first web UI slice is available at `http://127.0.0.1:8765`. It exposes Dashboard, Analyze, Build, and Train workspaces backed by the same services as the CLI. Analyze supports pasted PGN text. The trainer hides prepared moves and line notation before the user answers, then reveals the expected move only after a wrong attempt. The UI has been browser-tested for dashboard loading, PGN analysis generation, move-row board navigation, demo repertoire generation, SVG piece rendering, trainer board-click move entry, correct move submission, and mistake retry.

To install and use official Stockfish:

```powershell
prepforge-chess install-stockfish
prepforge-chess analyze-demo --engine stockfish --depth 8
prepforge-chess analyze-pgn path\to\game.pgn --engine stockfish --depth 10
```

The installer uses the official `official-stockfish/Stockfish` GitHub release assets and installs into `engines/stockfish/`, which is intentionally gitignored.

## Deployment

PrepForge Chess needs a Python server for its API, SQLite persistence, and engine
integration, so the full app cannot run on GitHub Pages alone. GitHub can host
the source repository, then a container host such as Render, Fly.io, Railway, or
a VPS can run the actual web service.

This repository includes:

- `Dockerfile` for running the complete web UI and backend.
- `render.yaml` for Render Blueprint deployment from GitHub.
- `docs/DEPLOYMENT.md` with step-by-step deployment notes.

Local Docker check:

```powershell
docker build -t prepforge-chess .
docker run --rm -p 8765:8765 -v prepforge-data:/data prepforge-chess
```

## MVP Phases

1. Shared chess core and board model.
2. Stockfish-backed game analysis.
3. Opening Builder with repertoire tree generation.
4. Opening Trainer and Lichess practical matching.
