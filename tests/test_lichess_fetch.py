"""Parsing helpers for fetched Lichess games (the watcher's recency signal)."""
from prepforge_chess.services.lichess_fetch import (
    _build_fetched_game,
    _build_fetched_game_from_json,
    _iso_from_epoch_ms,
    _parse_ndjson_games,
    _split_multi_pgn,
)


def test_iso_from_epoch_ms_converts_to_utc():
    # 2024-06-06T12:34:56Z == 1717677296000 ms.
    assert _iso_from_epoch_ms(1717677296000) == "2024-06-06T12:34:56+00:00"


def test_iso_from_epoch_ms_is_none_for_missing_or_bad():
    assert _iso_from_epoch_ms(None) is None
    assert _iso_from_epoch_ms("nope") is None


def test_build_fetched_game_from_json_uses_last_move_at_as_finished_at():
    obj = {
        "id": "abcd1234",
        "lastMoveAt": 1717677296000,
        "winner": "white",
        "perf": "blitz",
        "players": {
            "white": {"user": {"name": "alice"}},
            "black": {"user": {"name": "bob"}},
        },
    }
    game = _build_fetched_game_from_json(obj)
    assert game.lichess_id == "abcd1234"
    assert game.finished_at == "2024-06-06T12:34:56+00:00"
    assert game.white == "alice"
    assert game.black == "bob"
    assert game.result == "1-0"
    assert game.pgn == ""


def test_build_fetched_game_from_json_handles_draw_and_ai_and_missing_ts():
    obj = {
        "id": "draw0001",
        "status": "draw",
        "players": {
            "white": {"user": {"name": "carol"}},
            "black": {"aiLevel": 5},
        },
    }
    game = _build_fetched_game_from_json(obj)
    assert game.result == "1/2-1/2"
    assert game.black == "Stockfish level 5"
    assert game.finished_at is None  # no lastMoveAt -> client treats as unknown


def test_parse_ndjson_games_skips_blank_and_malformed_lines():
    text = (
        '{"id": "aaaa1111", "lastMoveAt": 1717677296000, "winner": "black",'
        ' "players": {"white": {"user": {"name": "a"}}, "black": {"user": {"name": "b"}}}}\n'
        "\n"
        "not-json\n"
        '{"id": "bbbb2222", "lastMoveAt": 1717590896000, "status": "mate", "winner": "white",'
        ' "players": {"white": {"user": {"name": "c"}}, "black": {"user": {"name": "d"}}}}\n'
    )
    games = _parse_ndjson_games(text)
    assert [g.lichess_id for g in games] == ["aaaa1111", "bbbb2222"]
    assert games[0].result == "0-1"
    assert games[0].finished_at == "2024-06-06T12:34:56+00:00"


def test_build_fetched_game_from_pgn_carries_no_finished_at():
    # The PGN import path no longer derives a timestamp (no consumer needs one).
    pgn_block = (
        '[Event "Rated blitz game"]\n'
        '[Site "https://lichess.org/abcd1234"]\n'
        '[White "alice"]\n'
        '[Black "bob"]\n'
        '[Result "1-0"]\n\n'
        "1. e4 e5 2. Nf3 1-0\n"
    )
    game = _build_fetched_game(pgn_block)
    assert game.lichess_id == "abcd1234"
    assert game.result == "1-0"
    assert game.finished_at is None


def test_split_multi_pgn_still_parses_ids_for_importer():
    text = (
        '[Site "https://lichess.org/aaaa1111"]\n\n'
        "1. e4 e5 *\n\n"
        '[Site "https://lichess.org/bbbb2222"]\n\n'
        "1. d4 d5 *\n"
    )
    games = _split_multi_pgn(text)
    assert [g.lichess_id for g in games] == ["aaaa1111", "bbbb2222"]
