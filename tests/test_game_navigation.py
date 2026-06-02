import pytest

from prepforge_chess.services.game_navigation import GameNavigationService
from prepforge_chess.services.pgn_import import PgnImportService
from prepforge_chess.storage.database import apply_schema, connect_database
from prepforge_chess.storage.repositories import PrepForgeRepository
from prepforge_chess.ui.board_contract import BoardMode, HighlightKind


def _repository_with_game():
    connection = connect_database()
    apply_schema(connection)
    repository = PrepForgeRepository(connection)
    result = PgnImportService(repository).import_text(
        """
[Event "Navigation"]
[Site "https://lichess.org/navtest1"]
[Date "2026.05.25"]
[White "Alice"]
[Black "Bob"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 1-0
"""
    )
    return repository, result.imported_game_ids[0]


def test_navigation_state_at_initial_position():
    repository, game_id = _repository_with_game()
    state = GameNavigationService(repository).state_for_game_id(game_id, ply=0)

    assert state.current_ply == 0
    assert state.total_plies == 6
    assert state.board_state.mode is BoardMode.ANALYZE
    assert state.board_state.last_move_uci is None
    assert state.current_move is None
    assert state.next_move is not None
    assert state.next_move.uci == "e2e4"
    assert sorted(state.board_state.legal_targets_from("e2")) == ["e3", "e4"]


def test_navigation_state_highlights_last_move_and_exposes_next_move():
    repository, game_id = _repository_with_game()
    state = GameNavigationService(repository).state_for_game_id(game_id, ply=4)

    assert state.current_move is not None
    assert state.current_move.uci == "b8c6"
    assert state.previous_move is not None
    assert state.previous_move.uci == "g1f3"
    assert state.next_move is not None
    assert state.next_move.uci == "f1b5"
    assert state.board_state.last_move_uci == "b8c6"
    assert [(item.square, item.kind) for item in state.board_state.highlighted_squares] == [
        ("b8", HighlightKind.LAST_MOVE),
        ("c6", HighlightKind.LAST_MOVE),
    ]
    assert state.board_state.metadata["current_ply"] == "4"


def test_navigation_rejects_out_of_range_ply():
    repository, game_id = _repository_with_game()

    with pytest.raises(ValueError):
        GameNavigationService(repository).state_for_game_id(game_id, ply=99)
