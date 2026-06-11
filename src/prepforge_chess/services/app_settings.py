"""Tiny key/value settings service backed by the `app_settings` table."""
from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.engine import Engine

from prepforge_chess.storage import sa_tables as t


STOCKFISH_DEPTH_KEY = "stockfish.depth"
STOCKFISH_DEPTH_DEFAULT = 16
STOCKFISH_DEPTH_MIN = 1
STOCKFISH_DEPTH_MAX = 30

# Maia3's rating conditioning (how "human" the model predicts/plays). ``None`` means
# AUTO: the browser matches the player's own Lichess rating when an account is linked,
# falling back to the client default. Bounds mirror the model's supported range
# (web-src Build → Generate already clamps to the same 600–2600).
MAIA_RATING_KEY = "maia3.rating"
MAIA_RATING_MIN = 600
MAIA_RATING_MAX = 2600


def clamp_stockfish_depth(value: Any, default: int = STOCKFISH_DEPTH_DEFAULT) -> int:
    """Coerce + clamp a depth into the supported range. Shared by the global
    ``AppSettingsService`` (legacy single-tenant) and the per-owner settings stored
    on ``user_profiles.settings_json`` in the multi-tenant SaaS API, so both honour
    the same bounds. A non-integer falls back to ``default``."""
    try:
        depth = int(value)
    except (TypeError, ValueError):
        depth = default
    return max(STOCKFISH_DEPTH_MIN, min(STOCKFISH_DEPTH_MAX, depth))


def clamp_maia_rating(value: Any) -> Optional[int]:
    """Coerce + clamp a Maia3 rating; a non-integer means AUTO (``None``)."""
    try:
        rating = int(value)
    except (TypeError, ValueError):
        return None
    return max(MAIA_RATING_MIN, min(MAIA_RATING_MAX, rating))


def owner_maia_rating(repo: Any, owner_user_id: str) -> Optional[int]:
    """One owner's pinned Maia3 rating, or ``None`` for AUTO (match the player).

    Lives on the same per-owner profile blob as the Stockfish depth — never the
    global ``app_settings`` store — so one tenant's strength preference can't
    leak into another's coach/generation reads."""
    stored = repo.get_profile_setting(owner_user_id, MAIA_RATING_KEY, None)
    if stored is None:
        return None
    return clamp_maia_rating(stored)


def owner_stockfish_depth(repo: Any, owner_user_id: str) -> int:
    """One owner's configured analysis depth (clamped; default when unset).

    The multi-tenant home for this preference is the owner's profile blob — NOT the
    global ``app_settings`` store, which would leak one tenant's depth to all. Reads
    via the repository's per-profile ``settings_json`` accessor (the same mechanism
    that holds the Lichess token). Shared by the settings + analyze routers so
    ``/api/analyze/prepare`` echoes exactly what ``/api/settings`` persisted."""
    stored = repo.get_profile_setting(owner_user_id, STOCKFISH_DEPTH_KEY, STOCKFISH_DEPTH_DEFAULT)
    return clamp_stockfish_depth(stored)


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


@dataclass
class StockfishStatus:
    path: Optional[str]
    version: Optional[str]
    error: Optional[str] = None


class AppSettingsService:
    def __init__(self, engine: Engine):
        self.engine = engine

    def get(self, key: str, default: Any = None) -> Any:
        with self.engine.connect() as conn:
            row = conn.execute(
                select(t.app_settings.c.value_json).where(t.app_settings.c.key == key)
            ).mappings().first()
        if row is None:
            return default
        try:
            return json.loads(row["value_json"])
        except (json.JSONDecodeError, TypeError):
            return default

    def set(self, key: str, value: Any) -> None:
        encoded = json.dumps(value)
        insert = pg_insert if self.engine.dialect.name == "postgresql" else sqlite_insert
        stmt = insert(t.app_settings).values(key=key, value_json=encoded, updated_at=_now())
        stmt = stmt.on_conflict_do_update(
            index_elements=[t.app_settings.c.key],
            set_={"value_json": stmt.excluded.value_json, "updated_at": stmt.excluded.updated_at},
        )
        with self.engine.begin() as conn:
            conn.execute(stmt)

    def get_stockfish_depth(self) -> int:
        return clamp_stockfish_depth(self.get(STOCKFISH_DEPTH_KEY, STOCKFISH_DEPTH_DEFAULT))

    def set_stockfish_depth(self, depth: int) -> int:
        try:
            value = int(depth)
        except (TypeError, ValueError):
            raise ValueError("depth must be an integer")
        clamped = clamp_stockfish_depth(value)
        self.set(STOCKFISH_DEPTH_KEY, clamped)
        return clamped


def detect_stockfish_version(path: Optional[str], *, timeout: float = 3.0) -> Optional[str]:
    """Best-effort: ask the binary for its UCI `id name` and return the value."""
    if not path:
        return None
    import subprocess

    try:
        proc = subprocess.Popen(
            [path],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            bufsize=1,
        )
    except (OSError, FileNotFoundError):
        return None

    try:
        proc.stdin.write("uci\nquit\n")
        proc.stdin.flush()
        try:
            stdout, _ = proc.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            proc.kill()
            return None
    finally:
        try:
            proc.stdin.close()
        except Exception:
            pass

    if not stdout:
        return None
    for line in stdout.splitlines():
        if line.startswith("id name"):
            return line[len("id name"):].strip()
    return None


def stockfish_status(path: Optional[str]) -> StockfishStatus:
    if not path:
        return StockfishStatus(path=None, version=None, error=None)
    version = detect_stockfish_version(path)
    return StockfishStatus(path=path, version=version, error=None if version else "binary did not respond to UCI handshake")
