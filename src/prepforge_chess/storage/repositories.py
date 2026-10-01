from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timezone
from hashlib import sha256
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional

from sqlalchemy import or_, and_, case, delete, func, literal, not_, select, union, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.engine import Connection, Engine

from prepforge_chess.core.models import (
    AnalysisResult,
    Color,
    EngineEvaluation,
    Game,
    GameResult,
    MoveRecord,
    MoveSource,
    OpeningNode,
    Repertoire,
    TrainingMode,
    TrainingProgress,
    TrainingSession,
)
from prepforge_chess.storage import codec
from prepforge_chess.storage import sa_tables as t


logger = logging.getLogger(__name__)

def _setting_row(user_id: str, key: str, value: Any) -> Dict[str, Any]:
    return {
        "user_id": user_id,
        "key": key,
        "value_json": _json_dump(value),
        "updated_at": _now_text(),
    }


def _now_text() -> str:
    return datetime.now(timezone.utc).isoformat()


def _json_dump(value: Any) -> str:
    return json.dumps(value, ensure_ascii=True, sort_keys=True)


def _json_load(value: Optional[str], default: Any) -> Any:
    if value is None:
        return default
    return json.loads(value)


def _parse_critical_ply(value: Optional[str]) -> List[int]:
    if not value:
        return []
    return [int(part) for part in value.split(",") if part]


def _dt_to_text(value: Optional[datetime]) -> Optional[str]:
    return value.isoformat() if value is not None else None


def _dt_from_text(value: Optional[str]) -> Optional[datetime]:
    return datetime.fromisoformat(value) if value else None


def _bool_to_int(value: bool) -> int:
    return 1 if value else 0


def _int_to_bool(value: int) -> bool:
    return bool(value)


def _insert(conn: Connection, table):
    """Dialect-aware INSERT so ``on_conflict_do_update`` (upsert) works on both
    backends: Postgres and SQLite spell ``ON CONFLICT`` differently."""
    if conn.dialect.name == "postgresql":
        return pg_insert(table)
    return sqlite_insert(table)


def _upsert(
    conn: Connection,
    table,
    values: Dict[str, Any],
    *,
    conflict: List,
    update_cols: Iterable[str],
    coalesce_cols: Iterable[str] = (),
) -> None:
    """INSERT ... ON CONFLICT DO UPDATE. ``update_cols`` are set from the proposed
    (``excluded``) row; ``coalesce_cols`` keep the existing value when present and
    only fill a gap — used so a re-save never reassigns an established owner."""
    stmt = _insert(conn, table).values(**values)
    set_ = {name: stmt.excluded[name] for name in update_cols}
    for name in coalesce_cols:
        set_[name] = func.coalesce(table.c[name], stmt.excluded[name])
    stmt = stmt.on_conflict_do_update(index_elements=conflict, set_=set_)
    conn.execute(stmt)


class RevisionConflict(RuntimeError):
    def __init__(self, current_revision: Optional[int]):
        super().__init__("This repertoire changed elsewhere. Reload it and re-apply the edit, or keep your draft.")
        self.current_revision = current_revision


