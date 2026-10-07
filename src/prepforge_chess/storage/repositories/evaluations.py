"""Evaluations persistence."""
from __future__ import annotations

from typing import Any, Dict, Iterable, Mapping, Optional
from sqlalchemy import delete, func, select, union
from sqlalchemy.engine import Connection
from prepforge_chess.core.models import EngineEvaluation
from prepforge_chess.storage import codec
from prepforge_chess.storage import sa_tables as t
from prepforge_chess.storage.repositories.common import _insert
from prepforge_chess.storage.repositories.base import Repository


class EvaluationRepository(Repository):
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
            result = conn.execute(
                delete(t.engine_evaluations).where(t.engine_evaluations.c.id.in_(self._orphan_eval_select()))
            )
            return int(result.rowcount or 0)

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
            result = conn.execute(delete(t.positions).where(t.positions.c.id.in_(self._orphan_position_select())))
            return int(result.rowcount or 0)

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
