# PrepForge Chess

PrepForge Chess is a **FastAPI + Postgres SaaS** for chess preparation. The server
stores accounts, repertoires, analyses, and training progress — it **never computes
chess**. Stockfish and Maia3 run **in the browser** (WASM / ONNX); the API classifies,
persists, and enforces per-user ownership.

The product covers:

- **Analyze** — PGN/Lichess import, move classification, eval graph, critical moments.
- **Build** — repertoire trees with objective (Stockfish) and human-like (Maia3) branches.
- **Train** — spaced repetition, mistake queues, Lichess practical-game matching.

Shared core models (`src/prepforge_chess/core/`, `services/`, `storage/`) back both the
web SPA and the optional CLI demos. See `docs/ARCHITECTURE.md` and `docs/ROADMAP.md`
for the full migration history and current status.

## Local development

**Python 3.11** is the project standard (CI and production both use 3.11). Windows
often defaults `python` to 3.8 — use `py -3.11` or the `.venv` below.

### Backend (recommended: uv + lock file)

```powershell
# Install uv once (https://docs.astral.sh/uv/) or: pip install uv
uv sync --extra server --extra dev    # installs from uv.lock into .venv
uv run pytest -q
uv run ruff check src tests
$env:DATABASE_URL="sqlite:///dev.sqlite3"
uv run alembic upgrade head
uvicorn prepforge_chess.api.main:app --reload
```

### Backend (pip + venv)

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e ".[server,dev]"
.\.venv\Scripts\python.exe -m pytest -q
```

### Frontend

```powershell
npm ci
npm test -- --run
npm run build    # emits SPA into src/prepforge_chess/web/static/
```

Open http://127.0.0.1:8000 after starting uvicorn (API docs at `/docs` in dev).

## Web app

The multi-tenant FastAPI app (`prepforge_chess.api`) serves the built SPA with
email/password accounts, CSRF protection, Lichess account linking, and Free/Pro
billing hooks. Production runs on Render against managed Postgres — see
`docs/DEPLOYMENT.md`, `render.yaml`, and `Dockerfile`.

```powershell
uv sync --extra server --extra dev   # or pip install -e ".[server,dev]"
npm ci; npm run build
uv run alembic upgrade head
uvicorn prepforge_chess.api.main:app --reload
```

## CLI (development / offline)

The `prepforge-chess` CLI exercises the same services without the web UI. Useful for
smoke tests, terminal viewers, and server-side Stockfish runs during development.

```powershell
uv sync --extra dev                  # core + pytest/ruff only
uv run prepforge-chess smoke
uv run prepforge-chess demo-viewer --ply 4
uv run prepforge-chess analyze-demo --depth 8
uv run prepforge-chess demo-build --depth 3 --max-nodes 12 --export
uv run prepforge-chess demo-train --seed 13
```

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

The analysis command prints a structured terminal report with summary, an ASCII eval curve, jump targets for key moments, and the move-by-move classification table. `MockEngine` is deterministic and intended for development only. Real analysis uses Stockfish scores, WDL-aware win probability loss, mate handling, and phase-aware thresholds instead of raw centipawn loss alone. The brilliant-move scorer combines the human model (Maia3) with the objective truth (Stockfish): a move is brilliant when it is hard for a human to find — a real sacrifice (by static exchange evaluation) or a move the Maia human model rates as unlikely — yet stays objectively strong. No Lc0 is involved. In the public/browser flow both Stockfish and Maia3 run in the browser; the server only classifies and persists.
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

The trainer service loads trainable lines from a repertoire tree, creates a saved random line order, resumes the latest session instead of re-randomizing it, keeps wrong moves on the same prompt, removes corrected mistakes, advances to the next prepared move, and persists session/progress state.

To install and use official Stockfish (CLI / server-side analysis only):

```powershell
prepforge-chess install-stockfish
prepforge-chess analyze-demo --engine stockfish --depth 8
prepforge-chess analyze-pgn path\to\game.pgn --engine stockfish --depth 10
```

The installer uses the official `official-stockfish/Stockfish` GitHub release assets and installs into `engines/stockfish/`, which is intentionally gitignored.

## Deployment

The full app needs a Python server (FastAPI + Postgres in production). GitHub Pages
cannot host `/api/*` — use Render (current production), Docker, or another container host.

- `Dockerfile` — SPA + API image; `alembic upgrade head` runs before uvicorn.
- `render.yaml` — Render Blueprint reference (free-tier notes inside).
- `docs/DEPLOYMENT.md` — env vars, Postgres setup, and local Docker check.

```powershell
docker build -t prepforge-chess .
docker run --rm -p 8000:8000 prepforge-chess
```

Roadmap and launch checklist: `docs/ROADMAP.md`.
