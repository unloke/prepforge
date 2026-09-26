import os
import uuid

import pytest
from sqlalchemy import create_engine, text, update

from prepforge_chess.core.chess_core import STARTING_FEN, ChessCore
from prepforge_chess.core.models import (
    Color,
    EngineEvaluation,
    Game,
    GameResult,
    MoveClassification,
    MoveSource,
    OpeningNode,
    Repertoire,
    TrainingMode,
    TrainingProgress,
    TrainingSession,
)
from prepforge_chess.storage import sa_tables
from prepforge_chess.storage.database import apply_schema, connect_database
from prepforge_chess.storage.repositories import PrepForgeRepository


def _repository() -> PrepForgeRepository:
    connection = connect_database()
    apply_schema(connection)
    return PrepForgeRepository(connection)


def test_game_round_trip_persists_full_move_identity():
    core = ChessCore()
    repo = _repository()
    pgn = """
[Event "Repository Test"]
[Site "https://lichess.org/roundtrip1"]
[Date "2026.05.25"]
[White "Alice"]
[Black "Bob"]
[Result "1/2-1/2"]

1. d4 Nf6 2. c4 e6 3. Nc3 Bb4 1/2-1/2
"""
    game = core.import_single_pgn(pgn)
    game.moves[0].classification = MoveClassification.BEST
    game.moves[0].engine_eval_after = EngineEvaluation(
        engine="stockfish",
        depth=12,
        score_cp=28,
        best_move_uci="d2d4",
        pv=["d2d4", "g8f6"],
    )
    game.moves[0].tags.append("queen_pawn")

    repo.save_game(game)
    loaded = repo.load_game(game.id)

    assert loaded is not None
    assert loaded.lichess_id == "roundtrip1"
    assert loaded.result.value == "1/2-1/2"
    assert [move.uci for move in loaded.moves] == [
        "d2d4",
        "g8f6",
        "c2c4",
        "e7e6",
        "b1c3",
        "f8b4",
    ]
    assert loaded.moves[0].fen_before == STARTING_FEN
    assert loaded.moves[0].classification is MoveClassification.BEST
    assert loaded.moves[0].engine_eval_after is not None
    assert loaded.moves[0].engine_eval_after.score_cp == 28
    assert loaded.moves[0].tags == ["queen_pawn"]


def test_repertoire_tree_round_trip_rebuilds_children_and_metadata():
    core = ChessCore()
    repo = _repository()

    root = OpeningNode(
        id="root",
        repertoire_id="rep-1",
        fen=STARTING_FEN,
        side_to_move=Color.WHITE,
        is_mainline=True,
        comment="Queen's Gambit root",
    )
    d4 = core.apply_uci(STARTING_FEN, "d2d4", source=MoveSource.MANUAL)
    child = OpeningNode(
        id="node-d4",
        repertoire_id="rep-1",
        parent_id=root.id,
        move=d4,
        fen=d4.fen_after,
        side_to_move=Color.BLACK,
        is_mainline=True,
        is_user_prepared_move=True,
        priority=8.5,
        comment="Main repertoire move",
        tags=["prepared", "mainline"],
        engine_evaluation=EngineEvaluation(
            engine="stockfish",
            depth=14,
            score_cp=30,
            best_move_uci="d2d4",
        ),
    )
    root.children.append(child)
    repertoire = Repertoire(
        id="rep-1",
        name="Queen's Gambit as White",
        color=Color.WHITE,
        root_fen=STARTING_FEN,
        root_node=root,
        notes="Phase 1 persistence test",
    )

    repo.save_repertoire(repertoire)
    loaded = repo.load_repertoire("rep-1")

    assert loaded is not None
    assert loaded.name == "Queen's Gambit as White"
    assert loaded.root_node.id == "root"
    assert loaded.root_node.children

    loaded_child = loaded.root_node.children[0]
    assert loaded_child.id == "node-d4"
    assert loaded_child.parent_id == "root"
    assert loaded_child.move is not None
    assert loaded_child.move.uci == "d2d4"
    assert loaded_child.is_user_prepared_move
    assert loaded_child.tags == ["prepared", "mainline"]
    assert loaded_child.engine_evaluation is not None
    assert loaded_child.engine_evaluation.depth == 14