class PrepForgeRepository:
    """SQLAlchemy persistence for shared domain models.

    The repository is intentionally narrow: it stores and loads domain objects
    without putting analysis, training, or generation decisions into SQL code. It
    runs against the ``storage/sa_tables`` Core tables, so the same code drives
    SQLite (dev/tests) and Postgres (prod).
    """

    def __init__(self, engine: Engine):
        self.engine = engine
        self._expected_revisions: Dict[str, int] = {}

    def expect_repertoire_revision(self, repertoire_id: str, revision: int) -> None:
        """Fence a request's writes at commit, not just at its earlier HTTP read."""
        self._expected_revisions[repertoire_id] = revision

    # ---- Per-user settings (canonical 1:1 key/value store) ---------------------
    # Every user fact that used to hide in a settings blob lives in its own
    # ``user_settings`` row: streak, recap snapshot, Lichess markers, analysis
    # preferences. One row per key means concurrent writers to different keys
    # never clobber each other.

    def get_user_setting(self, user_id: str, key: str, default: Any = None) -> Any:
        with self.engine.connect() as conn:
            row = conn.execute(
                select(t.user_settings.c.value_json).where(
                    t.user_settings.c.user_id == user_id,
                    t.user_settings.c.key == key,
                )
            ).mappings().first()
        if row is None:
            return default
        try:
            return json.loads(row["value_json"])
        except (json.JSONDecodeError, TypeError):
            logger.warning("Invalid stored setting JSON user=%s key=%s", user_id, key)
            return default

    def set_user_setting(self, user_id: str, key: str, value: Any) -> None:
        """Upsert one setting row. A ``None`` value deletes the key."""
        with self.engine.begin() as conn:
            self.write_user_setting(conn, user_id, key, value)

    def write_user_setting(self, conn: Connection, user_id: str, key: str, value: Any) -> None:
        """Conn-scoped ``set_user_setting``: run inside the caller's transaction so
        the setting write commits together with related domain writes. A ``None``
        value deletes the key."""
        if value is None:
            conn.execute(
                delete(t.user_settings).where(
                    t.user_settings.c.user_id == user_id,
                    t.user_settings.c.key == key,
                )
            )
            return
        stmt = _insert(conn, t.user_settings).values(_setting_row(user_id, key, value))
        stmt = stmt.on_conflict_do_update(
            index_elements=["user_id", "key"],
            set_={"value_json": stmt.excluded.value_json, "updated_at": stmt.excluded.updated_at},
        )
        conn.execute(stmt)

    def lock_user_setting(
        self, conn: Connection, user_id: str, key: str, default: Any = None
    ) -> Any:
        """Read one setting row FOR UPDATE inside an open transaction.

        Insert-claims the row first when absent (``ON CONFLICT DO NOTHING``) so two
        concurrent transactions can never both act on "unset": on PostgreSQL the
        second inserter blocks on the first and then locks the committed row, which
        serialises the whole read-modify-write. ``default`` is returned when the key
        is unset or unparsable. Callers follow up with ``write_user_setting`` (or
        nothing) before the transaction ends.
        """
        conn.execute(
            _insert(conn, t.user_settings)
            .values(_setting_row(user_id, key, default))
            .on_conflict_do_nothing(
                index_elements=[t.user_settings.c.user_id, t.user_settings.c.key]
            )
        )
        row = conn.execute(
            select(t.user_settings.c.value_json)
            .where(
                t.user_settings.c.user_id == user_id,
                t.user_settings.c.key == key,
            )
            .with_for_update()
        ).mappings().first()
        if row is None:
            return default
        try:
            return json.loads(row["value_json"])
        except (json.JSONDecodeError, TypeError):
            return default

    def mutate_user_setting(
        self, user_id: str, key: str, mutator: "Callable[[Any], Any]"
    ) -> Any:
        """Atomically read-modify-write one setting row.

        ``mutator`` receives the current value (or ``None`` if unset) and returns
        the new one; returning ``None`` deletes the key. Row-locked on Postgres
        so concurrent mutators serialise. Unchanged values skip the write.
        """
        with self.engine.begin() as conn:
            row = conn.execute(
                select(t.user_settings.c.value_json)
                .where(
                    t.user_settings.c.user_id == user_id,
                    t.user_settings.c.key == key,
                )
                .with_for_update()
            ).mappings().first()
            try:
                current = json.loads(row["value_json"]) if row is not None else None
            except (json.JSONDecodeError, TypeError):
                current = None
            new_value = mutator(current)
            if new_value == current and (new_value is not None or row is None):
                return new_value
            if row is None and new_value is None:
                return None
            if new_value is None:
                conn.execute(
                    delete(t.user_settings).where(
                        t.user_settings.c.user_id == user_id,
                        t.user_settings.c.key == key,
                    )
                )
            elif row is None:
                conn.execute(t.user_settings.insert().values(_setting_row(user_id, key, new_value)))
            else:
                conn.execute(
                    update(t.user_settings)
                    .where(
                        t.user_settings.c.user_id == user_id,
                        t.user_settings.c.key == key,
                    )
                    .values(value_json=_json_dump(new_value), updated_at=_now_text())
                )
        return new_value

    # ---- Train attempt receipts (exactly-once sync) --------------------------

    def get_attempt_receipt(
        self, session_id: str, attempt_uuid: str
    ) -> Optional[Dict[str, Any]]:
        with self.engine.connect() as conn:
            row = conn.execute(
                select(t.train_attempt_receipts).where(
                    t.train_attempt_receipts.c.session_id == session_id,
                    t.train_attempt_receipts.c.attempt_uuid == attempt_uuid,
                )
            ).mappings().first()
        if row is None:
            return None
        return {
            "session_id": row["session_id"],
            "attempt_uuid": row["attempt_uuid"],
            "node_id": row["node_id"],
            "correct": bool(row["correct"]),
        }

    def record_attempt_receipt(
        self, conn: Connection, *, session_id: str, attempt_uuid: str, node_id: str, correct: bool
    ) -> bool:
        """Claim an attempt atomically; return False when its UUID already exists."""
        result = conn.execute(
            _insert(conn, t.train_attempt_receipts).values(
                session_id=session_id,
                attempt_uuid=attempt_uuid,
                node_id=node_id,
                correct=_bool_to_int(correct),
                created_at=_now_text(),
            ).on_conflict_do_nothing(
                index_elements=[
                    t.train_attempt_receipts.c.session_id,
                    t.train_attempt_receipts.c.attempt_uuid,
                ]
            ).returning(t.train_attempt_receipts.c.attempt_uuid)
        )
        return result.first() is not None

    def save_game(self, game: Game, owner_user_id: Optional[str] = None) -> None:
        now = _now_text()
        with self.engine.begin() as conn:
            _upsert(
                conn,
                t.games,
                {
                    "id": game.id,
                    "source": game.source.value,
                    "initial_fen": game.initial_fen,
                    "uci_blob": codec.game_uci_blob(game),
                    "white": game.white,
                    "black": game.black,
                    "result": game.result.value,
                    "event": game.event,
                    "site": game.site,
                    "played_at": _dt_to_text(game.played_at),
                    "lichess_id": game.lichess_id,
                    "tags_json": _json_dump(game.tags),
                    "owner_user_id": owner_user_id,
                    "created_at": now,
                    "updated_at": now,
                },
                conflict=[t.games.c.id],
                update_cols=(
                    "source", "initial_fen", "uci_blob", "white", "black", "result",
                    "event", "site", "played_at", "lichess_id", "tags_json", "updated_at",
                ),
                # Never let a re-save reassign an existing owner; only fill a gap.
                coalesce_cols=("owner_user_id",),
            )

            conn.execute(delete(t.moves).where(t.moves.c.game_id == game.id))
            pos_cache: Dict[str, int] = {}
            for move in game.moves:
                if not codec.move_needs_row(move):
                    continue
                self._save_move_annotation(conn, game_id=game.id, move=move, pos_cache=pos_cache)

    def _save_moves_batched(self, conn: Connection, game: Game, result) -> None:
        """Bulk portion of ``save_game_batched`` (moves, positions, evals,
        analysis row). Runs inside the caller's transaction; the game-metadata
        upsert already happened in ``save_game_batched``."""
        from prepforge_chess.core.models import MoveRecord as _MoveRecord

        annotated: List[_MoveRecord] = [
            move for move in game.moves if codec.move_needs_row(move)
        ]

        # 1. Collect every unique position key once (chunked for the
        # SQLite 999-variable cap and the Postgres 65535-parameter cap).
        fen_keys: List[str] = []
        seen_fens: set = set()
        for move in annotated:
            for fen in (move.fen_before, move.fen_after):
                key = codec.position_key(fen)
                if key not in seen_fens:
                    seen_fens.add(key)
                    fen_keys.append(key)
        pos_ids: Dict[str, int] = {}
        FEN_CHUNK = 400
        if fen_keys:
            # Chunked multi-row VALUES (1 column per row; 400 is safely
            # under both backends' parameter caps). One round-trip per
            # chunk, not per position.
            for chunk_start in range(0, len(fen_keys), FEN_CHUNK):
                chunk = fen_keys[chunk_start : chunk_start + FEN_CHUNK]
                conn.execute(
                    _insert(conn, t.positions)
                    .values([{"fen": key} for key in chunk])
                    .on_conflict_do_nothing(index_elements=["fen"])
                )
            pos_ids = {}
            for pos_start in range(0, len(fen_keys), FEN_CHUNK):
                pos_chunk = fen_keys[pos_start : pos_start + FEN_CHUNK]
                for row in conn.execute(
                    select(t.positions.c.id, t.positions.c.fen).where(
                        t.positions.c.fen.in_(pos_chunk)
                    )
                ).all():
                    pos_ids[row.fen] = int(row.id)

        # 2. Deduplicate engine evaluations by their unique key (identity +
        # content fingerprint) and insert them in chunks with RETURNING ids.
        # Rows are immutable snapshots: identical content dedupes onto one row,
        # while a different result carries a different fingerprint and gets its
        # own row — nothing is ever rewritten (improvement review D-01).

        def _eval_payload(evaluation, fen) -> Dict[str, Any]:
            wdl = codec.encode_wdl(evaluation.wdl)
            payload = {
                "position_id": pos_ids[codec.position_key(fen)],
                "engine": evaluation.engine,
                "depth": codec.encode_search_limit(evaluation.depth),
                "nodes": codec.encode_search_limit(evaluation.nodes),
                "time_ms": codec.encode_search_limit(evaluation.time_ms),
                "score_cp": evaluation.score_cp,
                "mate_in": evaluation.mate_in,
                "best_move_uci": evaluation.best_move_uci,
                "pv": codec.encode_pv(evaluation.pv),
                "wdl_win": None if wdl is None else wdl[0],
                "wdl_draw": None if wdl is None else wdl[1],
                "wdl_loss": None if wdl is None else wdl[2],
            }
            payload["fingerprint"] = codec.evaluation_fingerprint(
                engine=payload["engine"],
                position_fen=codec.position_key(fen),
                depth=payload["depth"],
                nodes=payload["nodes"],
                time_ms=payload["time_ms"],
                score_cp=payload["score_cp"],
                mate_in=payload["mate_in"],
                best_move_uci=payload["best_move_uci"],
                pv=payload["pv"],
                wdl_win=payload["wdl_win"],
                wdl_draw=payload["wdl_draw"],
                wdl_loss=payload["wdl_loss"],
            )
            return payload

        def _eval_key(payload: Dict[str, Any]) -> tuple:
            return (
                payload["position_id"],
                payload["engine"],
                payload["depth"],
                payload["nodes"],
                payload["time_ms"],
                payload["fingerprint"],
            )

        eval_keys: List[tuple] = []
        seen_evals: set = set()
        eval_payloads: Dict[tuple, Dict[str, Any]] = {}
        for move in annotated:
            for evaluation, fen in (
                (move.engine_eval_before, move.fen_before),
                (move.engine_eval_after, move.fen_after),
                (move.best_move_eval, move.fen_before),
            ):
                if evaluation is None:
                    continue
                payload = _eval_payload(evaluation, fen)
                key = _eval_key(payload)
                if key in seen_evals:
                    continue
                seen_evals.add(key)
                eval_keys.append(key)
                eval_payloads[key] = payload
        eval_ids: Dict[tuple, int] = {}
        if eval_payloads:
            # Same SQLite executemany-upsert limitation as move rows: use
            # chunked multi-row VALUES (13 columns per eval row → a 40-row
            # chunk is 520 variables). One round-trip per chunk.
            CHUNK = 40
            for chunk_start in range(0, len(eval_keys), CHUNK):
                chunk = eval_keys[chunk_start : chunk_start + CHUNK]
                stmt = _insert(conn, t.engine_evaluations).values(
                    [eval_payloads[key] for key in chunk]
                )
                stmt = stmt.on_conflict_do_nothing(
                    index_elements=[
                        "position_id",
                        "engine",
                        "depth",
                        "nodes",
                        "time_ms",
                        "fingerprint",
                    ],
                ).returning(
                    t.engine_evaluations.c.id,
                    t.engine_evaluations.c.position_id,
                    t.engine_evaluations.c.engine,
                    t.engine_evaluations.c.depth,
                    t.engine_evaluations.c.nodes,
                    t.engine_evaluations.c.time_ms,
                    t.engine_evaluations.c.fingerprint,
                )
                for row in conn.execute(stmt).all():
                    eval_ids[
                        (
                            int(row.position_id),
                            row.engine,
                            int(row.depth),
                            int(row.nodes),
                            int(row.time_ms),
                            row.fingerprint,
                        )
                    ] = int(row.id)
            # RETURNING only yields the rows this call INSERTED — snapshots
            # already stored (cache hits) come back via these selects (same
            # variable-cap reason as above).
            missing = [key for key in eval_keys if key not in eval_ids]
            if missing:
                pos_chunks = sorted({key[0] for key in missing})
                engine_name = eval_payloads[missing[0]]["engine"]
                for pos_start in range(0, len(pos_chunks), FEN_CHUNK):
                    pos_chunk = pos_chunks[pos_start : pos_start + FEN_CHUNK]
                    rows = conn.execute(
                        select(
                            t.engine_evaluations.c.id,
                            t.engine_evaluations.c.position_id,
                            t.engine_evaluations.c.engine,
                            t.engine_evaluations.c.depth,
                            t.engine_evaluations.c.nodes,
                            t.engine_evaluations.c.time_ms,
                            t.engine_evaluations.c.fingerprint,
                        ).where(
                            t.engine_evaluations.c.position_id.in_(pos_chunk),
                            t.engine_evaluations.c.engine == engine_name,
                        )
                    ).all()
                    for row in rows:
                        key = (
                            int(row.position_id),
                            row.engine,
                            int(row.depth),
                            int(row.nodes),
                            int(row.time_ms),
                            row.fingerprint,
                        )
                        if key in eval_payloads:
                            eval_ids[key] = int(row.id)

        def _eval_id(evaluation, fen) -> Optional[int]:
            if evaluation is None:
                return None
            return eval_ids.get(_eval_key(_eval_payload(evaluation, fen)))

        # 3. Deterministic upsert of move rows by (game_id, ply) in one
        # bulk statement. It replaces annotations on re-analysis; plies
        # that no longer need a row (unclassified, uncommented) are
        # deleted so the game never keeps stale annotations.
        # NOTE: one multi-row VALUES would trip the SQLite 999-variable
        # cap (12 columns × 80 rows), so rows go in parametrized
        # executemany chunks — one round-trip per chunk, same row count.
        move_rows = [
            {
                "game_id": game.id,
                "ply": move.ply,
                "uci": move.uci,
                "engine_eval_before_id": _eval_id(move.engine_eval_before, move.fen_before),
                "engine_eval_after_id": _eval_id(move.engine_eval_after, move.fen_after),
                "best_move_uci": move.best_move_uci,
                "best_move_eval_id": _eval_id(move.best_move_eval, move.fen_before),
                "classification": move.classification.value,
                "comment": move.comment,
                "generated_comment": move.generated_comment,
                "generated_meta_json": (
                    _json_dump(move.generated_meta) if move.generated_meta else None
                ),
                "tags_json": _json_dump(move.tags) if move.tags else None,
                "source": move.source.value,
            }
            for move in annotated
        ]
        if move_rows:
            # executemany-with-upsert is rejected on SQLite, so chunk the
            # multi-row VALUES (12 columns per row; a 40-row chunk is 480
            # variables, safely under the 999 cap on SQLite and trivially
            # under the Postgres parameter cap). An 80-ply game is 2
            # chunks — O(1) round-trips, not O(ply) — on both backends.
            MOVE_CHUNK = 40
            for chunk_start in range(0, len(move_rows), MOVE_CHUNK):
                chunk = move_rows[chunk_start : chunk_start + MOVE_CHUNK]
                stmt = _insert(conn, t.moves).values(chunk)
                stmt = stmt.on_conflict_do_update(
                    index_elements=["game_id", "ply"],
                    set_={
                        "uci": stmt.excluded.uci,
                        "engine_eval_before_id": stmt.excluded.engine_eval_before_id,
                        "engine_eval_after_id": stmt.excluded.engine_eval_after_id,
                        "best_move_uci": stmt.excluded.best_move_uci,
                        "best_move_eval_id": stmt.excluded.best_move_eval_id,
                        "classification": stmt.excluded.classification,
                        "comment": stmt.excluded.comment,
                        "generated_comment": stmt.excluded.generated_comment,
                        "generated_meta_json": stmt.excluded.generated_meta_json,
                        "tags_json": stmt.excluded.tags_json,
                        "source": stmt.excluded.source,
                    },
                )
                conn.execute(stmt)
        kept = {move.ply for move in annotated}
        if kept:
            conn.execute(
                delete(t.moves).where(
                    t.moves.c.game_id == game.id, ~t.moves.c.ply.in_(sorted(kept))
                )
            )
        else:
            conn.execute(delete(t.moves).where(t.moves.c.game_id == game.id))

        if result is not None:
            analysis_id = self._analysis_result_id(result)
            _upsert(
                conn,
                t.analysis_results,
                {
                    "id": analysis_id,
                    "game_id": result.game_id,
                    "analyzed_at": _dt_to_text(result.analyzed_at),
                    "engine": result.engine,
                    "depth": result.depth,
                    "summary_json": _json_dump(result.summary),
                    "critical_ply": ",".join(str(p) for p in result.critical_ply),
                    "quality_json": _json_dump(result.quality) if result.quality else None,
                },
                conflict=[t.analysis_results.c.id],
                update_cols=(
                    "analyzed_at", "engine", "depth", "summary_json", "critical_ply",
                    "quality_json",
                ),
            )

    def save_game_batched(
        self,
        game: Game,
        result: Optional[AnalysisResult] = None,
        owner_user_id: Optional[str] = None,
    ) -> None:
        """Persist a classified game with batched writes (one transaction).

        Same rows as ``save_game`` (+ the analysis result when given), but the
        statement count stays near-constant in game length instead of scaling
        per ply (see ``_save_moves_batched``). SQLite and PostgreSQL share this
        path (``_insert`` picks the dialect). Ownership, dedup, and
        analysis-history semantics are unchanged.
        """
        now = _now_text()
        with self.engine.begin() as conn:
            _upsert(
                conn,
                t.games,
                {
                    "id": game.id,
                    "source": game.source.value,
                    "initial_fen": game.initial_fen,
                    "uci_blob": codec.game_uci_blob(game),
                    "white": game.white,
                    "black": game.black,
                    "result": game.result.value,
                    "event": game.event,
                    "site": game.site,
                    "played_at": _dt_to_text(game.played_at),
                    "lichess_id": game.lichess_id,
                    "tags_json": _json_dump(game.tags),
                    "owner_user_id": owner_user_id,
                    "created_at": now,
                    "updated_at": now,
                },
                conflict=[t.games.c.id],
                update_cols=(
                    "source", "initial_fen", "uci_blob", "white", "black", "result",
                    "event", "site", "played_at", "lichess_id", "tags_json", "updated_at",
                ),
                coalesce_cols=("owner_user_id",),
            )
            self._save_moves_batched(conn, game, result)

    def load_game(self, game_id: str, owner_user_id: Optional[str] = None) -> Optional[Game]:
        with self.engine.connect() as conn:
            row = conn.execute(
                select(t.games).where(t.games.c.id == game_id)
            ).mappings().first()
            if row is None:
                return None
            # Ownership gate: when an owner is supplied, a game owned by someone else is
            # treated as not-found (no IDOR via a guessed/known id).
            if owner_user_id is not None and row["owner_user_id"] != owner_user_id:
                return None

            move_rows = conn.execute(
                select(t.moves).where(t.moves.c.game_id == game_id).order_by(t.moves.c.ply)
            ).mappings().all()
            eval_ids: List[Optional[int]] = []
            for move_row in move_rows:
                eval_ids.extend(
                    [
                        move_row["engine_eval_before_id"],
                        move_row["engine_eval_after_id"],
                        move_row["best_move_eval_id"],
                    ]
                )
            evals = self._load_evaluations(conn, eval_ids)
        return self._game_from_rows(row, move_rows, evals)

    def _game_from_rows(self, row, move_rows, evals) -> Game:
        uci_list = codec.decode_uci_sequence(row["uci_blob"])
        annotations: Dict[int, Dict[str, Any]] = {}
        for move_row in move_rows:
            annotations[int(move_row["ply"])] = {
                "source": move_row["source"],
                "classification": move_row["classification"],
                "comment": move_row["comment"],
                "generated_comment": move_row["generated_comment"],
                "generated_meta": _json_load(move_row["generated_meta_json"], None),
                "tags": _json_load(move_row["tags_json"], []),
                "engine_eval_before": evals.get(move_row["engine_eval_before_id"]),
                "engine_eval_after": evals.get(move_row["engine_eval_after_id"]),
                "best_move_uci": move_row["best_move_uci"],
                "best_move_eval": evals.get(move_row["best_move_eval_id"]),
            }
        for ply in range(1, len(uci_list) + 1):
            annotations.setdefault(ply, {"source": row["source"]})
        moves = codec.rebuild_moves(row["initial_fen"], uci_list, annotations)

        game = Game(
            id=row["id"],
            source=MoveSource(row["source"]),
            initial_fen=row["initial_fen"],
            moves=moves,
            white=row["white"],
            black=row["black"],
            result=GameResult(row["result"]),
            event=row["event"],
            site=row["site"],
            played_at=_dt_from_text(row["played_at"]),
            pgn=None,
            lichess_id=row["lichess_id"],
            tags=_json_load(row["tags_json"], {}),
        )
        game.pgn = codec.export_pgn(game)
        return game

    def find_game_id_by_lichess_id(
        self, lichess_id: str, owner_user_id: Optional[str] = None
    ) -> Optional[str]:
        """Dedup lookup for a Lichess game. Owner-scoped: when an owner is supplied
        only that owner's own copy counts, so two users importing the same game each
        keep their own row instead of colliding on a shared one. Unscoped (None)
        keeps the legacy global behaviour for CLI/internal callers."""
        stmt = select(t.games.c.id).where(t.games.c.lichess_id == lichess_id)
        if owner_user_id is not None:
            stmt = stmt.where(t.games.c.owner_user_id == owner_user_id)
        with self.engine.connect() as conn:
            row = conn.execute(stmt).mappings().first()
        return row["id"] if row is not None else None

    def has_game(self, game_id: str) -> bool:
        with self.engine.connect() as conn:
            row = conn.execute(
                select(t.games.c.id).where(t.games.c.id == game_id)
            ).first()
        return row is not None

    def iter_games(self, owner_user_id: Optional[str] = None, *, batch_size: int = 100):
        """Hydrate a bounded page at a time; stable keysets avoid growing OFFSET scans."""
        if batch_size < 1 or batch_size > 100:
            raise ValueError("batch_size must be between 1 and 100")
        cursor = None
        while True:
            stmt = select(t.games).order_by(t.games.c.created_at.desc(), t.games.c.id.desc()).limit(batch_size)
            if owner_user_id is not None:
                stmt = stmt.where(t.games.c.owner_user_id == owner_user_id)
            if cursor is not None:
                created_at, game_id = cursor
                stmt = stmt.where(or_(t.games.c.created_at < created_at,
                                      and_(t.games.c.created_at == created_at, t.games.c.id < game_id)))
            with self.engine.connect() as conn:
                rows = conn.execute(stmt).mappings().all()
                if not rows:
                    return
                ids = [row["id"] for row in rows]
                move_rows = conn.execute(select(t.moves).where(t.moves.c.game_id.in_(ids))
                                         .order_by(t.moves.c.ply)).mappings().all()
                evals = self._load_evaluations(conn, (move[key] for move in move_rows for key in
                    ("engine_eval_before_id", "engine_eval_after_id", "best_move_eval_id")))
            by_game = {game_id: [] for game_id in ids}
            for move in move_rows:
                by_game[move["game_id"]].append(move)
            for row in rows:
                yield self._game_from_rows(row, by_game[row["id"]], evals)
            cursor = (rows[-1]["created_at"], rows[-1]["id"])

    def list_games(self, owner_user_id: Optional[str] = None) -> List[Game]:
        return list(self.iter_games(owner_user_id))

    def _bump_revision(self, conn: Connection, repertoire_id: str) -> None:
        """D-02: every tree/metadata mutation bumps the repertoire revision, so a
        client holding ``base_revision`` can detect stale writes (409)."""
        stmt = update(t.repertoires).where(t.repertoires.c.id == repertoire_id)
        expected = self._expected_revisions.get(repertoire_id)
        if expected is not None:
            stmt = stmt.where(t.repertoires.c.revision == expected)
        changed = conn.execute(stmt.values(revision=t.repertoires.c.revision + 1))
        if expected is not None:
            if changed.rowcount != 1:
                current = conn.scalar(select(t.repertoires.c.revision).where(
                    t.repertoires.c.id == repertoire_id
                ))
                # Raising here rolls back the node/metadata writes in this transaction.
                raise RevisionConflict(current)
            self._expected_revisions[repertoire_id] = expected + 1

    def repertoire_revision(self, repertoire_id: str) -> Optional[int]:
        """Current mutation revision, or None when the repertoire is absent."""
        with self.engine.connect() as conn:
            row = conn.execute(
                select(t.repertoires.c.revision).where(
                    t.repertoires.c.id == repertoire_id
                )
            ).first()
        return int(row[0]) if row is not None else None

    def repertoire_reply_revision(self, repertoire_id: str) -> Optional[int]:
        """A mutation reply must describe its own commit, not a later writer."""
        if repertoire_id in self._expected_revisions:
            return self._expected_revisions[repertoire_id]
        return self.repertoire_revision(repertoire_id)

    def save_repertoire(self, repertoire: Repertoire, owner_user_id: Optional[str] = None) -> None:
        now = _now_text()
        with self.engine.begin() as conn:
            _upsert(
                conn,
                t.repertoires,
                {
                    "id": repertoire.id,
                    "owner_user_id": owner_user_id,
                    "name": repertoire.name,
                    "color": repertoire.color.value,
                    "root_fen": repertoire.root_fen,
                    "root_node_id": repertoire.root_node.id,
                    "main_engine": repertoire.main_engine,
                    "human_model": repertoire.human_model,
                    "branch_depth": repertoire.branch_depth,
                    "opponent_branch_threshold": repertoire.opponent_branch_threshold,
                    "sub_branch_threshold": repertoire.sub_branch_threshold,
                    "max_total_nodes": repertoire.max_total_nodes,
                    "max_line_length": repertoire.max_line_length,
                    "notes": repertoire.notes,
                    "tags_json": _json_dump(repertoire.tags),
                    "is_active": 1 if getattr(repertoire, "is_active", True) else 0,
                    "created_at": now,
                    "updated_at": now,
                },
                conflict=[t.repertoires.c.id],
                update_cols=(
                    "name", "color", "root_fen", "root_node_id", "main_engine",
                    "human_model", "branch_depth", "opponent_branch_threshold",
                    "sub_branch_threshold", "max_total_nodes", "max_line_length",
                    "notes", "tags_json", "is_active", "updated_at",
                ),
                # Never let a re-save reassign an existing owner; only fill a gap.
                coalesce_cols=("owner_user_id",),
            )

            pos_cache: Dict[str, int] = {}
            for node in self._walk_nodes(repertoire.root_node):
                self._save_opening_node(conn, node, pos_cache)
            self._bump_revision(conn, repertoire.id)

    def update_opening_nodes(self, repertoire_id: str, changes: List[Dict[str, Any]]) -> None:
        """Update only the supplied fields on existing nodes in one transaction."""
        if not changes:
            return
        with self.engine.begin() as conn:
            groups: Dict[str, Dict[str, Any]] = {}
            for change in changes:
                values = {key: value for key, value in change.items() if key != "id"}
                key = _json_dump(values)
                group = groups.setdefault(key, {"values": values, "ids": []})
                group["ids"].append(change["id"])
            for group in groups.values():
                values = group["values"]
                values["updated_at"] = _now_text()
                conn.execute(
                    update(t.opening_nodes)
                    .where(t.opening_nodes.c.id.in_(group["ids"]))
                    .where(t.opening_nodes.c.repertoire_id == repertoire_id)
                    .values(**values)
                )
            self._bump_revision(conn, repertoire_id)

    def save_changed_nodes(self, repertoire_id: str, nodes: List[OpeningNode]) -> None:
        """Persist changed or new nodes without walking the rest of the tree."""
        if not nodes:
            return
        with self.engine.begin() as conn:
            pos_cache: Dict[str, int] = {}
            rows = []
            for node in nodes:
                if node.repertoire_id != repertoire_id:
                    raise ValueError("node belongs to another repertoire")
                rows.append(self._opening_node_values(conn, node, pos_cache))
            stmt = _insert(conn, t.opening_nodes)
            stmt = stmt.on_conflict_do_update(
                index_elements=[t.opening_nodes.c.id],
                set_={name: stmt.excluded[name] for name in rows[0]
                      if name not in {"id", "created_at"}},
            )
            conn.execute(stmt, rows)
            self._bump_revision(conn, repertoire_id)

    def update_repertoire_fields(self, repertoire_id: str, **fields: Any) -> None:
        if not fields:
            return
        if fields.keys() - {"name", "is_active"}:
            raise ValueError("unsupported repertoire fields")
        with self.engine.begin() as conn:
            conn.execute(
                update(t.repertoires)
                .where(t.repertoires.c.id == repertoire_id)
                .values(**fields, updated_at=_now_text())
            )
            self._bump_revision(conn, repertoire_id)

    def _repertoire_from_rows(
        self,
        rep_row: Mapping[str, Any],
        node_rows: List[Mapping[str, Any]],
        evals: Mapping[int, EngineEvaluation],
    ) -> Optional[Repertoire]:
        """Assemble + hydrate a Repertoire from already-fetched rows.

        Shared by ``load_repertoire`` (single) and ``list_repertoires`` (batched)
        so both paths build identical trees from identical row shapes — the batch
        path just supplies rows fetched in bulk instead of one round trip each.
        """
        nodes: Dict[str, OpeningNode] = {}
        arriving_uci: Dict[str, Optional[str]] = {}
        for row in node_rows:
            arriving_uci[row["id"]] = row["uci"]
            nodes[row["id"]] = OpeningNode(
                id=row["id"],
                repertoire_id=row["repertoire_id"],
                parent_id=row["parent_id"],
                move=None,
                fen=rep_row["root_fen"],
                side_to_move=Color.WHITE,
                engine_evaluation=evals.get(row["engine_evaluation_id"]),
                maia_probability=row["maia_probability"],
                is_mainline=_int_to_bool(row["is_mainline"]),
                is_user_prepared_move=_int_to_bool(row["is_user_prepared_move"]),
                is_enabled=_int_to_bool(row["is_enabled"]),
                priority=row["priority"],
                comment=row["comment"],
                tags=_json_load(row["tags_json"], []),
                arrows=_json_load(row["arrows_json"], []),
                circles=_json_load(row["circles_json"], []),
                tactical_warning=row["tactical_warning"],
                strategic_idea=row["strategic_idea"],
                typical_plan=row["typical_plan"],
                source=MoveSource(row["source"]),
            )

        root_node = codec.hydrate_opening_tree(rep_row["root_fen"], nodes, arriving_uci)
        if root_node is None:
            return None
        if rep_row["root_node_id"] and rep_row["root_node_id"] in nodes:
            root_node = nodes[rep_row["root_node_id"]]

        repertoire = Repertoire(
            id=rep_row["id"],
            name=rep_row["name"],
            color=Color(rep_row["color"]),
            root_fen=rep_row["root_fen"],
            root_node=root_node,
            main_engine=rep_row["main_engine"],
            human_model=rep_row["human_model"],
            branch_depth=rep_row["branch_depth"],
            opponent_branch_threshold=rep_row["opponent_branch_threshold"],
            sub_branch_threshold=rep_row["sub_branch_threshold"],
            max_total_nodes=rep_row["max_total_nodes"],
            max_line_length=rep_row["max_line_length"],
            notes=rep_row["notes"],
            tags=_json_load(rep_row["tags_json"], []),
            is_active=_int_to_bool(rep_row["is_active"]),
        )
        repertoire._cached_health = _json_load(rep_row["health_json"], None)
        return repertoire

    def load_repertoire(
        self, repertoire_id: str, owner_user_id: Optional[str] = None
    ) -> Optional[Repertoire]:
        with self.engine.connect() as conn:
            rep_row = conn.execute(
                select(t.repertoires).where(t.repertoires.c.id == repertoire_id)
            ).mappings().first()
            if rep_row is None:
                return None
            # Ownership gate: a repertoire owned by someone else is not-found to this owner.
            if owner_user_id is not None and rep_row["owner_user_id"] != owner_user_id:
                return None

            node_rows = conn.execute(
                select(t.opening_nodes).where(t.opening_nodes.c.repertoire_id == repertoire_id)
            ).mappings().all()
            evals = self._load_evaluations(
                conn, [row["engine_evaluation_id"] for row in node_rows]
            )
        return self._repertoire_from_rows(rep_row, node_rows, evals)

    def list_repertoires(self, owner_user_id: Optional[str] = None) -> List[Repertoire]:
        """Full repertoires (optionally owner-scoped), newest first.

        Batched read: one statement for the repertoire rows, one for every opening
        node across them, and one more for the referenced evaluations when any node
        has one — so the statement count is O(1) in the repertoire count (2 without
        referenced evaluations, 3 with), no matter how many repertoires are listed.
        The old shape (id list, then one ``load_repertoire`` round trip per id) grew
        linearly with N: roughly 1 + 2N statements without evaluations and
        1 + 3N with them (per repertoire: the repertoire row, its opening nodes,
        and its evaluation batch), re-walking a connection per row (N+1); public
        behaviour — set, order, and hydrated trees — is unchanged.
        """
        stmt = select(t.repertoires).order_by(t.repertoires.c.updated_at.desc())
        if owner_user_id is not None:
            stmt = stmt.where(t.repertoires.c.owner_user_id == owner_user_id)
        with self.engine.connect() as conn:
            rep_rows = conn.execute(stmt).mappings().all()
            if not rep_rows:
                return []
            node_rows = conn.execute(
                select(t.opening_nodes).where(
                    t.opening_nodes.c.repertoire_id.in_(
                        [row["id"] for row in rep_rows]
                    )
                )
            ).mappings().all()
            evals = self._load_evaluations(
                conn, (row["engine_evaluation_id"] for row in node_rows)
            )
        nodes_by_rep: Dict[str, List[Mapping[str, Any]]] = {}
        for row in node_rows:
            nodes_by_rep.setdefault(row["repertoire_id"], []).append(row)
        out: List[Repertoire] = []
        for rep_row in rep_rows:
            repertoire = self._repertoire_from_rows(
                rep_row, nodes_by_rep.get(rep_row["id"], []), evals
            )
            if repertoire is not None:
                out.append(repertoire)
        return out

    def list_owner_repertoire_listings(
        self, owner_user_id: str
    ) -> List[Dict[str, Any]]:
        """Lightweight owner listing rows for the dashboard — metadata only, no
        opening-tree load and no training-progress scan. Health is computed on
        drill-in (``/api/build/load``) instead of here."""
        stmt = (
            select(
                t.repertoires.c.id,
                t.repertoires.c.name,
                t.repertoires.c.color,
                t.repertoires.c.root_fen,
                t.repertoires.c.notes,
                t.repertoires.c.tags_json,
                t.repertoires.c.is_active,
                t.repertoires.c.team_id,
                t.repertoires.c.visibility,
                t.repertoires.c.health_json,
                t.repertoires.c.revision,
            )
            .where(t.repertoires.c.owner_user_id == owner_user_id)
            .order_by(t.repertoires.c.updated_at.desc())
        )
        with self.engine.connect() as conn:
            rows = conn.execute(stmt).mappings().all()
        # D-01: due counts are time-dependent — recompute live in one grouped
        # query. Static coverage (trainable/mastered/…) stays cached.
        due_counts = self.due_counts_by_repertoire(owner_user_id)
        out = []
        for row in rows:
            health = _json_load(row["health_json"], None)
            if health is not None:
                health = dict(health)
                health["due"] = due_counts.get(row["id"], 0)
            out.append(
                {
                    "id": row["id"],
                    "name": row["name"],
                    "color": row["color"],
                    "root_fen": row["root_fen"],
                    "notes": row["notes"],
                    "tags": _json_load(row["tags_json"], []),
                    "is_active": _int_to_bool(row["is_active"]),
                    "team_id": row["team_id"],
                    "visibility": row["visibility"] or "private",
                    # Cached coverage summary (NULL until the rep is first
                    # opened/trained) with the live due overlay.
                    "health": health,
                    "revision": int(row["revision"] or 0),
                }
            )
        return out

    def set_repertoire_health(
        self, repertoire_id: str, health: Optional[Dict[str, Any]]
    ) -> None:
        """Persist the denormalized health summary for the dashboard list. Called
        from the spots that already compute health off a loaded tree (Build payload,
        train summary), so it adds a single cheap UPDATE and no extra tree walk."""
        with self.engine.begin() as conn:
            conn.execute(
                update(t.repertoires)
                .where(t.repertoires.c.id == repertoire_id)
                .where(t.repertoires.c.health_json.is_distinct_from(
                    _json_dump(health) if health is not None else None
                ))
                .values(health_json=_json_dump(health) if health is not None else None)
            )

    def list_repertoire_metas(
        self, owner_user_id: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """Lightweight ``(id, name, is_active)`` rows for the owner's
        repertoires, newest first — same set and order as ``list_repertoires``
        but without loading any opening tree. Lets a caller decide *which*
        repertoires to act on (e.g. the active ones for a mixed session) before
        paying to load the trees it actually needs."""
        stmt = select(
            t.repertoires.c.id,
            t.repertoires.c.name,
            t.repertoires.c.is_active,
        ).order_by(t.repertoires.c.updated_at.desc())
        if owner_user_id is not None:
            stmt = stmt.where(t.repertoires.c.owner_user_id == owner_user_id)
        with self.engine.connect() as conn:
            rows = conn.execute(stmt).mappings().all()
        return [
            {
                "id": row["id"],
                "name": row["name"],
                "is_active": _int_to_bool(row["is_active"]),
            }
            for row in rows
        ]

    def count_repertoires(self, owner_user_id: Optional[str] = None) -> int:
        """Number of repertoires owned by ``owner_user_id`` (all rows if None),
        without loading any opening trees — used by the Free-plan quota gate."""
        stmt = select(func.count()).select_from(t.repertoires)
        if owner_user_id is not None:
            stmt = stmt.where(t.repertoires.c.owner_user_id == owner_user_id)
        with self.engine.connect() as conn:
            return int(conn.execute(stmt).scalar_one())

    def repertoire_meta(self, repertoire_id: str) -> Optional[Dict[str, Any]]:
        """Lightweight ``(id, name, is_active, owner_user_id, team_id, visibility)`` for
        owner/share-gating and write responses, without loading the whole opening tree.
        ``None`` if absent; ``owner_user_id``/``team_id`` are ``None`` for an
        unclaimed/unshared row, and ``visibility`` defaults to ``"private"``."""
        with self.engine.connect() as conn:
            row = conn.execute(
                select(
                    t.repertoires.c.id,
                    t.repertoires.c.name,
                    t.repertoires.c.is_active,
                    t.repertoires.c.owner_user_id,
                    t.repertoires.c.team_id,
                    t.repertoires.c.visibility,
                    t.repertoires.c.revision,
                    t.repertoires.c.share_rev,
                    t.repertoires.c.share_enabled,
                    t.repertoires.c.share_expires_at,
                ).where(t.repertoires.c.id == repertoire_id)
            ).mappings().first()
        if row is None:
            return None
        return {
            "id": row["id"],
            "name": row["name"],
            "is_active": _int_to_bool(row["is_active"]),
            "owner_user_id": row["owner_user_id"],
            "team_id": row["team_id"],
            "visibility": row["visibility"] or "private",
            "revision": int(row["revision"] or 0),
            "share_rev": int(row["share_rev"] or 0),
            "share_enabled": _int_to_bool(row["share_enabled"]),
            "share_expires_at": row["share_expires_at"],
        }

    def set_share_state(
        self,
        repertoire_id: str,
        *,
        enabled: Optional[bool] = None,
        rotate: bool = False,
        expires_at: Optional[str] = None,
        clear_expiry: bool = False,
    ) -> Dict[str, Any]:
        """F-01: public share-link governance. ``enabled`` toggles the link
        independently of team sharing, ``rotate`` bumps ``share_rev`` (killing
        every previously minted link), ``expires_at`` (ISO text) or
        ``clear_expiry`` set the optional deadline. Returns the fresh state."""
        values: Dict[str, Any] = {"updated_at": _now_text()}
        if enabled is not None:
            values["share_enabled"] = 1 if enabled else 0
        if rotate:
            values["share_rev"] = t.repertoires.c.share_rev + 1
        if clear_expiry:
            values["share_expires_at"] = None
        elif expires_at is not None:
            values["share_expires_at"] = expires_at
        with self.engine.begin() as conn:
            conn.execute(
                update(t.repertoires)
                .where(t.repertoires.c.id == repertoire_id)
                .values(**values)
            )
            row = conn.execute(
                select(
                    t.repertoires.c.share_rev,
                    t.repertoires.c.share_enabled,
                    t.repertoires.c.share_expires_at,
                ).where(t.repertoires.c.id == repertoire_id)
            ).first()
        return {
            "share_rev": int(row[0] or 0),
            "share_enabled": bool(row[1]),
            "share_expires_at": row[2],
        }

    def due_counts_by_repertoire(
        self, owner_user_id: str, *, now: Optional[datetime] = None
    ) -> Dict[str, int]:
        """D-01/D-02: live due-review counts per repertoire.

        Time-dependent numbers are never served from the cached health JSON —
        one grouped statement per listing (no N+1) — but the count must mean
        the SAME thing ``compute_health().due`` means, or the Library badge and
        the Smart queue disagree (the library could promise reviews nothing can
        be scheduled for). So this counts a node as due only when:

        - it is REACHABLE: every ancestor is enabled (the effective-enabled
          rule — a disabled node makes its whole subtree untrainable), and
        - it is TRAINABLE: an enabled own-side move (``is_user_prepared_move``
          is the server-recomputed "parent's side to move is the repertoire
          colour" flag, i.e. exactly ``_is_trainable``'s move-side test), and
        - its mastery is ``due``: attempts > 0, not ``weak``, and
          ``due_at <= now`` — weak is checked BEFORE due in
          ``services.progress.node_mastery``, so a weak-and-due node counts as
          weak, here as everywhere else.

        "due" therefore means "scheduled for review now", not merely "has a
        due_at timestamp in the past".
        """
        # Imported here, not at module scope: services/__init__ imports the
        # repository, so a top-level import would be circular.
        from prepforge_chess.services.progress import WEAK_SCORE_BELOW

        tp = t.training_progress
        nodes = t.opening_nodes
        now_text = _dt_to_text(now or datetime.now(timezone.utc))
        # The walk is scoped to THIS owner's repertoires. The outer query already
        # filters on tp.owner_user_id and node ids are globally unique, so the
        # scope cannot change the counts — it only keeps the recursion off
        # every other tenant's trees (the Library listing runs this per owner).
        owner_reps = select(t.repertoires.c.id).where(
            t.repertoires.c.owner_user_id == owner_user_id
        )
        # blocked = 1 once a DISABLED ancestor is on the path (the node's own
        # disabled flag is checked separately below, matching _is_trainable).
        blocked = (
            select(nodes.c.id.label("id"), literal(0).label("blocked"))
            .where(nodes.c.parent_id.is_(None))
            .where(nodes.c.repertoire_id.in_(owner_reps))
            .cte("effective_nodes", recursive=True)
        )
        blocked = blocked.union_all(
            select(
                nodes.c.id,
                case(
                    (blocked.c.blocked > 0, literal(1)),
                    (nodes.c.is_enabled == 0, literal(1)),
                    else_=literal(0),
                ),
            )
            .where(nodes.c.parent_id == blocked.c.id)
            .where(nodes.c.repertoire_id.in_(owner_reps))
        )
        # weak, in SQL: attempts >= 2 and lifetime accuracy below half and the
        # recent-form score still low. correct*2 < attempts avoids the
        # integer/float division difference between SQLite and Postgres.
        is_weak = and_(
            tp.c.attempts >= 2,
            tp.c.correct_attempts * 2 < tp.c.attempts,
            tp.c.spaced_repetition_score < WEAK_SCORE_BELOW,
        )
        stmt = (
            select(tp.c.repertoire_id, func.count())
            .select_from(
                tp.join(blocked, blocked.c.id == tp.c.node_id).join(
                    nodes, nodes.c.id == tp.c.node_id
                )
            )
            .where(tp.c.owner_user_id == owner_user_id)
            .where(tp.c.due_at.is_not(None))
            .where(tp.c.due_at <= now_text)
            .where(blocked.c.blocked == 0)
            .where(nodes.c.is_enabled == 1)
            .where(nodes.c.is_user_prepared_move == 1)
            .where(nodes.c.uci.is_not(None))
            .where(tp.c.attempts > 0)
            .where(not_(is_weak))
            .group_by(tp.c.repertoire_id)
        )
        with self.engine.connect() as conn:
            rows = conn.execute(stmt).all()
        return {row[0]: int(row[1]) for row in rows}

    def set_repertoire_sharing(
        self, repertoire_id: str, team_id: Optional[str], visibility: str
    ) -> None:
        """Set the team a repertoire is shared with and its visibility. Pass
        ``team_id=None`` + ``visibility='private'`` to unshare."""
        with self.engine.begin() as conn:
            conn.execute(
                update(t.repertoires)
                .where(t.repertoires.c.id == repertoire_id)
                .values(team_id=team_id, visibility=visibility, updated_at=_now_text())
            )

    def list_team_shared_repertoires(self, team_ids: List[str]) -> List[Dict[str, Any]]:
        """Lightweight metas of every repertoire shared (``visibility='team'``) to any
        of ``team_ids`` — for the team members' read-only listing. Empty list if no
        team_ids, so a non-member never widens the query."""
        if not team_ids:
            return []
        with self.engine.connect() as conn:
            rows = conn.execute(
                select(
                    t.repertoires.c.id,
                    t.repertoires.c.name,
                    t.repertoires.c.color,
                    t.repertoires.c.root_fen,
                    t.repertoires.c.owner_user_id,
                    t.repertoires.c.team_id,
                )
                .where(t.repertoires.c.team_id.in_(team_ids))
                .where(t.repertoires.c.visibility == "team")
                .order_by(t.repertoires.c.updated_at.desc())
            ).mappings().all()
        return [
            {
                "id": r["id"],
                "name": r["name"],
                "color": r["color"],
                "root_fen": r["root_fen"],
                "owner_user_id": r["owner_user_id"],
                "team_id": r["team_id"],
            }
            for r in rows
        ]

    def list_repertoires_shared_to_team(self, team_id: str) -> List[Dict[str, Any]]:
        """Lightweight metas of repertoires shared (``visibility='team'``) to one team."""
        with self.engine.connect() as conn:
            rows = conn.execute(
                select(
                    t.repertoires.c.id,
                    t.repertoires.c.name,
                    t.repertoires.c.color,
                    t.repertoires.c.owner_user_id,
                )
                .where(t.repertoires.c.team_id == team_id)
                .where(t.repertoires.c.visibility == "team")
                .order_by(t.repertoires.c.updated_at.desc())
            ).mappings().all()
        return [
            {
                "id": r["id"],
                "name": r["name"],
                "color": r["color"],
                "owner_user_id": r["owner_user_id"],
            }
            for r in rows
        ]

    def unshare_all_for_team(self, team_id: str) -> None:
        """Make every repertoire shared to ``team_id`` private again (team delete)."""
        with self.engine.begin() as conn:
            conn.execute(
                update(t.repertoires)
                .where(t.repertoires.c.team_id == team_id)
                .values(team_id=None, visibility="private", updated_at=_now_text())
            )

    def set_repertoire_active(self, repertoire_id: str, active: bool) -> None:
        with self.engine.begin() as conn:
            conn.execute(
                update(t.repertoires)
                .where(t.repertoires.c.id == repertoire_id)
                .values(is_active=_bool_to_int(active), updated_at=_now_text())
            )

    def claim_repertoire(self, repertoire_id: str, owner_user_id: str) -> None:
        """Stamp ownership on a just-created repertoire (the builder saves it
        ownerless). No-op if the row already has an owner — never reassign one
        user's repertoire to another."""
        with self.engine.begin() as conn:
            conn.execute(
                update(t.repertoires)
                .where(
                    t.repertoires.c.id == repertoire_id,
                    t.repertoires.c.owner_user_id.is_(None),
                )
                .values(owner_user_id=owner_user_id)
            )

    def claim_or_verify_game(self, game_id: str, owner_user_id: str) -> bool:
        """Stamp ownership on an unowned game (first writer wins) and report whether
        the caller may access it. Returns ``False`` when the game is missing or owned
        by a *different* user — the caller treats that as not-found."""
        with self.engine.begin() as conn:
            conn.execute(
                update(t.games)
                .where(t.games.c.id == game_id, t.games.c.owner_user_id.is_(None))
                .values(owner_user_id=owner_user_id)
            )
            row = conn.execute(
                select(t.games.c.owner_user_id).where(t.games.c.id == game_id)
            ).mappings().first()
        return row is not None and row["owner_user_id"] == owner_user_id

    def delete_repertoire(self, repertoire_id: str) -> None:
        with self.engine.begin() as conn:
            conn.execute(delete(t.repertoires).where(t.repertoires.c.id == repertoire_id))

    # ---- Data lifecycle (D-06) ------------------------------------------
    # Counts first, deletes second: shared engine data (positions / immutable
    # evaluation snapshots) is never cascade-deleted with user content — two
    # owners' identical analyses can share one snapshot row — it is reclaimed
    # here only when nothing references it any more.

    def _orphan_eval_select(self) -> Any:
        referenced = union(
            select(t.moves.c.engine_eval_before_id.label("id")).where(
                t.moves.c.engine_eval_before_id.is_not(None)
            ),
            select(t.moves.c.engine_eval_after_id.label("id")).where(
                t.moves.c.engine_eval_after_id.is_not(None)
            ),
            select(t.moves.c.best_move_eval_id.label("id")).where(
                t.moves.c.best_move_eval_id.is_not(None)
            ),
            select(t.opening_nodes.c.engine_evaluation_id.label("id")).where(
                t.opening_nodes.c.engine_evaluation_id.is_not(None)
            ),
        )
        return select(t.engine_evaluations.c.id).where(
            ~t.engine_evaluations.c.id.in_(referenced)
        )

    def count_orphan_evaluations(self) -> int:
        with self.engine.connect() as conn:
            return int(
                conn.execute(
                    select(func.count()).select_from(self._orphan_eval_select().subquery())
                ).scalar_one()
            )

    def delete_orphan_evaluations(self) -> int:
        with self.engine.begin() as conn:
            ids = [row[0] for row in conn.execute(self._orphan_eval_select()).all()]
            if not ids:
                return 0
            conn.execute(
                delete(t.engine_evaluations).where(t.engine_evaluations.c.id.in_(ids))
            )
            return len(ids)

    def _orphan_position_select(self) -> Any:
        referenced = select(t.engine_evaluations.c.position_id.label("id"))
        return select(t.positions.c.id).where(~t.positions.c.id.in_(referenced))

    def count_orphan_positions(self) -> int:
        with self.engine.connect() as conn:
            return int(
                conn.execute(
                    select(func.count()).select_from(self._orphan_position_select().subquery())
                ).scalar_one()
            )

    def delete_orphan_positions(self) -> int:
        with self.engine.begin() as conn:
            ids = [row[0] for row in conn.execute(self._orphan_position_select()).all()]
            if not ids:
                return 0
            conn.execute(delete(t.positions).where(t.positions.c.id.in_(ids)))
            return len(ids)

    def count_receipts_before(self, cutoff_text: str) -> int:
        with self.engine.connect() as conn:
            return int(
                conn.execute(
                    select(func.count()).select_from(t.train_attempt_receipts).where(
                        t.train_attempt_receipts.c.created_at < cutoff_text
                    )
                ).scalar_one()
            )

    def delete_receipts_before(self, cutoff_text: str) -> int:
        with self.engine.begin() as conn:
            result = conn.execute(
                delete(t.train_attempt_receipts).where(
                    t.train_attempt_receipts.c.created_at < cutoff_text
                )
            )
            return int(result.rowcount or 0)

    def count_analysis_snapshots(self) -> int:
        with self.engine.connect() as conn:
            return int(
                conn.execute(
                    select(func.count()).select_from(t.analysis_results)
                ).scalar_one()
            )

    def _trimable_analysis_ids(self, keep_per_game: int) -> List[str]:
        """Ids of analysis rows beyond the newest ``keep_per_game`` per game."""
        with self.engine.connect() as conn:
            rows = conn.execute(
                select(
                    t.analysis_results.c.id,
                    t.analysis_results.c.game_id,
                    t.analysis_results.c.analyzed_at,
                ).order_by(
                    t.analysis_results.c.game_id,
                    t.analysis_results.c.analyzed_at.desc(),
                    t.analysis_results.c.id.desc(),
                )
            ).all()
        seen: Dict[str, int] = {}
        drop: List[str] = []
        for row in rows:
            count = seen.get(row.game_id, 0)
            if count < keep_per_game:
                seen[row.game_id] = count + 1
            else:
                drop.append(row.id)
        return drop

    def count_trimable_analyses(self, keep_per_game: int) -> int:
        return len(self._trimable_analysis_ids(keep_per_game))

    def delete_trimable_analyses(self, keep_per_game: int) -> int:
        ids = self._trimable_analysis_ids(keep_per_game)
        if not ids:
            return 0
        with self.engine.begin() as conn:
            conn.execute(delete(t.analysis_results).where(t.analysis_results.c.id.in_(ids)))
        return len(ids)

    def list_owner_settings(self, owner_user_id: str) -> Dict[str, Any]:
        """All stored settings keys for one owner (account export, F-05)."""
        with self.engine.connect() as conn:
            rows = conn.execute(
                select(t.user_settings.c.key, t.user_settings.c.value_json).where(
                    t.user_settings.c.user_id == owner_user_id
                )
            ).all()
        return {row[0]: _json_load(row[1], None) for row in rows}

    def list_owner_training_progress(self, owner_user_id: str) -> List[Dict[str, Any]]:
        return list(self.iter_owner_training_progress(owner_user_id))

    def iter_owner_training_progress(self, owner_user_id: str):
        """Raw progress rows across all repertoires (account export, F-05)."""
        with self.engine.connect() as conn:
            rows = conn.execute(
                select(t.training_progress).where(
                    t.training_progress.c.owner_user_id == owner_user_id
                )
             .execution_options(yield_per=100)).mappings()
            for row in rows:
                yield {
                    "repertoire_id": row["repertoire_id"],
                    "node_id": row["node_id"],
                    "attempts": row["attempts"],
                    "correct_attempts": row["correct_attempts"],
                    "last_reviewed_at": row["last_reviewed_at"],
                    "spaced_repetition_score": row["spaced_repetition_score"],
                    "due_at": row["due_at"],
                    "is_mastered": _int_to_bool(row["is_mastered"]),
                }

    def list_owner_training_sessions(self, owner_user_id: str) -> List[Dict[str, Any]]:
        return list(self.iter_owner_training_sessions(owner_user_id))

    def iter_owner_training_sessions(self, owner_user_id: str):
        """Session summaries across the owner's repertoires (account export, F-05)."""
        with self.engine.connect() as conn:
            rows = conn.execute(
                select(t.training_sessions)
                .join(
                    t.repertoires,
                    t.repertoires.c.id == t.training_sessions.c.repertoire_id,
                )
                .where(t.repertoires.c.owner_user_id == owner_user_id)
             .execution_options(yield_per=100)).mappings()
            for row in rows:
                yield {
                    "id": row["id"],
                    "repertoire_id": row["repertoire_id"],
                    "mode": row["mode"],
                    "current_index": row["current_index"],
                    "mistakes": _json_load(row["mistakes_json"], []),
                    "mastered_nodes": _json_load(row["mastered_nodes_json"], []),
                    "created_at": row["created_at"],
                    "updated_at": row["updated_at"],
                }

    def delete_owner_data(
        self, owner_user_id: str, *, conn: Optional[Connection] = None
    ) -> Dict[str, int]:
        """Delete everything one owner owns, with per-table counts (F-05).

        User content cascades (games → moves/analysis, repertoires →
        nodes/progress/sessions/receipts); shared engine data (positions,
        evaluation snapshots) is intentionally left to the lifecycle reclaim.
        Sessions and reset tokens go with the account so no live credential
        outlives the deletion; share links die with their repertoire row.

        Pass ``conn`` to run inside a caller-owned transaction (D-05): account
        deletion also removes identity rows through an ORM Session, and two
        independent transactions can leave a half-deleted account ("content
        gone, login still works"). Sharing the connection makes it one unit of
        work that either commits or rolls back whole.
        """
        if conn is not None:
            return self._delete_owner_data(conn, owner_user_id)
        with self.engine.begin() as owned:
            return self._delete_owner_data(owned, owner_user_id)

    def _delete_owner_data(self, conn: Connection, owner_user_id: str) -> Dict[str, int]:
        """Conn-scoped body of :meth:`delete_owner_data` (see there for the contract)."""
        counts: Dict[str, int] = {}
        game_ids = [
            row[0]
            for row in conn.execute(
                select(t.games.c.id).where(t.games.c.owner_user_id == owner_user_id)
            ).all()
        ]
        rep_ids = [
            row[0]
            for row in conn.execute(
                select(t.repertoires.c.id).where(
                    t.repertoires.c.owner_user_id == owner_user_id
                )
            ).all()
        ]
        # Receipts hang off training sessions of the owner's repertoires.
        session_ids = [
            row[0]
            for row in conn.execute(
                select(t.training_sessions.c.id).where(
                    t.training_sessions.c.repertoire_id.in_(rep_ids)
                )
            ).all()
        ] if rep_ids else []

        def _count(table, where) -> int:
            return int(
                conn.execute(select(func.count()).select_from(table).where(where)).scalar_one()
            )

        if session_ids:
            counts["train_attempt_receipts"] = _count(
                t.train_attempt_receipts,
                t.train_attempt_receipts.c.session_id.in_(session_ids),
            )
            conn.execute(
                delete(t.train_attempt_receipts).where(
                    t.train_attempt_receipts.c.session_id.in_(session_ids)
                )
            )
        else:
            counts["train_attempt_receipts"] = 0
        counts["training_progress"] = _count(
            t.training_progress, t.training_progress.c.owner_user_id == owner_user_id
        )
        conn.execute(
            delete(t.training_progress).where(
                t.training_progress.c.owner_user_id == owner_user_id
            )
        )
        counts["training_sessions"] = len(session_ids)
        if session_ids:
            conn.execute(
                delete(t.training_sessions).where(
                    t.training_sessions.c.id.in_(session_ids)
                )
            )
        counts["analysis_results"] = (
            _count(t.analysis_results, t.analysis_results.c.game_id.in_(game_ids))
            if game_ids
            else 0
        )
        if game_ids:
            conn.execute(
                delete(t.analysis_results).where(
                    t.analysis_results.c.game_id.in_(game_ids)
                )
            )
        counts["moves"] = (
            _count(t.moves, t.moves.c.game_id.in_(game_ids)) if game_ids else 0
        )
        if game_ids:
            conn.execute(delete(t.moves).where(t.moves.c.game_id.in_(game_ids)))
        counts["games"] = len(game_ids)
        if game_ids:
            conn.execute(delete(t.games).where(t.games.c.id.in_(game_ids)))
        counts["opening_nodes"] = (
            _count(t.opening_nodes, t.opening_nodes.c.repertoire_id.in_(rep_ids))
            if rep_ids
            else 0
        )
        if rep_ids:
            conn.execute(
                delete(t.opening_nodes).where(
                    t.opening_nodes.c.repertoire_id.in_(rep_ids)
                )
            )
        counts["repertoires"] = len(rep_ids)
        if rep_ids:
            conn.execute(
                delete(t.repertoires).where(t.repertoires.c.id.in_(rep_ids))
            )
        counts["user_settings"] = _count(
            t.user_settings, t.user_settings.c.user_id == owner_user_id
        )
        conn.execute(
            delete(t.user_settings).where(t.user_settings.c.user_id == owner_user_id)
        )
        return counts

    def delete_opening_nodes(self, repertoire_id: str, node_ids: List[str]) -> None:
        if not node_ids:
            return
        with self.engine.begin() as conn:
            # Clear references that don't cascade, otherwise the node delete trips
            # a FOREIGN KEY constraint (e.g. a live training session still points
            # at one of these nodes via current_node_id).
            conn.execute(
                update(t.training_sessions)
                .where(t.training_sessions.c.current_node_id.in_(node_ids))
                .values(current_node_id=None)
            )
            conn.execute(
                delete(t.opening_nodes).where(
                    t.opening_nodes.c.repertoire_id == repertoire_id,
                    t.opening_nodes.c.id.in_(node_ids),
                )
            )
            self._bump_revision(conn, repertoire_id)

    def save_training_session(self, session: TrainingSession) -> None:
        with self.engine.begin() as conn:
            self.write_training_session(conn, session)

    def write_training_session(self, conn: Connection, session: TrainingSession) -> None:
        """Conn-scoped ``save_training_session``: run inside the caller's
        transaction so the session write commits together with related writes
        (attempt receipts, progress rows)."""
        _upsert(
            conn,
            t.training_sessions,
            {
                "id": session.id,
                "repertoire_id": session.repertoire_id,
                "mode": session.mode.value,
                "line_order_json": _json_dump(session.line_order),
                "current_index": session.current_index,
                "current_node_id": session.current_node_id,
                "mistakes_json": _json_dump(session.mistakes),
                "mastered_nodes_json": _json_dump(session.mastered_nodes),
                "seed": session.seed,
                "created_at": _dt_to_text(session.created_at),
                "updated_at": _dt_to_text(session.updated_at),
            },
            conflict=[t.training_sessions.c.id],
            update_cols=(
                "repertoire_id", "mode", "line_order_json", "current_index",
                "current_node_id", "mistakes_json", "mastered_nodes_json", "seed",
                # A rebuilt smart queue reuses its row; created_at is its
                # session generation (see /api/train/smart/start).
                "created_at", "updated_at",
            ),
        )

    def load_training_session(self, session_id: str) -> Optional[TrainingSession]:
        with self.engine.connect() as conn:
            row = conn.execute(
                select(t.training_sessions).where(t.training_sessions.c.id == session_id)
            ).mappings().first()
        return self._training_session_from_row(row) if row is not None else None

    def load_latest_training_session(
        self,
        repertoire_id: str,
        mode: Optional[TrainingMode] = None,
    ) -> Optional[TrainingSession]:
        stmt = (
            select(t.training_sessions)
            .where(t.training_sessions.c.repertoire_id == repertoire_id)
            .order_by(t.training_sessions.c.updated_at.desc())
            .limit(1)
        )
        if mode is not None:
            stmt = stmt.where(t.training_sessions.c.mode == mode.value)
        with self.engine.connect() as conn:
            row = conn.execute(stmt).mappings().first()
        return self._training_session_from_row(row) if row is not None else None

    def lock_training_session(
        self,
        conn: Connection,
        *,
        session_id: str,
    ) -> Optional[TrainingSession]:
        """Read-modify-write handle on one session row inside an open transaction.

        Reads the row FOR UPDATE so concurrent updaters of the same session
        serialise here (PostgreSQL) and each computes from the other's committed
        state instead of a pre-transaction snapshot — a full-row upsert built
        from a stale snapshot silently clobbers the other sync's mistakes,
        mastered nodes, and position. Follow up with ``write_training_session``
        before the transaction ends. Returns None when the row is absent."""
        row = (
            conn.execute(
                select(t.training_sessions)
                .where(t.training_sessions.c.id == session_id)
                .with_for_update()
            )
            .mappings()
            .first()
        )
        return self._training_session_from_row(row) if row is not None else None

    def save_training_progress(
        self,
        repertoire_id: str,
        progress: TrainingProgress,
        *,
        owner_user_id: str,
    ) -> None:
        with self.engine.begin() as conn:
            self.write_training_progress(
                conn,
                repertoire_id=repertoire_id,
                progress=progress,
                owner_user_id=owner_user_id,
            )

    def write_training_progress(
        self,
        conn: Connection,
        *,
        repertoire_id: str,
        progress: TrainingProgress,
        owner_user_id: str,
    ) -> None:
        """Conn-scoped ``save_training_progress``: run inside the caller's
        transaction so the progress write commits together with related writes
        (attempt receipts, ingest ledgers)."""
        progress_id = self._training_progress_id(owner_user_id, repertoire_id, progress.node_id)
        now = _now_text()
        _upsert(
            conn,
            t.training_progress,
            {
                "id": progress_id,
                "owner_user_id": owner_user_id,
                "repertoire_id": repertoire_id,
                "node_id": progress.node_id,
                "attempts": progress.attempts,
                "correct_attempts": progress.correct_attempts,
                "last_reviewed_at": _dt_to_text(progress.last_reviewed_at),
                "spaced_repetition_score": progress.spaced_repetition_score,
                "due_at": _dt_to_text(progress.due_at),
                "is_mastered": _bool_to_int(progress.is_mastered),
                "created_at": now,
                "updated_at": now,
            },
            conflict=[t.training_progress.c.id],
            update_cols=(
                "attempts", "correct_attempts", "last_reviewed_at",
                "spaced_repetition_score", "due_at", "is_mastered", "updated_at",
            ),
        )

    def lock_training_progress(
        self,
        conn: Connection,
        *,
        repertoire_id: str,
        node_id: str,
        owner_user_id: str,
    ) -> TrainingProgress:
        """Read-modify-write handle on one progress row inside an open transaction.

        Insert-claims the row when absent (``ON CONFLICT DO NOTHING``) and then
        reads it FOR UPDATE. On PostgreSQL concurrent updaters of the same node
        serialise here and each computes from the other's committed values, so
        parallel attempts can never lose an update; when the row was missing the
        racing inserter blocks on the claim instead of blind-overwriting. Returns
        a zeroed progress for a freshly claimed row. Follow up with
        ``write_training_progress`` before the transaction ends.
        """
        progress_id = self._training_progress_id(owner_user_id, repertoire_id, node_id)
        now = _now_text()
        conn.execute(
            _insert(conn, t.training_progress)
            .values(
                id=progress_id,
                owner_user_id=owner_user_id,
                repertoire_id=repertoire_id,
                node_id=node_id,
                attempts=0,
                correct_attempts=0,
                last_reviewed_at=None,
                spaced_repetition_score=0.0,
                due_at=None,
                is_mastered=0,
                created_at=now,
                updated_at=now,
            )
            .on_conflict_do_nothing(index_elements=[t.training_progress.c.id])
        )
        row = conn.execute(
            select(t.training_progress)
            .where(t.training_progress.c.id == progress_id)
            .with_for_update()
        ).mappings().first()
        return self._training_progress_from_row(row)

    def load_training_progress(
        self,
        repertoire_id: str,
        node_id: str,
        *,
        owner_user_id: str,
    ) -> Optional[TrainingProgress]:
        progress_id = self._training_progress_id(owner_user_id, repertoire_id, node_id)
        with self.engine.connect() as conn:
            row = conn.execute(
                select(t.training_progress).where(t.training_progress.c.id == progress_id)
            ).mappings().first()
        if row is None:
            return None
        return self._training_progress_from_row(row)

    def existing_move_signature_ids(
        self, owner_user_id: Optional[str] = None
    ) -> Dict[str, str]:
        """Map each stored game's move-signature to its game id, so a re-imported
        game (no lichess id) is detected as a duplicate AND resolved back to the
        already-stored game rather than a fresh, unsaved candidate.

        The signature is ``codec.move_signature``: the starting position PLUS the
        UCI sequence, so two games with identical moves from different starting
        positions stay distinct (a move-sequence-only signature conflated them).

        Owner-scoped: when an owner is supplied only that owner's games are
        considered, so one user pasting a PGN another user already stored gets their
        own owned copy rather than being bounced to the other user's game."""
        stmt = select(t.games.c.id, t.games.c.uci_blob, t.games.c.initial_fen)
        if owner_user_id is not None:
            stmt = stmt.where(t.games.c.owner_user_id == owner_user_id)
        with self.engine.connect() as conn:
            rows = conn.execute(stmt).mappings().all()
        signatures: Dict[str, str] = {}
        for row in rows:
            ucis = codec.decode_uci_sequence(row["uci_blob"])
            if not ucis:
                continue
            # Keep the first game id seen for a signature (stable across calls).
            signatures.setdefault(codec.move_signature(row["initial_fen"], ucis), row["id"])
        return signatures

    def list_training_progress(
        self,
        repertoire_id: str,
        *,
        owner_user_id: str,
    ) -> List[TrainingProgress]:
        """All stored progress rows for a repertoire (for heatmap / due queue)."""
        tp = t.training_progress
        owner_cond = tp.c.owner_user_id == owner_user_id
        with self.engine.connect() as conn:
            rows = conn.execute(
                select(tp).where(tp.c.repertoire_id == repertoire_id, owner_cond)
            ).mappings().all()
        return [self._training_progress_from_row(row) for row in rows]

    def save_analysis_result(self, result: AnalysisResult) -> None:
        analysis_id = self._analysis_result_id(result)
        with self.engine.begin() as conn:
            _upsert(
                conn,
                t.analysis_results,
                {
                    "id": analysis_id,
                    "game_id": result.game_id,
                    "analyzed_at": _dt_to_text(result.analyzed_at),
                    "engine": result.engine,
                    "depth": result.depth,
                    "summary_json": _json_dump(result.summary),
                    "critical_ply": ",".join(str(p) for p in result.critical_ply),
                    "quality_json": _json_dump(result.quality) if result.quality else None,
                },
                conflict=[t.analysis_results.c.id],
                update_cols=(
                    "analyzed_at", "engine", "depth", "summary_json", "critical_ply",
                    "quality_json",
                ),
            )

    def list_analyzed_games(
        self,
        owner_user_id: Optional[str] = None,
        *,
        limit: int = 50,
        cursor: Optional[tuple] = None,
    ) -> tuple[List[Dict[str, Any]], Optional[tuple]]:
        """One page of metadata for games with a saved analysis (latest per
        game), newest first — powers the Analyze "History" list. Analyses are
        owned transitively through their game, so scoping joins on
        ``games.owner_user_id``.

        D-05: fixed page size + stable keyset cursor on ``(analyzed_at,
        game_id)`` — equal timestamps page without gaps or repeats — and the
        latest-analysis aggregation is owner-scoped from the inside, so a big
        account never aggregates other owners' games first.

        D-03: the latest snapshot per game is picked by ROW_NUMBER over
        ``(analyzed_at DESC, id DESC)``. The old ``max(analyzed_at)`` join
        could not break a tie, so two snapshots written in the same instant
        both matched and the SAME game appeared twice in one page."""
        ar = t.analysis_results
        g = t.games
        ranked = select(
            ar.c.game_id.label("game_id"),
            ar.c.analyzed_at.label("analyzed_at"),
            ar.c.engine.label("engine"),
            ar.c.depth.label("depth"),
            ar.c.summary_json.label("summary_json"),
            g.c.white.label("white"),
            g.c.black.label("black"),
            g.c.result.label("result"),
            g.c.played_at.label("played_at"),
            g.c.lichess_id.label("lichess_id"),
            func.row_number()
            .over(
                partition_by=ar.c.game_id,
                order_by=(ar.c.analyzed_at.desc(), ar.c.id.desc()),
            )
            .label("rn"),
        ).select_from(ar.join(g, g.c.id == ar.c.game_id))
        # Owner-scoped aggregation: only this owner's games enter the "latest
        # per game" ranking (D-05).
        if owner_user_id is not None:
            ranked = ranked.where(g.c.owner_user_id == owner_user_id)
        ranked = ranked.subquery()
        stmt = select(ranked).where(ranked.c.rn == 1)
        stmt = stmt.order_by(ranked.c.analyzed_at.desc(), ranked.c.game_id.desc()).limit(
            max(1, min(int(limit), 200)) + 1
        )  # +1: detect a next page
        if cursor is not None:
            cursor_at, cursor_id = cursor
            stmt = stmt.where(
                (ranked.c.analyzed_at < cursor_at)
                | ((ranked.c.analyzed_at == cursor_at) & (ranked.c.game_id < cursor_id))
            )
        with self.engine.connect() as conn:
            rows = conn.execute(stmt).mappings().all()
        page_size = max(1, min(int(limit), 200))
        has_more = len(rows) > page_size
        rows = rows[:page_size]
        items = [
            {
                "game_id": row["game_id"],
                "analyzed_at": row["analyzed_at"],
                "engine": row["engine"],
                "depth": row["depth"],
                "summary": _json_load(row["summary_json"], {}),
                "white": row["white"],
                "black": row["black"],
                "result": row["result"],
                "played_at": row["played_at"],
                "lichess_id": row["lichess_id"],
            }
            for row in rows
        ]
        next_cursor = None
        if has_more and items:
            next_cursor = (items[-1]["analyzed_at"], items[-1]["game_id"])
        return items, next_cursor

    def load_latest_analysis_result(
        self, game_id: str, owner_user_id: Optional[str] = None
    ) -> Optional[AnalysisResult]:
        with self.engine.connect() as conn:
            # The analysis is owned through its game; gate on the game's owner first.
            if owner_user_id is not None:
                game_row = conn.execute(
                    select(t.games.c.owner_user_id).where(t.games.c.id == game_id)
                ).mappings().first()
                if game_row is None or game_row["owner_user_id"] != owner_user_id:
                    return None
            row = conn.execute(
                select(t.analysis_results)
                .where(t.analysis_results.c.game_id == game_id)
                .order_by(t.analysis_results.c.analyzed_at.desc())
                .limit(1)
            ).mappings().first()
        if row is None:
            return None

        game = self.load_game(game_id)
        return AnalysisResult(
            game_id=row["game_id"],
            analyzed_at=_dt_from_text(row["analyzed_at"]) or datetime.now(timezone.utc),
            engine=row["engine"],
            depth=row["depth"],
            move_results=game.moves if game is not None else [],
            summary=_json_load(row["summary_json"], {}),
            critical_ply=_parse_critical_ply(row["critical_ply"]),
            quality=_json_load(row["quality_json"], None),
        )

    def _save_move_annotation(
        self,
        conn: Connection,
        *,
        game_id: str,
        move: MoveRecord,
        pos_cache: Dict[str, int],
    ) -> None:
        engine_eval_before_id = self._save_engine_evaluation(
            conn, move.engine_eval_before, move.fen_before, pos_cache
        )
        engine_eval_after_id = self._save_engine_evaluation(
            conn, move.engine_eval_after, move.fen_after, pos_cache
        )
        best_move_eval_id = self._save_engine_evaluation(
            conn, move.best_move_eval, move.fen_before, pos_cache
        )
        conn.execute(
            t.moves.insert().values(
                game_id=game_id,
                ply=move.ply,
                uci=move.uci,
                engine_eval_before_id=engine_eval_before_id,
                engine_eval_after_id=engine_eval_after_id,
                best_move_uci=move.best_move_uci,
                best_move_eval_id=best_move_eval_id,
                classification=move.classification.value,
                comment=move.comment,
                generated_comment=move.generated_comment,
                generated_meta_json=(
                    _json_dump(move.generated_meta) if move.generated_meta else None
                ),
                tags_json=_json_dump(move.tags) if move.tags else None,
                source=move.source.value,
            )
        )

    def _save_opening_node(
        self,
        conn: Connection,
        node: OpeningNode,
        pos_cache: Optional[Dict[str, int]] = None,
    ) -> None:
        values = self._opening_node_values(conn, node, pos_cache)
        _upsert(
            conn, t.opening_nodes, values,
            conflict=[t.opening_nodes.c.id],
            update_cols=tuple(name for name in values if name not in {"id", "created_at"}),
        )

    def _opening_node_values(
        self, conn: Connection, node: OpeningNode,
        pos_cache: Optional[Dict[str, int]] = None,
    ) -> Dict[str, Any]:
        now = _now_text()
        if pos_cache is None:
            pos_cache = {}
        arriving = node.move.uci if node.move is not None else None
        eval_fen = node.fen
        engine_evaluation_id = self._save_engine_evaluation(
            conn, node.engine_evaluation, eval_fen, pos_cache
        )
        return {
                "id": node.id,
                "repertoire_id": node.repertoire_id,
                "parent_id": node.parent_id,
                "uci": arriving,
                "engine_evaluation_id": engine_evaluation_id,
                "maia_probability": node.maia_probability,
                "is_mainline": _bool_to_int(node.is_mainline),
                "is_user_prepared_move": _bool_to_int(node.is_user_prepared_move),
                "is_enabled": _bool_to_int(node.is_enabled),
                "priority": node.priority,
                "comment": node.comment,
                "tags_json": _json_dump(node.tags) if node.tags else None,
                "arrows_json": _json_dump(node.arrows) if node.arrows else None,
                "circles_json": _json_dump(node.circles) if node.circles else None,
                "tactical_warning": node.tactical_warning,
                "strategic_idea": node.strategic_idea,
                "typical_plan": node.typical_plan,
                "source": node.source.value,
                "created_at": now,
                "updated_at": now,
            }

    def _ensure_position(self, conn: Connection, fen: str, pos_cache: Dict[str, int]) -> int:
        key = codec.position_key(fen)
        cached = pos_cache.get(key)
        if cached is not None:
            return cached
        stmt = (
            _insert(conn, t.positions)
            .values(fen=key)
            .on_conflict_do_nothing(index_elements=["fen"])
        )
        conn.execute(stmt)
        pos_id = conn.execute(
            select(t.positions.c.id).where(t.positions.c.fen == key)
        ).scalar_one()
        pos_cache[key] = int(pos_id)
        return int(pos_id)

    def _save_engine_evaluation(
        self,
        conn: Connection,
        evaluation: Optional[EngineEvaluation],
        fen: str,
        pos_cache: Optional[Dict[str, int]] = None,
    ) -> Optional[int]:
        if evaluation is None:
            return None
        if pos_cache is None:
            pos_cache = {}
        position_id = self._ensure_position(conn, fen, pos_cache)
        wdl = codec.encode_wdl(evaluation.wdl)
        values = {
            "position_id": position_id,
            "engine": evaluation.engine,
            "depth": codec.encode_search_limit(evaluation.depth),
            "nodes": codec.encode_search_limit(evaluation.nodes),
            "time_ms": codec.encode_search_limit(evaluation.time_ms),
            "score_cp": evaluation.score_cp,
            "mate_in": evaluation.mate_in,
            "best_move_uci": evaluation.best_move_uci,
            "pv": codec.encode_pv(evaluation.pv),
            "wdl_win": None if wdl is None else wdl[0],
            "wdl_draw": None if wdl is None else wdl[1],
            "wdl_loss": None if wdl is None else wdl[2],
        }
        values["fingerprint"] = codec.evaluation_fingerprint(
            engine=values["engine"],
            position_fen=codec.position_key(fen),
            depth=values["depth"],
            nodes=values["nodes"],
            time_ms=values["time_ms"],
            score_cp=values["score_cp"],
            mate_in=values["mate_in"],
            best_move_uci=values["best_move_uci"],
            pv=values["pv"],
            wdl_win=values["wdl_win"],
            wdl_draw=values["wdl_draw"],
            wdl_loss=values["wdl_loss"],
        )
        # Evaluations are immutable snapshots: identical content dedupes onto
        # one row (cache hit below), while a DIFFERENT result carries a
        # different fingerprint and therefore gets its own row. Nothing is ever
        # rewritten, so rows referenced by earlier analyses/classifications can
        # never change (improvement review D-01).
        stmt = _insert(conn, t.engine_evaluations).values(**values)
        stmt = stmt.on_conflict_do_nothing(
            index_elements=[
                "position_id",
                "engine",
                "depth",
                "nodes",
                "time_ms",
                "fingerprint",
            ],
        ).returning(t.engine_evaluations.c.id)
        ev_id = conn.execute(stmt).scalar_one_or_none()
        if ev_id is None:
            # Identical snapshot already stored — reuse its id.
            ev_id = conn.execute(
                select(t.engine_evaluations.c.id).where(
                    t.engine_evaluations.c.position_id == values["position_id"],
                    t.engine_evaluations.c.engine == values["engine"],
                    t.engine_evaluations.c.depth == values["depth"],
                    t.engine_evaluations.c.nodes == values["nodes"],
                    t.engine_evaluations.c.time_ms == values["time_ms"],
                    t.engine_evaluations.c.fingerprint == values["fingerprint"],
                )
            ).scalar_one()
        return int(ev_id)

    def _load_evaluations(
        self, conn: Connection, eval_ids: Iterable[Optional[int]]
    ) -> Dict[int, EngineEvaluation]:
        wanted = sorted({int(i) for i in eval_ids if i is not None})
        if not wanted:
            return {}
        result = {}
        for offset in range(0, len(wanted), 1000):
            rows = conn.execute(
                select(t.engine_evaluations).where(t.engine_evaluations.c.id.in_(wanted[offset:offset + 1000]))
            ).mappings()
            result.update({int(row["id"]): self._eval_from_row(row) for row in rows})
        return result

    def _eval_from_row(self, row: Mapping[str, Any]) -> EngineEvaluation:
        return EngineEvaluation(
            engine=row["engine"],
            depth=codec.decode_search_limit(row["depth"]),
            nodes=codec.decode_search_limit(row["nodes"]),
            time_ms=codec.decode_search_limit(row["time_ms"]),
            score_cp=row["score_cp"],
            mate_in=row["mate_in"],
            best_move_uci=row["best_move_uci"],
            pv=codec.decode_pv(row["pv"]),
            wdl=codec.decode_wdl(row["wdl_win"], row["wdl_draw"], row["wdl_loss"]),
        )

    def _training_session_from_row(self, row: Mapping[str, Any]) -> TrainingSession:
        created_at = _dt_from_text(row["created_at"]) or datetime.now(timezone.utc)
        updated_at = _dt_from_text(row["updated_at"]) or created_at
        return TrainingSession(
            id=row["id"],
            repertoire_id=row["repertoire_id"],
            mode=TrainingMode(row["mode"]),
            line_order=_json_load(row["line_order_json"], []),
            current_index=row["current_index"],
            current_node_id=row["current_node_id"],
            mistakes=_json_load(row["mistakes_json"], []),
            mastered_nodes=_json_load(row["mastered_nodes_json"], []),
            created_at=created_at,
            updated_at=updated_at,
            seed=row["seed"],
        )

    def _training_progress_from_row(self, row: Mapping[str, Any]) -> TrainingProgress:
        return TrainingProgress(
            node_id=row["node_id"],
            attempts=row["attempts"],
            correct_attempts=row["correct_attempts"],
            last_reviewed_at=_dt_from_text(row["last_reviewed_at"]),
            spaced_repetition_score=row["spaced_repetition_score"],
            due_at=_dt_from_text(row["due_at"]),
            is_mastered=_int_to_bool(row["is_mastered"]),
        )

    def _walk_nodes(self, root: OpeningNode) -> Iterable[OpeningNode]:
        yield root
        for child in root.children:
            for node in self._walk_nodes(child):
                yield node

    def _analysis_result_id(self, result: AnalysisResult) -> str:
        payload = {
            "game_id": result.game_id,
            "analyzed_at": _dt_to_text(result.analyzed_at),
            "engine": result.engine,
            "depth": result.depth,
        }
        digest = sha256(_json_dump(payload).encode("utf-8")).hexdigest()[:32]
        return "analysis:{0}".format(digest)

    def _training_progress_id(
        self,
        owner_user_id: Optional[str],
        repertoire_id: str,
        node_id: str,
    ) -> str:
        payload = {
            "owner_user_id": owner_user_id or "default",
            "repertoire_id": repertoire_id,
            "node_id": node_id,
        }
        digest = sha256(_json_dump(payload).encode("utf-8")).hexdigest()[:32]
        return "training-progress:{0}".format(digest)

    def new_id(self) -> str:
        return str(uuid.uuid4())
