"""Scratch SQLite read-path benchmark; -o writes Markdown, --profile writes cProfile.

Run with PYTHONPATH=src. Setup/reset work is excluded; measured API calls include
authentication, CSRF validation, SQL, mutations, and JSON serialization.
"""
from __future__ import annotations
from prepforge_chess.storage import sa_tables

import argparse
import cProfile
from datetime import datetime, timedelta, timezone
import json
import logging
import os
from pathlib import Path
import random
import statistics
import tempfile
import time
import uuid

import chess
from fastapi.testclient import TestClient
from sqlalchemy import event

from prepforge_chess.core.models import Color, Game, MoveSource, OpeningNode, TrainingProgress
from prepforge_chess.services.opening_builder import CreateRepertoireRequest, OpeningBuilderService
from prepforge_chess.services.lichess_fetch import GameMatchSummary, record_departure_misses
from prepforge_chess.services.repertoire_matching import match_game_to_repertoire
from prepforge_chess.services.workspace_view import build_workspace_payload
from prepforge_chess.storage.codec import rebuild_moves
from prepforge_chess.storage.repositories.workspace import WorkspaceRepository


def seed(repo, owner, size):
    builder = OpeningBuilderService(repo)
    rep = builder.create_repertoire(CreateRepertoireRequest(name=f"Bench {size}", color=Color.WHITE))
    rng = random.Random(size)
    openings = ["e2e4 e7e5 g1f3 b8c6 f1b5", "d2d4 d7d5 c2c4 e7e6 b1c3",
                "e2e4 c7c5 g1f3 d7d6 d2d4", "g1f3 d7d5 g2g3 g8f6 f1g2"]
    nodes = [rep.root_node]
    while len(nodes) < size:
        board = chess.Board()
        parent = rep.root_node
        line = rng.choice(openings).split()
        for ply in range(20):
            legal = list(board.legal_moves)
            if not legal or len(nodes) >= size:
                break
            move = chess.Move.from_uci(line[ply]) if ply < len(line) else rng.choice(legal)
            child = next((n for n in parent.children if n.move.uci == move.uci()), None)
            if child is None:
                record = rebuild_moves(board.fen(), [move.uci()])[0]
                child = OpeningNode(id=str(uuid.uuid4()), repertoire_id=rep.id, parent_id=parent.id,
                                    move=record, fen=record.fen_after,
                                    side_to_move=record.side_to_move.opponent,
                                    is_mainline=not parent.children,
                                    is_user_prepared_move=board.turn == chess.WHITE,
                                    maia_probability=0.5, source=MoveSource.MANUAL)
                parent.children.append(child)
                nodes.append(child)
            board.push(move)
            parent = child
    repo.save_repertoire(rep, owner_user_id=owner)
    now = datetime.now(timezone.utc)
    for i, node in enumerate(nodes[1:]):
        if node.move.side_to_move is Color.WHITE and i % 3 != 0:
            repo.save_training_progress(rep.id, TrainingProgress(
                node_id=node.id, attempts=4, correct_attempts=3,
                last_reviewed_at=now - timedelta(days=2),
                due_at=now + timedelta(days=(i % 3) - 1),
                spaced_repetition_score=0.75, is_mastered=i % 2 == 0), owner_user_id=owner)
    build_workspace_payload(repo, rep.id, owner_user_id=owner)
    return rep, nodes


def measure(engine, runs, operation, prepare=lambda: None, profile=None):
    timings, queries = [], []
    count = 0
    def collect(*args):
        nonlocal count
        count += 1
    # Warm once with the same reset as each measured run.
    prepare()
    operation()
    for _ in range(runs):
        prepare()
        count = 0
        event.listen(engine, "before_cursor_execute", collect)
        try:
            start = time.perf_counter()
            operation()
            timings.append((time.perf_counter() - start) * 1000)
            queries.append(count)
        finally:
            event.remove(engine, "before_cursor_execute", collect)
    if profile:
        prepare()
        profiler = cProfile.Profile()
        profiler.runcall(operation)
        profiler.dump_stats(str(profile))
    return round(statistics.median(timings), 2), statistics.median(queries)


