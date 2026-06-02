from prepforge_chess.services.pgn_import import PgnImportService
from prepforge_chess.storage.database import apply_schema, connect_database
from prepforge_chess.storage.repositories import PrepForgeRepository


def _service() -> PgnImportService:
    connection = connect_database()
    apply_schema(connection)
    return PgnImportService(PrepForgeRepository(connection))


def test_import_service_persists_multiple_pgn_games():
    service = _service()
    pgn = """
[Event "One"]
[Site "https://lichess.org/importsvc1"]
[Date "2026.05.25"]
[White "Alice"]
[Black "Bob"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 1-0

[Event "Two"]
[Site "https://lichess.org/importsvc2"]
[Date "2026.05.25"]
[White "Carol"]
[Black "Dan"]
[Result "0-1"]

1. d4 Nf6 2. c4 e6 0-1
"""

    result = service.import_text(pgn)

    assert result.total_games == 2
    assert result.imported_count == 2
    assert result.skipped_count == 0
    assert result.errors == []

    loaded = [service.repository.load_game(game_id) for game_id in result.imported_game_ids]
    assert [game.white for game in loaded if game is not None] == ["Alice", "Carol"]
    assert [len(game.moves) for game in loaded if game is not None] == [4, 4]


def test_import_service_skips_duplicate_lichess_games():
    service = _service()
    pgn = """
[Event "Duplicate"]
[Site "https://lichess.org/dupgame1"]
[Date "2026.05.25"]
[White "Alice"]
[Black "Bob"]
[Result "1-0"]

1. e4 c5 2. Nf3 d6 1-0
"""

    first = service.import_text(pgn)
    second = service.import_text(pgn)

    assert first.imported_count == 1
    assert second.imported_count == 0
    assert second.skipped_game_ids == first.imported_game_ids
    assert len(service.repository.list_games()) == 1


def test_import_service_reports_empty_pgn():
    service = _service()

    result = service.import_text("")

    assert result.total_games == 0
    assert result.imported_game_ids == []
    assert result.errors == ["No PGN games found."]


def test_import_service_skips_duplicate_content_without_lichess_id():
    service = _service()
    pgn = """
[Event "Local game"]
[White "Eve"]
[Black "Mallory"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 1-0
"""

    first = service.import_text(pgn)
    second = service.import_text(pgn)

    assert first.imported_count == 1
    assert second.imported_count == 0
    assert second.skipped_count == 1
    assert len(service.repository.list_games()) == 1


def test_import_service_rejects_garbage_text():
    service = _service()

    result = service.import_text("this is not a pgn at all")

    assert result.imported_count == 0
    assert result.errors  # a clear error, not a silent success
    assert "valid PGN" in result.errors[0]


def test_import_service_rejects_headers_without_moves():
    service = _service()
    pgn = """
[Event "Headers only"]
[White "Alice"]
[Black "Bob"]
[Result "1-0"]
"""

    result = service.import_text(pgn)

    assert result.imported_count == 0
    assert result.errors
    assert "No moves found" in result.errors[0]


def test_import_service_imports_valid_and_flags_broken_game():
    service = _service()
    pgn = """
[Event "Good"]
[Site "https://lichess.org/goodgame1"]
[White "Alice"]
[Black "Bob"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 1-0

[Event "Broken"]
[White "Carol"]
[Black "Dan"]
[Result "*"]
"""

    result = service.import_text(pgn)

    assert result.total_games == 2
    assert result.imported_count == 1
    assert len(result.errors) == 1
    assert "game 2" in result.errors[0]
