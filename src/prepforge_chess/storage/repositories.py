from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from hashlib import sha256
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional

from sqlalchemy import delete, func, select, update
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


class PrepForgeRepository:
    """SQLAlchemy persistence for shared domain models.

    The repository is intentionally narrow: it stores and loads domain objects
    without putting analysis, training, or generation decisions into SQL code. It
    runs against the ``storage/sa_tables`` Core tables, so the same code drives
    SQLite (dev/tests) and Postgres (prod).
    """

    def __init__(self, engine: Engine):
        self.engine = engine

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
            return default

    def set_user_setting(self, user_id: str, key: str, value: Any) -> None:
        """Upsert one setting row. A ``None`` value deletes the key."""
        with self.engine.begin() as conn:
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

        # 2. Deduplicate engine evaluations by their unique key and upsert
        # them in one statement with RETURNING ids.
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
                key = (
                    pos_ids[codec.position_key(fen)],
                    evaluation.engine,
                    codec.encode_search_limit(evaluation.depth),
                    codec.encode_search_limit(evaluation.nodes),
                    codec.encode_search_limit(evaluation.time_ms),
                )
                if key in seen_evals:
                    continue
                seen_evals.add(key)
                eval_keys.append(key)
                wdl = codec.encode_wdl(evaluation.wdl)
                eval_payloads[key] = {
                    "position_id": key[0],
                    "engine": evaluation.engine,
                    "depth": key[2],
                    "nodes": key[3],
                    "time_ms": key[4],
                    "score_cp": evaluation.score_cp,
                    "mate_in": evaluation.mate_in,
                    "best_move_uci": evaluation.best_move_uci,
                    "pv": codec.encode_pv(evaluation.pv),
                    "wdl_win": None if wdl is None else wdl[0],
                    "wdl_draw": None if wdl is None else wdl[1],
                    "wdl_loss": None if wdl is None else wdl[2],
                }
        eval_ids: Dict[tuple, int] = {}
        if eval_payloads:
            # Same SQLite executemany-upsert limitation as move rows: use
            # chunked multi-row VALUES (12 columns per eval row → a 40-row
            # chunk is 480 variables). One round-trip per chunk.
            CHUNK = 40
            for chunk_start in range(0, len(eval_keys), CHUNK):
                chunk = eval_keys[chunk_start : chunk_start + CHUNK]
                stmt = _insert(conn, t.engine_evaluations).values(
                    [eval_payloads[key] for key in chunk]
                )
                stmt = stmt.on_conflict_do_update(
                    index_elements=["position_id", "engine", "depth", "nodes", "time_ms"],
                    set_={
                        "score_cp": stmt.excluded.score_cp,
                        "mate_in": stmt.excluded.mate_in,
                        "best_move_uci": stmt.excluded.best_move_uci,
                        "pv": stmt.excluded.pv,
                        "wdl_win": stmt.excluded.wdl_win,
                        "wdl_draw": stmt.excluded.wdl_draw,
                        "wdl_loss": stmt.excluded.wdl_loss,
                    },
                ).returning(
                    t.engine_evaluations.c.id,
                    t.engine_evaluations.c.position_id,
                    t.engine_evaluations.c.engine,
                    t.engine_evaluations.c.depth,
                    t.engine_evaluations.c.nodes,
                    t.engine_evaluations.c.time_ms,
                )
                for row in conn.execute(stmt).all():
                    eval_ids[
                        (
                            int(row.position_id),
                            row.engine,
                            int(row.depth),
                            int(row.nodes),
                            int(row.time_ms),
                        )
                    ] = int(row.id)
            # RETURNING only yields inserted rows on SQLite (upserted
            # conflicts return nothing). Backfill the rest with chunked
            # selects (same variable-cap reason as above).
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
                        )
                        if key in eval_payloads:
                            eval_ids[key] = int(row.id)

        def _eval_id(evaluation, fen) -> Optional[int]:
            if evaluation is None:
                return None
            return eval_ids.get(
                (
                    pos_ids[codec.position_key(fen)],
                    evaluation.engine,
                    codec.encode_search_limit(evaluation.depth),
                    codec.encode_search_limit(evaluation.nodes),
                    codec.encode_search_limit(evaluation.time_ms),
                )
            )

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
                },
                conflict=[t.analysis_results.c.id],
                update_cols=(
                    "analyzed_at", "engine", "depth", "summary_json", "critical_ply",
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

            uci_list = codec.decode_uci_sequence(row["uci_blob"])
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
            annotations: Dict[int, Dict[str, Any]] = {}
            for move_row in move_rows:
                annotations[int(move_row["ply"])] = {
                    "source": move_row["source"],
                    "classification": move_row["classification"],
                    "comment": move_row["comment"],
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

    def list_games(self, owner_user_id: Optional[str] = None) -> List[Game]:
        stmt = select(t.games.c.id).order_by(t.games.c.created_at.desc())
        if owner_user_id is not None:
            stmt = stmt.where(t.games.c.owner_user_id == owner_user_id)
        with self.engine.connect() as conn:
            ids = [row["id"] for row in conn.execute(stmt).mappings().all()]
        return [game for game in (self.load_game(game_id) for game_id in ids) if game is not None]

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

    def update_repertoire_fields(self, repertoire_id: str, **fields: Any) -> None:
        if not fields:
            return
        with self.engine.begin() as conn:
            conn.execute(
                update(t.repertoires)
                .where(t.repertoires.c.id == repertoire_id)
                .values(**fields, updated_at=_now_text())
            )

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

            eval_ids = [row["engine_evaluation_id"] for row in node_rows]
            evals = self._load_evaluations(conn, eval_ids)
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

    def list_repertoires(self, owner_user_id: Optional[str] = None) -> List[Repertoire]:
        stmt = select(t.repertoires.c.id).order_by(t.repertoires.c.updated_at.desc())
        if owner_user_id is not None:
            stmt = stmt.where(t.repertoires.c.owner_user_id == owner_user_id)
        with self.engine.connect() as conn:
            ids = [row["id"] for row in conn.execute(stmt).mappings().all()]
        return [
            repertoire
            for repertoire in (self.load_repertoire(rep_id) for rep_id in ids)
            if repertoire is not None
        ]

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
            )
            .where(t.repertoires.c.owner_user_id == owner_user_id)
            .order_by(t.repertoires.c.updated_at.desc())
        )
        with self.engine.connect() as conn:
            rows = conn.execute(stmt).mappings().all()
        return [
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
                # Cached coverage summary (NULL until the rep is first opened/trained).
                "health": _json_load(row["health_json"], None),
            }
            for row in rows
        ]

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
        }

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

    def save_training_session(self, session: TrainingSession) -> None:
        with self.engine.begin() as conn:
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
                    "updated_at",
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

    def save_training_progress(
        self,
        repertoire_id: str,
        progress: TrainingProgress,
        *,
        owner_user_id: str,
    ) -> None:
        progress_id = self._training_progress_id(owner_user_id, repertoire_id, progress.node_id)
        now = _now_text()
        with self.engine.begin() as conn:
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
        """Map each stored game's UCI move-sequence signature to its game id, so a
        re-imported game (no lichess id) is detected as a duplicate AND resolved
        back to the already-stored game rather than a fresh, unsaved candidate.

        Owner-scoped: when an owner is supplied only that owner's games are
        considered, so one user pasting a PGN another user already stored gets their
        own owned copy rather than being bounced to the other user's game."""
        stmt = select(t.games.c.id, t.games.c.uci_blob)
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
            signatures.setdefault(" ".join(ucis), row["id"])
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
                },
                conflict=[t.analysis_results.c.id],
                update_cols=(
                    "analyzed_at", "engine", "depth", "summary_json", "critical_ply",
                ),
            )

    def list_analyzed_games(self, owner_user_id: Optional[str] = None) -> List[Dict[str, Any]]:
        """Metadata for every game that has a saved analysis (latest per game),
        newest first — powers the Analyze "History" list. Analyses are owned
        transitively through their game, so scoping joins on ``games.owner_user_id``."""
        ar = t.analysis_results
        g = t.games
        latest = (
            select(
                ar.c.game_id.label("game_id"),
                func.max(ar.c.analyzed_at).label("max_at"),
            )
            .group_by(ar.c.game_id)
            .subquery()
        )
        stmt = (
            select(
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
            )
            .select_from(
                ar.join(g, g.c.id == ar.c.game_id).join(
                    latest,
                    (latest.c.game_id == ar.c.game_id) & (latest.c.max_at == ar.c.analyzed_at),
                )
            )
            .order_by(ar.c.analyzed_at.desc())
        )
        if owner_user_id is not None:
            stmt = stmt.where(g.c.owner_user_id == owner_user_id)
        with self.engine.connect() as conn:
            rows = conn.execute(stmt).mappings().all()
        return [
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
        stmt = _insert(conn, t.engine_evaluations).values(**values)
        stmt = stmt.on_conflict_do_update(
            index_elements=["position_id", "engine", "depth", "nodes", "time_ms"],
            set_={
                "score_cp": stmt.excluded.score_cp,
                "mate_in": stmt.excluded.mate_in,
                "best_move_uci": stmt.excluded.best_move_uci,
                "pv": stmt.excluded.pv,
                "wdl_win": stmt.excluded.wdl_win,
                "wdl_draw": stmt.excluded.wdl_draw,
                "wdl_loss": stmt.excluded.wdl_loss,
            },
        ).returning(t.engine_evaluations.c.id)
        ev_id = conn.execute(stmt).scalar_one()
        return int(ev_id)

    def _load_evaluations(
        self, conn: Connection, eval_ids: Iterable[Optional[int]]
    ) -> Dict[int, EngineEvaluation]:
        wanted = sorted({int(i) for i in eval_ids if i is not None})
        if not wanted:
            return {}
        rows = conn.execute(
            select(t.engine_evaluations).where(t.engine_evaluations.c.id.in_(wanted))
        ).mappings().all()
        return {int(row["id"]): self._eval_from_row(row) for row in rows}

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
