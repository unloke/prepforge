"""Reproducible Build hot-path SQL benchmark (SQLite, 500/2000 nodes)."""
from __future__ import annotations

import argparse
import json
import statistics
import time
import uuid

import chess
from sqlalchemy import event

from prepforge_chess.core.models import Color, MoveSource, OpeningNode
from prepforge_chess.services.opening_builder import CreateRepertoireRequest, OpeningBuilderService
from prepforge_chess.services.workspace_view import build_workspace_payload
from prepforge_chess.storage.database import apply_schema, connect_database
from prepforge_chess.storage.repositories import PrepForgeRepository


def make_tree(builder, repertoire, size):
    queue = [repertoire.root_node]
    count = 1
    while queue and count < size:
        parent = queue.pop(0)
        board = chess.Board(parent.fen)
        for move in list(board.legal_moves)[:4]:
            if count >= size:
                break
            record = builder.chess_core.apply_uci(parent.fen, move.uci(), source=MoveSource.MANUAL)
            child = OpeningNode(
                id=str(uuid.uuid4()), repertoire_id=repertoire.id, parent_id=parent.id,
                move=record, fen=record.fen_after,
                side_to_move=builder.chess_core.side_to_move(record.fen_after),
                source=MoveSource.MANUAL,
            )
            parent.children.append(child)
            queue.append(child)
            count += 1
    builder.repository.save_repertoire(repertoire)


def measure(engine, function):
    counts = []
    times = []

    def listener(*_):
        counts[-1] += 1

    event.listen(engine, "before_cursor_execute", listener)
    try:
        for _ in range(3):
            counts.append(0)
            start = time.perf_counter()
            function()
            times.append((time.perf_counter() - start) * 1000)
    finally:
        event.remove(engine, "before_cursor_execute", listener)
    return {"statements": statistics.median(counts), "latency_ms": round(statistics.median(times), 2)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--sizes", nargs="+", type=int, default=[500, 2000])
    args = parser.parse_args()
    results = {}
    for size in args.sizes:
        engine = connect_database()
        apply_schema(engine)
        repo = PrepForgeRepository(engine)
        builder = OpeningBuilderService(repo)
        repertoire = builder.create_repertoire(CreateRepertoireRequest("Benchmark", Color.WHITE))
        make_tree(builder, repertoire, size)
        root = repertoire.root_node
        leaf = root.children[0]
        occupied = {child.move.uci for child in root.children}
        unused = [move.uci() for move in chess.Board(root.fen).legal_moves
                  if move.uci() not in occupied]
        add_index = iter(range(3))
        plan_index = iter(range(3))

        def add_one():
            index = next(add_index)
            return builder.add_moves_batch(repertoire.id, [{
                "tempId": f"tmp-bench-{index}", "parentRef": root.id, "uci": unused[index],
            }])

        def apply_one():
            index = next(plan_index)
            return builder.apply_generation_plan(repertoire.id, root.id, {"changes": [{
                "action": "planned_add", "tempId": f"tmp-plan-{index}",
                "parentRef": root.id, "moveUci": unused[index + 3],
                "source": "generated_stockfish", "intendedMainline": False,
            }]})

        results[size] = {
            "mark_prepared": measure(engine, lambda: builder.mark_prepared(repertoire.id, leaf.id)),
            "annotations": measure(engine, lambda: builder.set_annotations(
                repertoire.id, leaf.id, ["Ge2e4"], ["Rd4"]
            )),
            "add_moves_batch": measure(engine, add_one),
            "apply_plan": measure(engine, apply_one),
            "build_load": measure(engine, lambda: build_workspace_payload(repo, repertoire.id)),
        }
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