def test_delete_repertoire_cascades_opening_nodes():
    repo = _repository()
    root = OpeningNode(
        id="delete-root",
        repertoire_id="delete-rep",
        fen=STARTING_FEN,
        side_to_move=Color.WHITE,
    )
    repertoire = Repertoire(
        id="delete-rep",
        name="Delete Me",
        color=Color.WHITE,
        root_fen=STARTING_FEN,
        root_node=root,
    )

    repo.save_repertoire(repertoire)
    repo.delete_repertoire("delete-rep")

    assert repo.load_repertoire("delete-rep") is None


def test_training_session_and_progress_round_trip():
    core = ChessCore()
    repo = _repository()
    root = OpeningNode(
        id="train-root",
        repertoire_id="train-rep",
        fen=STARTING_FEN,
        side_to_move=Color.WHITE,
    )
    move = core.apply_uci(STARTING_FEN, "e2e4", source=MoveSource.MANUAL)
    child = OpeningNode(
        id="train-e4",
        repertoire_id="train-rep",
        parent_id=root.id,
        move=move,
        fen=move.fen_after,
        side_to_move=Color.BLACK,
    )
    root.children.append(child)
    repo.save_repertoire(
        Repertoire(
            id="train-rep",
            name="Training Rep",
            color=Color.WHITE,
            root_fen=STARTING_FEN,
            root_node=root,
        )
    )

    session = TrainingSession(
        id="session-1",
        repertoire_id="train-rep",
        mode=TrainingMode.ALL_LINES,
        line_order=["train-e4", "train-root"],
        current_index=1,
        current_node_id="train-e4",
        mistakes=["train-e4"],
        mastered_nodes=["train-root"],
        seed=99,
    )
    progress = TrainingProgress(
        node_id="train-e4",
        attempts=4,
        correct_attempts=2,
        spaced_repetition_score=3.5,
        is_mastered=False,
    )

    repo.save_training_session(session)
    repo.save_training_progress("train-rep", progress, owner_user_id="u1")

    loaded_session = repo.load_training_session("session-1")
    latest_session = repo.load_latest_training_session("train-rep", TrainingMode.ALL_LINES)
    loaded_progress = repo.load_training_progress(
        "train-rep", "train-e4", owner_user_id="u1"
    )

    assert loaded_session is not None
    assert loaded_session.line_order == ["train-e4", "train-root"]
    assert loaded_session.current_index == 1
    assert loaded_session.current_node_id == "train-e4"
    assert loaded_session.mistakes == ["train-e4"]
    assert loaded_session.mastered_nodes == ["train-root"]
    assert loaded_session.seed == 99
    assert latest_session is not None
    assert latest_session.id == "session-1"

    assert loaded_progress is not None
    assert loaded_progress.node_id == "train-e4"
    assert loaded_progress.attempts == 4
    assert loaded_progress.correct_attempts == 2
    assert loaded_progress.spaced_repetition_score == 3.5
    assert not loaded_progress.is_mastered


# ---- user_settings (canonical 1:1 key/value store) ---------------------------
# Each per-user fact lives in its own row, so concurrent writers to different
# keys never clobber each other. ``FOR UPDATE`` serialises same-key writers on
# Postgres (a no-op on SQLite, where these run), so we test logic, not locks.


def test_mutate_user_setting_folds_over_current_value():
    repo = _repository()
    uid = "u-settings-1"

    def bump(current):
        return {"n": (current or {}).get("n", 0) + 1}

    assert repo.mutate_user_setting(uid, "streak", bump) == {"n": 1}
    assert repo.mutate_user_setting(uid, "streak", bump) == {"n": 2}
    assert repo.get_user_setting(uid, "streak") == {"n": 2}


def test_mutate_does_not_clobber_a_sibling_key():
    repo = _repository()
    uid = "u-settings-2"
    repo.set_user_setting(uid, "streak", {"current": 4})
    repo.set_user_setting(uid, "recap", {"week": "w24"})  # other key, other writer

    seen = {}

    def advance(current):
        seen["value"] = current
        return {"current": (current or {}).get("current", 0) + 1}

    repo.mutate_user_setting(uid, "streak", advance)

    assert seen["value"] == {"current": 4}  # read the latest, not a stale blob
    assert repo.get_user_setting(uid, "streak") == {"current": 5}
    assert repo.get_user_setting(uid, "recap") == {"week": "w24"}  # untouched


