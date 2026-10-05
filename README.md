# PrepForge Chess

PrepForge Chess is a **FastAPI + Postgres SaaS** for chess preparation. The server
stores accounts, repertoires, analyses, and training progress — it **never computes
chess**. Stockfish and Maia3 run **in the browser** (WASM / ONNX); the API classifies,
persists, and enforces per-user ownership.

The product covers:

- **Analyze** — PGN/Lichess import, move classification, eval graph, critical moments.
- **Build** — repertoire trees with objective (Stockfish) and human-like (Maia3) branches.
- **Train** — spaced repetition, mistake queues, Lichess practical-game matching.
- **Scout** — opponent opening reach (Module A) plus production **Scout v2** route
  selection (Module B). Experimental `?scoutV12=1` / `?scoutV13=1` paths are not
  production. Current selector and runtime boundaries: `docs/scout-production-ranking.md`.

Shared core models (`src/prepforge_chess/core/`, `services/`, `storage/`) back both the
web SPA and the optional CLI demos. Start with `docs/README.md` and
`docs/ARCHITECTURE.md` for the current implementation. Superseded plans and
checkpoints are in `docs/archive/`; they are historical context, not current instructions.

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

## Database

Production uses **compact storage** (SQLAlchemy Core; Postgres in production, SQLite
for local dev/tests). Alembic is the live schema authority (`alembic upgrade head`).

Authoritative on disk:

- **Game** — `initial_fen` + UCI sequence (`uci_blob`) + sparse per-ply annotations.
- **Positions** — catalog of full 6-field FENs (never a short hash).
- **Engine evaluations** — deduplicated by `(position, engine, depth, nodes, time_ms)`.
  Unset search limits persist as `UNSET_SEARCH_LIMIT` (`-1`) so UNIQUE is NULL-safe
  on both SQLite and Postgres.
- **SAN / FEN / PGN** — reconstructed on read; not stored as the source of truth.
- **Opening tree** — compact nodes (parent + arriving UCI) under a repertoire `root_fen`.

### Breaking schema

The old database schema is **not supported**. There is no legacy-data migration.

This project currently has no production users. Deploying this version should
**create / initialize the current schema** (`alembic upgrade head`). The compact
rebase drops and rebuilds domain chess tables; identity/auth tables are separate.

## Scout

Production Module B is **Scout v2** (`web-src/scout-selector.js`). The reach
pipeline in `web-src/scout.js` is Module A. Research and experimental Scout
paths are not part of the production contract.

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

## Operations

The CLI has been retired; Stockfish and Maia3 run in the browser and the server only
classifies and persists. The one remaining operational command is the data lifecycle
report (dry run by default, see `docs/DEPLOYMENT.md`):

```powershell
uv run python -m prepforge_chess.services.data_lifecycle
```

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
