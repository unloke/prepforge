# Deploy PrepForge Chess

PrepForge Chess is a FastAPI + Postgres SaaS (`prepforge_chess.api`): a multi-tenant
server that stores accounts, repertoires, and progress, and serves the built browser
SPA. Stockfish and Maia3 run **in the browser** (WASM / ONNX) — the server never
computes chess, so the deploy image carries no engine binaries.

## Render (current production setup)

The live deploy runs on Render's free tier.

1. Push this repository to GitHub.
2. In Render, choose **New > Blueprint** and select the repository. Render reads
   `render.yaml` and builds `Dockerfile`.
3. `render.yaml`'s `databases:` block is a blueprint *reference* — Render's free tier
   doesn't support blueprint-managed databases or `preDeployCommand`. Create the
   Postgres database separately in the dashboard, then set these manually on the web
   service:
   - `PREPFORGE_SECRET_KEY` — strong random value (signs sessions, CSRF tokens, and
     OAuth state). Required in production; the app refuses to boot with the dev
     default.
   - `DATABASE_URL` — the database's "Internal Database URL". `config.py` rewrites a
     bare `postgres://`/`postgresql://` scheme to `postgresql+psycopg://` (psycopg 3).
   - `PREPFORGE_ALLOWED_ORIGINS` — the service's own URL (CORS/CSRF origin allow-list),
     e.g. `https://prepforge-w0c5.onrender.com`. `render.yaml` ships a placeholder;
     override it here with the actual assigned Render URL.
   - `PREPFORGE_MAIA3_ASSET_BASE` — base URL for the ~45 MB Maia3 ONNX weights, hosted
     externally (Hugging Face) and stripped from the deploy image to keep it small.
     Without this, human-like move generation and Brilliant detection are unavailable;
     core analysis, Build, and Train still work.
   - Optional, enable as needed: `PREPFORGE_GOOGLE_CLIENT_ID` /
     `PREPFORGE_GOOGLE_CLIENT_SECRET` (Google sign-in), `PREPFORGE_STRIPE_SECRET_KEY` /
     `PREPFORGE_STRIPE_WEBHOOK_SECRET` / `PREPFORGE_STRIPE_PRICE_PRO` (billing),
     `PREPFORGE_SENTRY_DSN` (error reporting).
4. Migrations run automatically: the Dockerfile `CMD` runs `alembic upgrade head`
   before starting uvicorn, so a failed migration aborts the deploy before it serves
   traffic.

See `src/prepforge_chess/api/config.py` for the full list of settings and defaults.

## Local Docker check

```powershell
docker build -t prepforge-chess .
docker run --rm -p 8000:8000 prepforge-chess
```

Then open http://127.0.0.1:8000 — with no `DATABASE_URL` set, the app falls back to a
local SQLite file under `data/`.

## Local dev (no Docker)

```powershell
py -m pip install -e ".[server,dev]"
npm ci; npm run build
py -m alembic upgrade head
uvicorn prepforge_chess.api.main:app --reload
```

Open http://127.0.0.1:8000 (interactive API docs at `/docs`).

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