def test_mutate_user_setting_deletes_on_none():
    repo = _repository()
    uid = "u-settings-3"
    repo.set_user_setting(uid, "token", "abc")

    assert repo.mutate_user_setting(uid, "token", lambda _c: None) is None
    assert repo.get_user_setting(uid, "token", "MISSING") == "MISSING"


def test_attempt_receipt_round_trip():
    import uuid as _uuid

    repo = _repository()
    session_id = _uuid.uuid4().hex
    assert repo.get_attempt_receipt(session_id, "a1") is None
    with repo.engine.begin() as conn:
        repo.record_attempt_receipt(
            conn, session_id=session_id, attempt_uuid="a1", node_id="n1", correct=True
        )
    receipt = repo.get_attempt_receipt(session_id, "a1")
    assert receipt == {
        "session_id": session_id,
        "attempt_uuid": "a1",
        "node_id": "n1",
        "correct": True,
    }


def test_game_persist_does_not_store_fen_or_pgn_copies():
    core = ChessCore()
    repo = _repository()
    game = core.import_single_pgn(
        """
[Event "Compact"]
[White "A"]
[Black "B"]
[Result "*"]

1. e4 e5 2. Nf3 Nc6 *
"""
    )
    repo.save_game(game)
    with repo.engine.connect() as conn:
        row = conn.execute(
            text("SELECT uci_blob FROM games WHERE id = :id"),
            {"id": game.id},
        ).mappings().one()
        cols = conn.execute(text("PRAGMA table_info(games)")).fetchall()
    names = {c[1] for c in cols}
    assert "pgn" not in names
    assert "uci_blob" in names
    assert row["uci_blob"] == "e2e4 e7e5 g1f3 b8c6"
    loaded = repo.load_game(game.id)
    assert [m.uci for m in loaded.moves] == ["e2e4", "e7e5", "g1f3", "b8c6"]
    assert loaded.moves[0].san == "e4"
    assert loaded.moves[0].fen_before == STARTING_FEN
    assert loaded.pgn is not None
    assert "e4" in loaded.pgn


def test_engine_eval_dedup_and_position_uniqueness():
    core = ChessCore()
    repo = _repository()
    ev = EngineEvaluation(
        engine="stockfish",
        depth=16,
        nodes=1000,
        time_ms=50,
        score_cp=12,
        best_move_uci="e2e4",
        pv=["e2e4", "e7e5"],
        wdl={"win": 0.3, "draw": 0.5, "loss": 0.2},
    )
    g1 = core.import_single_pgn("1. e4 e5 *")
    g1.id = "g-eval-1"
    g1.moves[0].engine_eval_before = ev
    g2 = core.import_single_pgn("1. e4 c5 *")
    g2.id = "g-eval-2"
    g2.moves[0].engine_eval_before = EngineEvaluation(
        engine="stockfish",
        depth=16,
        nodes=1000,
        time_ms=50,
        score_cp=99,
        best_move_uci="e2e4",
        pv=["e2e4"],
        wdl={"win": 0.3, "draw": 0.5, "loss": 0.2},
    )
    repo.save_game(g1)
    repo.save_game(g2)
    with repo.engine.connect() as conn:
        n_eval = conn.execute(text("SELECT COUNT(*) FROM engine_evaluations")).scalar_one()
        n_pos = conn.execute(text("SELECT COUNT(*) FROM positions")).scalar_one()
    # Same starting FEN + same config is one eval row (score updates, does not duplicate).
    assert n_eval == 1
    assert n_pos == 1
    loaded = repo.load_game("g-eval-2")
    assert loaded.moves[0].engine_eval_before.score_cp == 99
    assert loaded.moves[0].engine_eval_before.wdl["draw"] == 0.5


