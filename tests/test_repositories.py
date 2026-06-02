from prepforge_chess.core.chess_core import STARTING_FEN, ChessCore
from prepforge_chess.core.models import (
    Color,
    EngineEvaluation,
    MoveClassification,
    MoveSource,
    OpeningNode,
    Repertoire,
    TrainingMode,
    TrainingProgress,
    TrainingSession,
)
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
    repo.save_training_progress("train-rep", progress)

    loaded_session = repo.load_training_session("session-1")
    latest_session = repo.load_latest_training_session("train-rep", TrainingMode.ALL_LINES)
    loaded_progress = repo.load_training_progress("train-rep", "train-e4")

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
