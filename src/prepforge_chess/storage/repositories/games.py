"""Games persistence."""
from __future__ import annotations

from datetime import datetime, timezone
from hashlib import sha256
from typing import Any, Dict, List, Optional
from sqlalchemy import or_, and_, delete, func, select, update
from sqlalchemy.engine import Connection
from prepforge_chess.core.models import AnalysisResult, Game, GameResult, MoveRecord, MoveSource
from prepforge_chess.storage import codec
from prepforge_chess.storage import sa_tables as t
from prepforge_chess.storage.repositories.common import _insert, _json_dump, _json_load, _parse_critical_ply, _upsert
from prepforge_chess.storage.repositories.evaluations import EvaluationRepository


class GameRepository(EvaluationRepository):
    def _save_moves_batched(self, conn: Connection, game: Game, result) -> None:
        """Bulk portion of ``save_game`` (moves, positions, evals,
        analysis row). Runs inside the caller's transaction; the game-metadata
        upsert already happened in ``save_game``."""
        annotated: List[MoveRecord] = [
            move for move in game.moves if codec.move_needs_row(move)
        ]

        # 1. Collect the unique position key of every evaluation once (chunked
        # for the SQLite 999-variable cap and the Postgres 65535-parameter cap).
        fen_keys: List[str] = []
        seen_fens: set = set()
        for move in annotated:
            for evaluation, fen in (
                (move.engine_eval_before, move.fen_before),
                (move.engine_eval_after, move.fen_after),
                (move.best_move_eval, move.fen_before),
            ):
                if evaluation is None:
                    continue
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
                    "analyzed_at": result.analyzed_at,
                    "engine": result.engine,
                    "depth": result.depth,
                    "summary_json": _json_dump(result.summary),
                    "critical_ply": ",".join(str(p) for p in result.critical_ply),
                    "quality_json": _json_dump(result.quality) if result.quality else None,
                    "move_results_json": codec.encode_analysis_moves(result.move_results),
                },
                conflict=[t.analysis_results.c.id],
                update_cols=(
                    "analyzed_at", "engine", "depth", "summary_json", "critical_ply",
                    "quality_json", "move_results_json",
                ),
            )

    def save_game(
        self,
        game: Game,
        result: Optional[AnalysisResult] = None,
        owner_user_id: Optional[str] = None,
    ) -> None:
        """Persist a game (+ the analysis result when given) in one transaction.

        The statement count stays near-constant in game length instead of
        scaling per ply (see ``_save_moves_batched``). SQLite and PostgreSQL
        share this path (``_insert`` picks the dialect). A re-save never
        reassigns an existing owner.
        """
        now = datetime.now(timezone.utc)
        with self.engine.begin() as conn:
            _upsert(
                conn,
                t.games,
                {
                    "id": game.id,
                    "source": game.source.value,
                    "initial_fen": game.initial_fen,
                    "uci_blob": codec.game_uci_blob(game),
                    "pgn": game.pgn,
                    "white": game.white,
                    "black": game.black,
                    "result": game.result.value,
                    "event": game.event,
                    "site": game.site,
                    "played_at": game.played_at,
                    "lichess_id": game.lichess_id,
                    "tags_json": _json_dump(game.tags),
                    "owner_user_id": owner_user_id,
                    "created_at": now,
                    "updated_at": now,
                },
                conflict=[t.games.c.id],
                update_cols=(
                    "source", "initial_fen", "uci_blob", "pgn", "white", "black", "result",
                    "event", "site", "played_at", "lichess_id", "tags_json", "updated_at",
                ),
                coalesce_cols=("owner_user_id",),
            )
            self._save_moves_batched(conn, game, result)

    def load_game(self, game_id: str, owner_user_id: Optional[str] = None, *, render_pgn: bool = False) -> Optional[Game]:
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
        return self._game_from_rows(row, move_rows, evals, render_pgn=render_pgn)

    def _game_from_rows(self, row, move_rows, evals, *, render_pgn: bool = False) -> Game:
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
            played_at=row["played_at"],
            pgn=row["pgn"],
            lichess_id=row["lichess_id"],
            tags=_json_load(row["tags_json"], {}),
        )
        if render_pgn:
            game.pgn = codec.export_pgn(game)
        return game

    def find_game_id_by_lichess_id(
        self, lichess_id: str, owner_user_id: Optional[str] = None
    ) -> Optional[str]:
        """Dedup lookup for a Lichess game. Owner-scoped: when an owner is supplied
        only that owner's own copy counts, so two users importing the same game each
        keep their own row instead of colliding on a shared one. Unscoped (None)
        searches all stored games for internal import tools."""
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

    def iter_games(self, owner_user_id: Optional[str] = None, *, batch_size: int = 100, render_pgn: bool = False):
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
                yield self._game_from_rows(row, by_game[row["id"]], evals, render_pgn=render_pgn)
            cursor = (rows[-1]["created_at"], rows[-1]["id"])

    def list_games(self, owner_user_id: Optional[str] = None) -> List[Game]:
        return list(self.iter_games(owner_user_id))

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

    def count_analysis_snapshots(self) -> int:
        with self.engine.connect() as conn:
            return int(
                conn.execute(
                    select(func.count()).select_from(t.analysis_results)
                ).scalar_one()
            )

    def _trimable_analysis_select(self, keep_per_game: int):
        """Ids of analysis rows beyond the newest ``keep_per_game`` per game."""
        if keep_per_game < 1:
            raise ValueError("keep_per_game must be positive")
        ranked = select(
            t.analysis_results.c.id,
            func.row_number().over(partition_by=t.analysis_results.c.game_id,
                order_by=(t.analysis_results.c.analyzed_at.desc(), t.analysis_results.c.id.desc())).label("rank"),
        ).subquery()
        return select(ranked.c.id).where(ranked.c.rank > keep_per_game)

    def count_trimable_analyses(self, keep_per_game: int) -> int:
        with self.engine.connect() as conn:
            return int(conn.scalar(select(func.count()).select_from(self._trimable_analysis_select(keep_per_game).subquery())))

    def delete_trimable_analyses(self, keep_per_game: int) -> int:
        with self.engine.begin() as conn:
            result = conn.execute(delete(t.analysis_results).where(t.analysis_results.c.id.in_(self._trimable_analysis_select(keep_per_game))))
            return int(result.rowcount or 0)

    def save_analysis_result(self, result: AnalysisResult) -> None:
        analysis_id = self._analysis_result_id(result)
        with self.engine.begin() as conn:
            _upsert(
                conn,
                t.analysis_results,
                {
                    "id": analysis_id,
                    "game_id": result.game_id,
                    "analyzed_at": result.analyzed_at,
                    "engine": result.engine,
                    "depth": result.depth,
                    "summary_json": _json_dump(result.summary),
                    "critical_ply": ",".join(str(p) for p in result.critical_ply),
                    "quality_json": _json_dump(result.quality) if result.quality else None,
                    "move_results_json": codec.encode_analysis_moves(result.move_results),
                },
                conflict=[t.analysis_results.c.id],
                update_cols=(
                    "analyzed_at", "engine", "depth", "summary_json", "critical_ply",
                    "quality_json", "move_results_json",
                ),
            )

    def list_analyzed_games(
        self,
        owner_user_id: Optional[str] = None,
        *,
        limit: int = 50,
        cursor: Optional[tuple[datetime, str]] = None,
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
        # Owner, summary, and self-contained move snapshot come from ONE SELECT,
        # including on PostgreSQL's default READ COMMITTED isolation level.
        stmt = select(t.analysis_results).where(t.analysis_results.c.game_id == game_id)
        if owner_user_id is not None:
            stmt = stmt.join(t.games, t.games.c.id == t.analysis_results.c.game_id).where(
                t.games.c.owner_user_id == owner_user_id
            )
        stmt = stmt.order_by(t.analysis_results.c.analyzed_at.desc(), t.analysis_results.c.id.desc()).limit(1)
        with self.engine.connect() as conn:
            row = conn.execute(stmt).mappings().first()
        if row is None:
            return None

        return self._analysis_from_row(row)

    def load_analysis_save(self, game_id: str, save_id: str) -> Optional[AnalysisResult]:
        with self.engine.connect() as conn:
            row = conn.execute(select(t.analysis_results).where(
                t.analysis_results.c.id == self.analysis_save_id(game_id, save_id)
            )).mappings().first()
        return self._analysis_from_row(row) if row is not None else None

    def has_analysis_save(self, game_id: str, save_id: str, owner_user_id: str) -> bool:
        with self.engine.connect() as conn:
            return conn.scalar(select(t.analysis_results.c.id).join(
                t.games, t.games.c.id == t.analysis_results.c.game_id
            ).where(
                t.analysis_results.c.id == self.analysis_save_id(game_id, save_id),
                t.games.c.owner_user_id == owner_user_id,
            )) is not None

    @staticmethod
    def _analysis_from_row(row) -> AnalysisResult:
        quality = _json_load(row["quality_json"], None)
        if row["move_results_json"] is None:
            quality = dict(quality or {}, move_snapshot_missing=True)
        return AnalysisResult(
            game_id=row["game_id"],
            analyzed_at=row["analyzed_at"],
            engine=row["engine"],
            depth=row["depth"],
            move_results=codec.decode_analysis_moves(row["move_results_json"]),
            summary=_json_load(row["summary_json"], {}),
            critical_ply=_parse_critical_ply(row["critical_ply"]),
            quality=quality,
        )

    def _analysis_result_id(self, result: AnalysisResult) -> str:
        if result.save_id:
            return self.analysis_save_id(result.game_id, result.save_id)
        payload = {
            "game_id": result.game_id,
            "analyzed_at": result.analyzed_at.isoformat(),
            "engine": result.engine,
            "depth": result.depth,
        }
        digest = sha256(_json_dump(payload).encode("utf-8")).hexdigest()[:32]
        return "analysis:{0}".format(digest)

    @staticmethod
    def analysis_save_id(game_id: str, save_id: str) -> str:
        digest = sha256(_json_dump([game_id, save_id]).encode("utf-8")).hexdigest()
        return "analysis-save:{0}".format(digest)

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