def test_default_config_eval_null_limits_last_write_wins():
    """Default EngineAnalysisConfig uses nodes=None, time_ms=None.

    SQL UNIQUE treats those NULLs as distinct, so the writer must persist a
    NULL-safe identity. Two saves of the same FEN/engine/depth must be one
    cache row; the second score wins.
    """
    core = ChessCore()
    repo = _repository()
    first = EngineEvaluation(engine="stockfish", depth=10, nodes=None, time_ms=None, score_cp=5)
    latest = EngineEvaluation(engine="stockfish", depth=10, nodes=None, time_ms=None, score_cp=42)
    g1 = core.import_single_pgn("1. e4 e5 *")
    g1.id = "g-null-1"
    g1.moves[0].engine_eval_before = first
    g2 = core.import_single_pgn("1. e4 c5 *")
    g2.id = "g-null-2"
    g2.moves[0].engine_eval_before = latest
    repo.save_game(g1)
    repo.save_game(g2)
    with repo.engine.connect() as conn:
        n_eval = conn.execute(text("SELECT COUNT(*) FROM engine_evaluations")).scalar_one()
        stored = conn.execute(
            text("SELECT depth, nodes, time_ms, score_cp FROM engine_evaluations")
        ).mappings().one()
    assert n_eval == 1
    assert stored["score_cp"] == 42
    loaded = repo.load_game("g-null-2")
    assert loaded.moves[0].engine_eval_before is not None
    assert loaded.moves[0].engine_eval_before.score_cp == 42
    assert loaded.moves[0].engine_eval_before.nodes is None
    assert loaded.moves[0].engine_eval_before.time_ms is None
    assert loaded.moves[0].engine_eval_before.depth == 10
    older = repo.load_game("g-null-1")
    assert older.moves[0].engine_eval_before.score_cp == 42


def test_distinct_castling_and_ep_get_distinct_position_rows():
    repo = _repository()
    core = ChessCore()
    ev = EngineEvaluation(engine="stockfish", depth=8, nodes=10, time_ms=1, score_cp=0)
    castle_both = "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1"
    castle_none = "r3k2r/8/8/8/8/8/8/R3K2R w - - 0 1"
    ep = "rnbqkbnr/ppp1pppp/8/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 3"
    no_ep = "rnbqkbnr/ppp1pppp/8/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq - 0 3"
    stm_w = STARTING_FEN
    stm_b = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1"
    for i, fen in enumerate((castle_both, castle_none, ep, no_ep, stm_w, stm_b)):
        rec = core.apply_uci(fen, list(core.legal_moves(fen))[0])
        rec.engine_eval_before = ev
        rec.ply = 1

        repo.save_game(
            Game(
                id=f"id-{i}",
                source=MoveSource.MANUAL,
                initial_fen=fen,
                moves=[rec],
                result=GameResult.UNKNOWN,
            )
        )
    with repo.engine.connect() as conn:
        fens = [r[0] for r in conn.execute(text("SELECT fen FROM positions"))]
    assert len(fens) == 6
    assert len(set(fens)) == 6


# ---- list_repertoires: batched listing (no N+1 load_repertoire) -------------


def _tree_repertoire(rep_id: str, name: str, ucs: list, tag: str, owner: str) -> Repertoire:
    """A root plus a prepared mainline chain (``ucs``) with an eval on the leaf."""
    core = ChessCore()
    root = OpeningNode(
        id=f"{rep_id}-root",
        repertoire_id=rep_id,
        fen=STARTING_FEN,
        side_to_move=Color.WHITE,
        is_mainline=True,
    )
    parent = root
    fen = STARTING_FEN
    for index, uci in enumerate(ucs):
        record = core.apply_uci(fen, uci, source=MoveSource.MANUAL)
        child = OpeningNode(
            id=f"{rep_id}-n{index}",
            repertoire_id=rep_id,
            parent_id=parent.id,
            move=record,
            fen=record.fen_after,
            side_to_move=core.side_to_move(record.fen_after),
            is_mainline=True,
            is_user_prepared_move=True,
            tags=[tag],
            engine_evaluation=(
                EngineEvaluation(
                    engine="stockfish", depth=12, score_cp=20, best_move_uci=uci
                )
                if index == len(ucs) - 1
                else None
            ),
        )
        parent.children.append(child)
        parent = child
        fen = record.fen_after
    return Repertoire(
        id=rep_id,
        name=name,
        color=Color.WHITE,
        root_fen=STARTING_FEN,
        root_node=root,
        notes=f"{name} notes",
        tags=[tag],
    )


def _tree_signature(node):
    return (
        node.id,
        node.parent_id,
        node.move.uci if node.move else None,
        node.fen,
        node.is_mainline,
        node.is_user_prepared_move,
        node.is_enabled,
        node.comment,
        tuple(node.tags),
        node.engine_evaluation.score_cp if node.engine_evaluation else None,
        tuple(_tree_signature(child) for child in node.children),
    )


