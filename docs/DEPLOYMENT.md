# Deploy PrepForge Chess

PrepForge Chess is a FastAPI + Postgres SaaS (`prepforge_chess.api`): a multi-tenant
server that stores accounts, repertoires, and progress, and serves the built browser
SPA. Stockfish and Maia3 run **in the browser** (WASM / ONNX) — the server never
computes chess, so the deploy image carries no engine binaries.

## Render (current production setup)

The live deploy runs on Render's **free tier**.

### Free-tier caveats

- `render.yaml`'s `databases:` block is a blueprint *reference* — on free tier you may
  need to create the Postgres database separately in the dashboard and wire
  `DATABASE_URL` manually on the web service.
- `preDeployCommand` requires a paid plan. Migrations instead run inside the
  Dockerfile `CMD` (`alembic upgrade head` before uvicorn), so a failed migration
  aborts the deploy before traffic is served.

### Deploy steps

1. Push this repository to GitHub.
2. In Render, choose **New > Blueprint** and select the repository. Render reads
   `render.yaml` and builds `Dockerfile`.
3. Create a **free Postgres** database in the Render dashboard (if the blueprint does
   not provision one automatically).
4. Set these env vars on the **web service** (dashboard overrides blueprint placeholders):

   | Variable | Required | Notes |
   |----------|----------|-------|
   | `PREPFORGE_SECRET_KEY` | **Yes** | Strong random value (sessions, CSRF, OAuth state). App refuses the dev default in production. Generate: `python -c "import secrets; print(secrets.token_urlsafe(48))"` |
   | `DATABASE_URL` | **Yes** | Postgres **Internal Database URL**. `config.py` rewrites `postgres://` → `postgresql+psycopg://`. |
   | `PREPFORGE_ALLOWED_ORIGINS` | **Yes** | Service's own URL for CORS/CSRF, e.g. `https://prepforge-w0c5.onrender.com`. |
   | `PREPFORGE_MAIA3_ASSET_BASE` | Recommended | Base URL for ~45 MB Maia3 ONNX weights (Hugging Face). Without it, Brilliant detection and human-like Build branches are unavailable; Analyze/Train core still work. |
   | `PREPFORGE_ENGINE_ASSET_BASE` | Recommended | Base URL for Stockfish/ORT `.wasm` (~31 MB). Injected as `window.__ENGINE_ASSET_BASE`; unset → `/static/engine/` fallback. See `docs/stability-perf-plan.md` #3. |
   | `PREPFORGE_STRIPE_SECRET_KEY` | For billing | Stripe secret key. |
   | `PREPFORGE_STRIPE_WEBHOOK_SECRET` | For billing | Stripe webhook signing secret. |
   | `PREPFORGE_STRIPE_PRICE_PRO` | For billing | Stripe Price ID for Pro plan. |
   | `PREPFORGE_GOOGLE_CLIENT_ID` | Optional | Google OAuth sign-in. |
   | `PREPFORGE_GOOGLE_CLIENT_SECRET` | Optional | Google OAuth sign-in. |
   | `PREPFORGE_SENTRY_DSN` | Optional | Error reporting (dark-by-default). |

5. Deploy. Confirm `/healthz` returns OK and the SPA loads with
   `crossOriginIsolated === true` (COOP/COEP headers for WASM engines).

### Post-deploy checklist

- [ ] `/healthz` ok; logs show uvicorn/FastAPI.
- [ ] Register → reload → still signed in; session cookie is `Secure`/`HttpOnly`.
- [ ] Unsafe POST without `X-CSRF-Token` → 403.
- [ ] Create repertoire, analyze a game, run a train session.
- [ ] Lichess OAuth redirect works (if enabled).
- [ ] **DB backups** enabled in Render dashboard (free-tier policy — confirm retention).
- [ ] External uptime monitor on `/healthz` (optional).

See `src/prepforge_chess/api/config.py` for the full settings list and defaults.

## Local development

**Python 3.11** is required for server work (CI and production match). Use a project
venv so Windows' default Python 3.8 does not shadow the install.

### Option A — uv (recommended)

```powershell
uv sync --extra server --extra dev    # from uv.lock into .venv
npm ci; npm run build
$env:DATABASE_URL="sqlite:///dev.sqlite3"   # optional; SQLite is the dev default
uv run alembic upgrade head
uvicorn prepforge_chess.api.main:app --reload
```

### Option B — pip + venv

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e ".[server,dev]"
npm ci; npm run build
.\.venv\Scripts\python.exe -m alembic upgrade head
uvicorn prepforge_chess.api.main:app --reload
```

Open http://127.0.0.1:8000 (interactive API docs at `/docs`).

### Quality gates (match CI)

```powershell
uv run ruff check src tests
uv run pytest -q
$env:DATABASE_URL="sqlite:///ci_alembic.sqlite3"
uv run alembic upgrade head
uv run alembic check
npm test -- --run
npm run build
node scripts/check-bundle-size.mjs
```

## Local Docker check

```powershell
docker build -t prepforge-chess .
docker run --rm -p 8000:8000 prepforge-chess
```

Then open http://127.0.0.1:8000 — with no `DATABASE_URL` set, the app falls back to a
local SQLite file under `data/`.

## Manual GitHub upload

If you do not want to push with git, upload the repository files to GitHub using
the web UI. Do not upload local-only folders such as `data/`, `engines/`, `build/`,
`.venv/`, `.pytest_cache/`, `.ruff_cache/`, or `web-src/public/maia3/` (git-ignored
Maia3 weights).

## About GitHub Pages

GitHub Pages can host a marketing/demo or redirect page, but it cannot run this app's
`/api/...` endpoints — accounts, repertoires, Stockfish/Maia3 asset hosting, OAuth, and
billing all depend on the FastAPI server. A Pages-only deployment isn't possible
without removing those features.