def run(args, directory):
    os.environ.update(DATABASE_URL=f"sqlite:///{(directory / 'bench.sqlite3').as_posix()}",
                      PREPFORGE_SECRET_KEY="benchmark-secret", PREPFORGE_TOKEN_KEY="benchmark-token",
                      PREPFORGE_ENV="development")
    from prepforge_chess.api import config, db, main
    from prepforge_chess.api.ratelimit import limiter
    logging.getLogger("httpx").setLevel(logging.WARNING)
    config.get_settings.cache_clear()
    db._engine = db._SessionLocal = None
    limiter.enabled = False
    # Identical schema setup to tests/conftest.py, isolated from configured DBs.
    sa_tables.metadata.create_all(db.make_engine())
    engine = db.get_engine()
    repo = WorkspaceRepository(engine)
    rows = []
    try:
        with TestClient(main.app) as client:
            client.get("/api/csrf")
            headers = {"X-CSRF-Token": client.cookies["pf_csrf"]}
            response = client.post("/api/auth/register", json={"email": "bench@example.com",
                                  "password": "benchmark-password"}, headers=headers)
            assert response.status_code == 201, response.text
            from sqlalchemy import select
            from prepforge_chess.api.models import User
            with engine.connect() as conn:
                owner = conn.execute(select(User.id)).scalar_one()
            games = []
            rng = random.Random(7)
            for i in range(args.games):
                board, ucis = chess.Board(), []
                # Force an early departure, then replay legal middlegame positions.
                for ply in range(30):
                    legal = list(board.legal_moves)
                    if not legal:
                        break
                    move = chess.Move.from_uci("b2b3") if ply == 0 else rng.choice(legal)
                    ucis.append(move.uci())
                    board.push(move)
                game = Game(id=f"bench-game-{i}", white="bench", black="opponent",
                            source=MoveSource.LICHESS_GAME, initial_fen=chess.STARTING_FEN,
                            moves=rebuild_moves(chess.STARTING_FEN, ucis))
                repo.save_game(game, owner_user_id=owner)
                games.append(game)
            for size in args.sizes:
                rep, nodes = seed(repo, owner, size)
                def post(path, body):
                    response = client.post(path, json=body, headers=headers)
                    assert response.status_code == 200, response.text
                    return response.json()
                def record(name, operation, prepare=lambda: None):
                    path = None
                    if args.profile:
                        args.profile.mkdir(parents=True, exist_ok=True)
                        path = args.profile / f"{name}-{size}.prof"
                    ms, queries = measure(engine, args.runs, operation, prepare, path)
                    rows.append(dict(operation=name, size=size, ms=ms, queries=queries))
                    print(f"{name:24} {size:5} {ms:12.2f} {queries:8g}", flush=True)
                record("load_repertoire", lambda: repo.load_repertoire(rep.id))
                if args.sql_plans:
                    statements = []
                    def capture(_conn, _cursor, sql, params, _context, _many):
                        if "effective_nodes" in sql:
                            statements.append((sql, params))
                    event.listen(engine, "before_cursor_execute", capture)
                    try:
                        repo.due_counts_by_repertoire(owner)
                    finally:
                        event.remove(engine, "before_cursor_execute", capture)
                    with engine.connect() as conn:
                        for sql, params in statements:
                            print("SQL plan:", *conn.exec_driver_sql("EXPLAIN QUERY PLAN " + sql, params), sep="\n")
                state = {}
                def prepare_workspace():
                    fresh = repo.load_repertoire(rep.id)
                    leaf = nodes[-1]
                    uci = next(iter(chess.Board(leaf.fen).legal_moves)).uci()
                    builder = OpeningBuilderService(repo)
                    child = builder.add_move(rep.id, leaf.id, uci, repertoire=fresh)
                    state.update(rep=fresh, child=child.id)
                def workspace():
                    payload = build_workspace_payload(repo, rep.id, repertoire=state["rep"], owner_user_id=owner)
                    assert payload["nodes_total"] == size + 1
                def reset_workspace():
                    if "child" in state:
                        repo.delete_opening_nodes(rep.id, [state.pop("child")])
                    prepare_workspace()
                record("workspace_after_move", workspace, reset_workspace)
                repo.delete_opening_nodes(rep.id, [state.pop("child")])
                record("list_health_due", lambda: (repo.list_owner_repertoire_listings(owner),
                                                       repo.due_counts_by_repertoire(owner)))
                record("dashboard_api", lambda: client.get("/api/dashboard").raise_for_status())
                def prepare_add():
                    if "added" in state:
                        repo.delete_opening_nodes(rep.id, [state.pop("added")])
                    state["temp"] = "tmp-" + uuid.uuid4().hex
                def add():
                    payload = post("/api/build/add-moves", {"repertoire_id": rep.id, "moves": [{
                        "tempId": state["temp"], "parentRef": nodes[-1].id,
                        "uci": next(iter(chess.Board(nodes[-1].fen).legal_moves)).uci()}]})
                    state["added"] = payload["id_map"][state["temp"]]
                    assert payload["nodes_total"] == size + 1
                record("build_add_moves_api", add, prepare_add)
                repo.delete_opening_nodes(rep.id, [state.pop("added")])
                def prepare_delete():
                    child = OpeningBuilderService(repo).add_move(rep.id, nodes[-1].id,
                        next(iter(chess.Board(nodes[-1].fen).legal_moves)).uci())
                    state["delete"] = child.id
                def delete():
                    payload = post("/api/build/delete-nodes", {"repertoire_id": rep.id,
                                                                 "node_ids": [state["delete"]]})
                    assert payload["nodes_total"] == size
                record("build_delete_nodes_api", delete, prepare_delete)
                def start():
                    state["session"] = post("/api/train/smart/start", {"repertoire_id": rep.id,
                        "fresh": True, "seed": 7, "session_size": 20})
                record("smart_start_api", start)
                def smart_move():
                    session = state["session"]
                    post("/api/train/smart/move", {"session_id": session["session_id"],
                                                  "played_uci": session["cards"][0]["targets"][0]["uci"]})
                record("smart_move_api", smart_move, start)
                fresh = repo.load_repertoire(rep.id)
                record("match_one_game", lambda: match_game_to_repertoire(games[0].moves, fresh, Color.WHITE))
                record("match_game_batch", lambda: [match_game_to_repertoire(g.moves, fresh, Color.WHITE)
                                                      for g in games[:args.batch]])
                def prepare_ingest():
                    target = next(n for n in nodes if n.move and n.move.side_to_move is Color.WHITE)
                    state["summaries"] = [GameMatchSummary(
                        lichess_id=uuid.uuid4().hex, white="bench", black="opponent", result="1-0",
                        user_color="white", in_repertoire=False, matched_plies=0, departure_ply=1,
                        departure_move_uci="b2b3", departure_reason="user_left_preparation",
                        repertoire_id=rep.id, repertoire_name=rep.name, move_san_history=[],
                        expected_move_uci=target.move.uci, expected_move_san=target.move.san,
                        expected_node_id=target.id, source_account="bench") for _ in range(args.batch)]
                record("departure_ingest_batch", lambda: record_departure_misses(repo, state["summaries"],
                    owner_user_id=owner, verified_usernames=frozenset({"bench"})), prepare_ingest)
    finally:
        engine.dispose()
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runs", type=int, default=5)
    parser.add_argument("--sizes", type=int, nargs="+", default=[50, 500, 2000])
    parser.add_argument("--games", type=int, default=300)
    parser.add_argument("--batch", type=int, default=100)
    parser.add_argument("--profile", type=Path)
    parser.add_argument("--sql-plans", action="store_true")
    parser.add_argument("--baseline", type=Path, help="JSON from a previous run for comparison")
    parser.add_argument("-o", "--output", type=Path)
    args = parser.parse_args()
    if args.runs < 1 or args.games < args.batch or args.batch < 1 or min(args.sizes) < 2:
        parser.error("positive runs/batch, games >= batch, sizes >= 2 required")
    print(f"SQLite; median of {args.runs}; {args.games} stored games; batch={args.batch}")
    print(f"{'Operation':24} {'Nodes':>5} {'ms':>12} {'SQL':>8}")
    with tempfile.TemporaryDirectory(prefix="prepforge-bench-") as scratch:
        rows = run(args, Path(scratch))
    before = {(r["operation"], r["size"]): r for r in json.loads(args.baseline.read_text())} if args.baseline else {}
    lines = [f"SQLite, median of {args.runs} runs; {args.games} games; batches of {args.batch}.", "",
             "| Operation | Nodes | Before ms / SQL | After ms / SQL |",
             "|---|---:|---:|---:|"]
    for row in rows:
        old = before.get((row["operation"], row["size"]))
        previous = f"{old['ms']:.2f} / {old['queries']:g}" if old else "—"
        lines.append(f"| {row['operation']} | {row['size']} | {previous} | {row['ms']:.2f} / {row['queries']:g} |")
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text("\n".join(lines) + "\n", encoding="utf-8")
        args.output.with_suffix(".json").write_text(json.dumps(rows, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
