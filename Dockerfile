# PrepForge Chess — SaaS production image (FastAPI + uvicorn).
#
# The server stores data and enforces ownership; it never computes chess. Engines
# run in the browser (WASM). So this image carries NO Stockfish/Maia binaries and
# installs the ".[server]" extra (FastAPI, SQLAlchemy, Alembic, psycopg) only.
#
# The built SPA (Vite output) is committed under src/prepforge_chess/web/static, so
# COPY src ships it — no Node build stage is required in the image. Rebuild assets
# with `npm run build` before building this image if web-src/ changed.
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /app

# --- Dependency layer (cached across app/asset changes) -----------------------
# Install the heavy third-party deps against a STUB package so this slow layer is
# keyed on pyproject.toml alone. Without the stub, "COPY src" — which holds the
# frequently-rebuilt JS bundle under web/static — would invalidate this layer and
# force a full reinstall of fastapi/sqlalchemy/psycopg/cryptography on every deploy.
COPY pyproject.toml README.md ./
RUN mkdir -p src/prepforge_chess \
    && touch src/prepforge_chess/__init__.py \
    && python -m pip install --no-cache-dir --upgrade pip \
    && python -m pip install --no-cache-dir ".[server]"

# --- Application layer (rebuilt only when src/ or migrations change) -----------
COPY alembic.ini ./
COPY migrations ./migrations
COPY src ./src
# Reinstall ONLY the package (deps already satisfied above) so the real modules
# and committed static assets replace the stub. --force-reinstall is required
# because the version is unchanged, so pip would otherwise treat it as installed.
RUN python -m pip install --no-cache-dir --no-deps --force-reinstall ".[server]"

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
