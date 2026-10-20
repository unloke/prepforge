"""Rewrite stored analysis snapshots into the compact replay-based codec.

Revision ID: b3e5c7d9f1a4
Revises: e7a1c3d5f9b2
Create Date: 2026-10-20 00:00:00.000000

``analysis_results.move_results_json`` stored ``asdict(MoveRecord)`` for every
ply: SAN, FEN-before, FEN-after, ply, move number and side are all derivable by
replaying the run's starting position, and the same engine evaluation was
repeated up to three times (before, after, best-move). Runtime reads only the
new encoding (:func:`prepforge_chess.storage.codec.decode_analysis_moves`), so
the payloads are converted in place rather than tolerated at read time.
"""
import base64
import json
import zlib
from dataclasses import asdict

from alembic import op
import sqlalchemy as sa

from prepforge_chess.core.models import (
    Color,
    EngineEvaluation,
    MoveClassification,
    MoveRecord,
    MoveSource,
)
from prepforge_chess.storage import codec


revision = "b3e5c7d9f1a4"
down_revision = "e7a1c3d5f9b2"
branch_labels = None
depends_on = None

_LEGACY_CODEC = "zlib-base64-v1"


def _legacy_moves(payload: str):
    envelope = json.loads(payload)
    if envelope["codec"] != _LEGACY_CODEC:
        raise ValueError("unsupported analysis snapshot codec")
    moves = []
    for row in json.loads(zlib.decompress(base64.b64decode(envelope["data"], validate=True))):
        row["side_to_move"] = Color(row["side_to_move"])
        row["source"] = MoveSource(row["source"])
        row["classification"] = MoveClassification(row["classification"])
        for key in ("engine_eval_before", "engine_eval_after", "best_move_eval"):
            if row.get(key) is not None:
                row[key] = EngineEvaluation(**row[key])
        moves.append(MoveRecord(**row))
    return moves


def _legacy_payload(moves) -> str:
    raw = json.dumps([asdict(move) for move in moves], separators=(",", ":")).encode("utf-8")
    return json.dumps(
        {"codec": _LEGACY_CODEC, "data": base64.b64encode(zlib.compress(raw)).decode("ascii")},
        separators=(",", ":"),
    )


def _convert(encode: bool) -> None:
    table = sa.table(
        "analysis_results",
        sa.column("id", sa.Text),
        sa.column("move_results_json", sa.Text),
    )
    connection = op.get_bind()
    cursor = ""
    while True:
        rows = connection.execute(
            sa.select(table).where(table.c.id > cursor).order_by(table.c.id).limit(100)
        ).mappings().all()
        if not rows:
            break
        updates = []
        for row in rows:
            raw = row["move_results_json"]
            if raw is None:
                continue
            moves = _legacy_moves(raw) if encode else codec.decode_analysis_moves(raw)
            updates.append({
                "id": row["id"],
                "payload": codec.encode_analysis_moves(moves) if encode else _legacy_payload(moves),
            })
        if updates:
            connection.execute(
                sa.text("UPDATE analysis_results SET move_results_json = :payload WHERE id = :id"),
                updates,
            )
        cursor = rows[-1]["id"]


def upgrade() -> None:
    _convert(True)


def downgrade() -> None:
    _convert(False)
