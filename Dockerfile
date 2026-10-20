# PrepForge Chess — SaaS production image (FastAPI + uvicorn).
#
# The server stores data and enforces ownership; it never computes chess. Engines
# run in the browser (WASM). So this image carries NO Stockfish/Maia binaries and
# installs the ".[server]" extra (FastAPI, SQLAlchemy, Alembic, psycopg) only.
#
# The SPA is build output, not source: the `spa` stage below runs the same
# `npm run build` a developer runs, and the Python image copies its static/ tree.
# The Stockfish wasm is not copied from there: it is fetched below, from the npm
# package the committed manifest names, because only the manifest is in git.

# --- SPA build (keyed on the frontend sources and lockfile) --------------------
FROM node:22-slim AS spa

# The image never runs a browser; keep Playwright from downloading Chromium.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /app
# Only what `npm run build` reads: the lockfile installs the pinned Vite/Stockfish/
# ONNX packages, and the sync scripts vendor the engine files Vite's publicDir copies.
COPY package.json package-lock.json ./
RUN npm ci
COPY vite.config.js ./
COPY scripts/sync-stockfish.mjs scripts/sync-ort.mjs ./scripts/
COPY web-src ./web-src
# sync-engine writes the Stockfish wasm from node_modules; stripping it here keeps
# the ~99 MB big net out of the copy — the image gets it from the verified fetch
# below instead, so it never travels twice.
RUN npm run build \
    && rm -f src/prepforge_chess/web/static/engine/*/stockfish.wasm

FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /app

# --- Dependency layer (cached across app/asset changes) -----------------------
# Install the heavy third-party deps against a STUB package so this slow layer is
# keyed on pyproject.toml alone. Without the stub, "COPY src" — which holds the
# frequently-rebuilt SPA under web/static — would invalidate this layer and force a
# full reinstall of fastapi/sqlalchemy/psycopg/cryptography on every deploy.
COPY pyproject.toml README.md ./
RUN mkdir -p src/prepforge_chess \
    && touch src/prepforge_chess/__init__.py \
    && python -m pip install --no-cache-dir --upgrade pip \
    && python -m pip install --no-cache-dir ".[server]"

# --- Stockfish wasm (keyed on the engine manifest, so deploys reuse this layer) ---
# The manifest is the committed record: it names the package version and the sha256
# of each wasm, so an engine bump refetches here and an app change does not.
COPY scripts/fetch_stockfish_wasm.py web-src/public/engine/stockfish.manifest.json /tmp/engine/
RUN python /tmp/engine/fetch_stockfish_wasm.py /tmp/engine/stockfish.manifest.json /tmp/engine/out

# --- Application layer (rebuilt only when src/ or migrations change) -----------
COPY alembic.ini ./
COPY migrations ./migrations
COPY src ./src
# The built SPA and the fetched wasm complete the static tree the package ships.
COPY --from=spa /app/src/prepforge_chess/web/static ./src/prepforge_chess/web/static
RUN cp -r /tmp/engine/out/. src/prepforge_chess/web/static/engine/ \
    && python -m pip install --no-cache-dir --no-deps --force-reinstall ".[server]"

EXPOSE 8000

# Run migrations then start the server. Baked into CMD because Render's
# preDeployCommand is a paid feature; this gives the same fail-fast behaviour
# (migration error aborts startup before serving traffic).
# --forwarded-allow-ips "*": behind Render's proxy the client IP arrives in
# X-Forwarded-For, but --proxy-headers alone only trusts localhost sources, so
# request.client.host would stay the proxy IP and every visitor would share one
# rate-limit bucket (api/ratelimit.py). Render's proxy is the only ingress, so
# trusting its X-Forwarded-For is safe here; see docs/DEPLOYMENT.md.
CMD ["sh", "-c", "alembic upgrade head && uvicorn prepforge_chess.api.main:app --host 0.0.0.0 --port ${PORT:-8000} --proxy-headers --forwarded-allow-ips '*'"]
