"""Tiny key/value settings service backed by the `app_settings` table."""
from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, Optional


STOCKFISH_DEPTH_KEY = "stockfish.depth"
STOCKFISH_DEPTH_DEFAULT = 16
STOCKFISH_DEPTH_MIN = 1
STOCKFISH_DEPTH_MAX = 30


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


@dataclass
class StockfishStatus:
    path: Optional[str]
    version: Optional[str]
    error: Optional[str] = None


class AppSettingsService:
    def __init__(self, connection: sqlite3.Connection):
        self.connection = connection

    def get(self, key: str, default: Any = None) -> Any:
        row = self.connection.execute(
            "SELECT value_json FROM app_settings WHERE key = ?",
            (key,),
        ).fetchone()
        if row is None:
            return default
        try:
            return json.loads(row["value_json"])
        except (json.JSONDecodeError, TypeError):
            return default

    def set(self, key: str, value: Any) -> None:
        encoded = json.dumps(value)
        with self.connection:
            self.connection.execute(
                """
                INSERT INTO app_settings (key, value_json, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET
                    value_json = excluded.value_json,
                    updated_at = excluded.updated_at
                """,
                (key, encoded, _now()),
            )

    def get_stockfish_depth(self) -> int:
        value = self.get(STOCKFISH_DEPTH_KEY, STOCKFISH_DEPTH_DEFAULT)
        try:
            depth = int(value)
        except (TypeError, ValueError):
            depth = STOCKFISH_DEPTH_DEFAULT
        return max(STOCKFISH_DEPTH_MIN, min(STOCKFISH_DEPTH_MAX, depth))

    def set_stockfish_depth(self, depth: int) -> int:
        try:
            value = int(depth)
        except (TypeError, ValueError):
            raise ValueError("depth must be an integer")
        clamped = max(STOCKFISH_DEPTH_MIN, min(STOCKFISH_DEPTH_MAX, value))
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
