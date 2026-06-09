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

COPY pyproject.toml README.md alembic.ini ./
COPY migrations ./migrations
COPY src ./src

RUN python -m pip install --no-cache-dir --upgrade pip \
    && python -m pip install --no-cache-dir ".[server]"

EXPOSE 8000

# Run migrations then start the server. Baked into CMD because Render's
# preDeployCommand is a paid feature; this gives the same fail-fast behaviour
# (migration error aborts startup before serving traffic).
CMD ["sh", "-c", "alembic upgrade head && uvicorn prepforge_chess.api.main:app --host 0.0.0.0 --port ${PORT:-8000} --proxy-headers"]