def _same_repertoire(a, b) -> bool:
    """Deep equivalence between a listed and a single-loaded repertoire."""
    return (
        a.id == b.id
        and a.name == b.name
        and a.color == b.color
        and a.root_fen == b.root_fen
        and a.notes == b.notes
        and a.tags == b.tags
        and a.is_active == b.is_active
        and a.main_engine == b.main_engine
        and a.branch_depth == b.branch_depth
        and a._cached_health == b._cached_health
        and _tree_signature(a.root_node) == _tree_signature(b.root_node)
    )


def _exercise_list_repertoires(repo, owner: str) -> None:
    """Empty → single → multi(+nodes) → ordering, against any backend.

    Every assertion is owner-scoped so the exercise stays hermetic when it runs
    on a shared PostgreSQL database (TEST_POSTGRES_URL CI job).
    """
    # Empty: no repertoires for this owner.
    assert repo.list_repertoires(owner_user_id=owner) == []

    # Single: a small tree round-trips exactly like load_repertoire.
    repo.save_repertoire(
        _tree_repertoire("rep-a", "Alpha", ["e2e4"], "kp", owner),
        owner_user_id=owner,
    )
    listed = repo.list_repertoires(owner_user_id=owner)
    assert [rep.id for rep in listed] == ["rep-a"]
    assert _same_repertoire(listed[0], repo.load_repertoire("rep-a"))
    leaf = listed[0].root_node.children[0]
    assert leaf.move.uci == "e2e4"
    assert leaf.tags == ["kp"]
    assert leaf.engine_evaluation is not None
    assert leaf.engine_evaluation.depth == 12

    # Multi: several repertoires, several nodes each; owner-scoped listing.
    repo.save_repertoire(
        _tree_repertoire("rep-b", "Beta", ["d2d4", "d7d5"], "qg", owner),
        owner_user_id=owner,
    )
    repo.save_repertoire(
        _tree_repertoire("rep-c", "Gamma", ["c2c4", "c7c5", "b1c3"], "eng", owner),
        owner_user_id=owner,
    )
    repo.save_repertoire(
        _tree_repertoire("rep-foreign", "Foreign", ["g1f3"], "other", "someone-else"),
        owner_user_id="someone-else",
    )
    scoped = repo.list_repertoires(owner_user_id=owner)
    assert sorted(rep.id for rep in scoped) == ["rep-a", "rep-b", "rep-c"]
    assert [len(rep.root_node.children) for rep in scoped] == [1, 1, 1]
    deep = next(rep for rep in scoped if rep.id == "rep-c")
    chain = [deep.root_node]
    while chain[-1].children:
        chain.append(chain[-1].children[0])
    assert [node.move.uci for node in chain[1:]] == ["c2c4", "c7c5", "b1c3"]
    assert chain[-1].engine_evaluation is not None
    for rep in scoped:
        assert _same_repertoire(rep, repo.load_repertoire(rep.id))

    # Ordering: newest first, pinned timestamps so the assertion is deterministic.
    stamps = {
        "rep-a": "2026-01-01T00:00:00+00:00",
        "rep-b": "2026-02-01T00:00:00+00:00",
        "rep-c": "2026-03-01T00:00:00+00:00",
    }
    with repo.engine.begin() as conn:
        for rep_id, iso in stamps.items():
            conn.execute(
                update(sa_tables.repertoires)
                .where(sa_tables.repertoires.c.id == rep_id)
                .values(updated_at=iso)
            )
    ordered = repo.list_repertoires(owner_user_id=owner)
    assert [rep.id for rep in ordered] == ["rep-c", "rep-b", "rep-a"]
    # …and the documented invariant holds: same set and order as
    # list_repertoire_metas.
    assert [row["id"] for row in repo.list_repertoire_metas(owner_user_id=owner)] == [
        "rep-c",
        "rep-b",
        "rep-a",
    ]


def test_list_repertoires_sqlite():
    repo = _repository()
    _exercise_list_repertoires(repo, owner="u-list-" + uuid.uuid4().hex[:8])


def test_list_repertoires_postgres(monkeypatch):
    url = os.getenv("TEST_POSTGRES_URL")
    if not url:
        pytest.skip("TEST_POSTGRES_URL is not configured")
    engine = create_engine(url, future=True)
    sa_tables.metadata.create_all(engine, tables=list(sa_tables.DOMAIN_TABLES))
    repo = PrepForgeRepository(engine)
    _exercise_list_repertoires(repo, owner="u-list-" + uuid.uuid4().hex[:8])
