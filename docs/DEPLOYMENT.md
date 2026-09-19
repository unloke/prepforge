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

### Breaking schema (compact storage)

Alembic head `c7e8f9a0b1c2` rebuilds domain chess tables into the compact
representation (`games.uci_blob`, `positions`, deduplicated `engine_evaluations`,
sparse `moves` / `opening_nodes`). There is **no legacy-data migration**.

The old schema is not supported. This deploy currently has no real user data —
`alembic upgrade head` (Dockerfile `CMD`) should initialize the **current**
schema. Identity/auth/billing tables are not part of that rebuild. If a previous
environment still has the old domain tables, the upgrade drops and recreates
them; do not expect old games/repertoires to survive.

### Post-deploy checklist

- [ ] `/healthz` ok; logs show uvicorn/FastAPI.
- [ ] Register → reload → still signed in; session cookie is `Secure`/`HttpOnly`.
- [ ] Unsafe POST without `X-CSRF-Token` → 403.
- [ ] Create repertoire, analyze a game, run a train session.
- [ ] Lichess OAuth redirect works (if enabled).
- [ ] **DB backups** — see [Database backups](#database-backups) below.
- [ ] **Uptime monitoring** — see [External uptime monitoring](#external-uptime-monitoring) below.
- [ ] **Engine CDN** — `npm run smoke:prod-engine` passes (`crossOriginIsolated`, ORT wasm from HF).
- [ ] **HF asset pins** — View Source shows `resolve/<sha>/`, not `resolve/main/` (see below).

See `src/prepforge_chess/api/config.py` for the full settings list and defaults.

### Hugging Face asset pin (required in production)

Both `PREPFORGE_MAIA3_ASSET_BASE` and `PREPFORGE_ENGINE_ASSET_BASE` must use a **commit
hash URL**, not `/resolve/main/`. Branch refs can drift silently when files are re-uploaded.

Current pinned commit (Andy108/prepforge-maia3 HEAD as of 2026-06-17):

```
https://huggingface.co/Andy108/prepforge-maia3/resolve/77fcb55654f1fad83ee9e987b973ddee7d7fa459/
```

Set both env vars in the Render dashboard to that base (with trailing slash). No rebuild
needed — only a service restart. Re-pin when you upload new ONNX/WASM artifacts.

### Database backups

Render **free-tier Postgres** does not include automatic point-in-time recovery. As of
2026-09, PrepForge uses `.github/workflows/postgres-backup.yml` instead: a daily GitHub
Actions job creates a compressed custom-format dump and stores it in a private Backblaze
B2 bucket. B2's first 10 GB is free; monitor usage so the account remains within that
allowance.

The job validates every archive with `pg_restore --list`, restores it into an isolated
PostgreSQL 16 service, checks the restored schema and Alembic revision, uploads the dated
object, verifies it with `head-object`, and retains approximately 14 days. The private
bucket also contains `postgres/latest.json`, whose key and SHA-256 identify the latest
verified snapshot. Dumps are never uploaded as GitHub artifacts or committed to Git.

#### One-time setup

1. Create a **private** B2 bucket. Keep object lock off unless you deliberately want
   immutable retention; the workflow must be able to delete expired objects.
2. Create a bucket-scoped B2 application key with list, read, write, and delete access.
   Do not use the account master key. Optionally add a bucket lifecycle rule as a second
   guardrail that deletes `postgres/daily/` objects after 14 days.
3. Copy the production database's externally reachable connection URL. The live service
   currently uses a Neon PostgreSQL pooler URL; a Render Internal Database URL would be
   unreachable from GitHub-hosted runners.
4. Add these repository Actions secrets (Settings → Secrets and variables → Actions):

   | Secret | Value |
   |--------|-------|
   | `PROD_DATABASE_EXTERNAL_URL` | Externally reachable production PostgreSQL URL |
   | `B2_ENDPOINT` | Bucket S3 endpoint, e.g. `https://s3.us-west-004.backblazeb2.com` |
   | `B2_REGION` | Region from that endpoint, e.g. `us-west-004` |
   | `B2_BUCKET` | Private bucket name |
   | `B2_KEY_ID` | Bucket-scoped application key ID |
   | `B2_APPLICATION_KEY` | Application key shown once at creation |

5. Merge the workflow to the default branch, open Actions → PostgreSQL backup → Run
   workflow, and confirm the dump, restore smoke, upload, and retention steps succeed.
6. In B2, confirm the dated object and `postgres/latest.json` exist and the bucket is
   private. Download the dated object once and compare its SHA-256 to the pointer.

#### Recovery

Download the object named by `postgres/latest.json`, verify its SHA-256, and restore into
an empty database before redirecting production traffic:

```bash
aws --endpoint-url "$B2_ENDPOINT" --region "$B2_REGION" \
  s3 cp "s3://$B2_BUCKET/$BACKUP_KEY" prepforge.dump
echo "$BACKUP_SHA256  prepforge.dump" | sha256sum --check
pg_restore --list prepforge.dump >/dev/null
pg_restore --exit-on-error --no-owner --no-privileges \
  --dbname "$EMPTY_DATABASE_URL" prepforge.dump
psql "$EMPTY_DATABASE_URL" -c "SELECT version_num FROM alembic_version;"
```

Never restore over the live database. Restore into a newly created empty database,
verify user/table counts and application startup, then update `DATABASE_URL`. Rotate a
key immediately if it is exposed; secret values must not appear in docs or logs.

### External uptime monitoring

Point a free external monitor at the public health endpoint:

- **URL:** `https://prepforge-w0c5.onrender.com/healthz` (replace with your service URL)
- **Interval:** 5–10 minutes (enough to reduce cold starts without burning Render hours)
- **Expected:** HTTP 200, body `{"status":"ok"}`

[UptimeRobot](https://uptimerobot.com/) free tier works well. Alternatively, the repo's
`.github/workflows/keep-warm.yml` pings `/healthz` on a schedule — keep one external
monitor for alerts even if keep-warm runs.

### Client error observability (`/api/clientlog`)

The SPA beacons uncaught errors to `POST /api/clientlog` (CSRF-exempt, `sendBeacon`).
Logs appear in the Render log stream under the `prepforge.clientlog` logger at WARNING.

**Verify after deploy:**

1. Open prod → DevTools → Console → `throw new Error("clientlog smoke")`
2. Render dashboard → your web service → **Logs** → filter for `clientlog` or the message
3. Optional: set `PREPFORGE_SENTRY_DSN` for structured error reporting

Use clientlog volume to decide engine graceful-failure priority (stability plan D2).

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

E2E (opt-in — Playwright + Chromium + live Lichess; excluded from default `pytest -q`):

```powershell
npx playwright install chromium   # one-time
uv run pytest -q -m e2e tests/e2e
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
