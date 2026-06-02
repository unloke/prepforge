FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PREPFORGE_DB_PATH=/data/prepforge.sqlite3

WORKDIR /app

COPY pyproject.toml README.md ./
COPY src ./src

RUN python -m pip install --no-cache-dir --upgrade pip \
    && python -m pip install --no-cache-dir .

RUN mkdir -p /data /app/engines/stockfish \
    && python -m prepforge_chess install-stockfish

EXPOSE 8765

CMD ["sh", "-c", "python -m prepforge_chess ui --host 0.0.0.0 --port ${PORT:-8765} --db-path ${PREPFORGE_DB_PATH:-/data/prepforge.sqlite3}"]
