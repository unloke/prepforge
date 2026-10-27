# Development

[Documentation](README.md) · [Project home](../README.md)

## Local setup

CI and production use Python 3.11; CI uses Node.js 22. Install
[uv](https://docs.astral.sh/uv/), then run from the repository root:

```sh
uv sync --python 3.11 --extra server --extra dev
npm ci
npm run build
uv run alembic upgrade head
uv run uvicorn prepforge_chess.api.main:app --reload
```

Open [localhost:8000](http://127.0.0.1:8000). The development API reference is at
[/docs](http://127.0.0.1:8000/docs); [/healthz](http://127.0.0.1:8000/healthz)
reports server health.

Configuration loads from the environment and `.env`. See [.env.example](../.env.example)
for settings and [config.py](../src/prepforge_chess/api/config.py) for defaults.
The default database is `data/prepforge_api.sqlite3`. To choose another local
database in PowerShell, set this before running migrations and the server:

```powershell
$env:DATABASE_URL = "sqlite:///dev.sqlite3"
```

Maia3 model weights are hosted separately. Set `PREPFORGE_MAIA3_ASSET_BASE` to the
pinned URL in [.env.example](../.env.example). The
[deployment guide](DEPLOYMENT.md#hugging-face-asset-pin-required-in-production)
covers model hosting and pinning.

### Frontend iteration

`npm run build` writes the served SPA to `src/prepforge_chess/web/static/`.
That directory is ignored by Git. Rebuild after every `web-src/` change when
using the Python server, static-serving tests or browser smokes.

For Vite hot reload, start the API on the port expected by the development proxy:

```sh
uv run uvicorn prepforge_chess.api.main:app --reload --port 8765
```

In another terminal:

```sh
npm run dev
```

Open [localhost:5173/static/](http://127.0.0.1:5173/static/).
Vite proxies `/api` and `/oauth` to port 8765 and supplies COOP/COEP headers for
browser engines. The Python server supplies those headers for the built app.

### Without uv

On Windows, use Python 3.11 explicitly:

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e ".[server,dev]"
npm ci
npm run build
.\.venv\Scripts\python.exe -m alembic upgrade head
.\.venv\Scripts\python.exe -m uvicorn prepforge_chess.api.main:app --reload
```

## Validation

Run checks that cover the change. The [CI workflow](../.github/workflows/ci.yml)
defines the merge checks, including PostgreSQL, browser engines and Docker.

| Area | Command |
| --- | --- |
| Python behavior | `uv run pytest -q` |
| Python lint | `uv run ruff check src tests` |
| JavaScript behavior | `npm test` |
| JavaScript lint | `npm run lint:js` |
| Production frontend | `npm run build` |
| Workspace layouts | `npm run smoke:ui-v2` (build first; requires a Chromium browser) |
| Browser Stockfish | `npm run smoke:stockfish` |

Research tests are separate: `npm run test:research`. The default Python suite
excludes browser E2E tests; CI runs those with Playwright and Chromium installed.
See the workflow for the selected E2E commands and service setup.

## Source map

| Location | Contents |
| --- | --- |
| `web-src/` | SPA source, views, controllers and browser engines |
| `src/prepforge_chess/api/` | FastAPI routes, authentication and runtime configuration |
| `src/prepforge_chess/core/` | Shared chess models |
| `src/prepforge_chess/services/` | Classification, scheduling and application services |
| `src/prepforge_chess/storage/` | Database access and compact storage |
| `migrations/` | Alembic schema migrations |
| `tests/` | Python tests and browser E2E tests |
| `scripts/` | Asset sync, browser checks and operational tooling |

The CLI is retired. The remaining operational module reports data lifecycle
actions and defaults to a dry run:

```sh
uv run python -m prepforge_chess.services.data_lifecycle
```

## Storage and engine boundaries

FastAPI stores accounts, repertoires, analyses and training progress. Browser
Stockfish and Maia3 perform chess search and model inference; the API validates,
classifies and persists their results.

Alembic defines the live schema. Use `alembic upgrade head` through the project
environment to initialize it. Production uses PostgreSQL; local development
and most tests use SQLite.

- Games store `initial_fen`, a UCI sequence in `uci_blob` and sparse per-ply annotations.
- Positions use full six-field FENs.
- Engine evaluations are deduplicated by position, engine and search limits.
  Unset limits use `UNSET_SEARCH_LIMIT` (`-1`) so uniqueness works across both databases.
- SAN, FEN sequences and PGN are reconstructed on read.
- Repertoire nodes store a parent and arriving UCI move under `root_fen`.

See [backend consistency](backend-consistency.md),
[browser engines](browser-engine-migration.md) and
[training ownership](compare-identity-boundary.md) for the relevant contracts.
Production Scout behavior is described in [Scout ranking](scout-production-ranking.md);
experimental selectors are not the default product.

## Deployment

The [Dockerfile](../Dockerfile) builds the frontend and API together, runs
migrations, then starts the server. Local image check:

```sh
docker build -t prepforge-chess .
docker run --rm -p 8000:8000 prepforge-chess
```

For production, follow [Deployment](DEPLOYMENT.md) for PostgreSQL, secrets,
allowed origins, model assets, persistent data and backups. The full application
needs an API server; GitHub Pages can only host static content.
