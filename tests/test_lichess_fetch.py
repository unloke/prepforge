"""Parsing helpers for fetched Lichess games (the watcher's recency signal)."""
from prepforge_chess.services.lichess_fetch import (
    FetchedGame,
    LichessFetchError,
    _build_fetched_game,
    _build_fetched_game_from_json,
    _iso_from_epoch_ms,
    _parse_ndjson_games,
    _split_multi_pgn,
    newest_game_across,
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


def _meta_game(game_id, finished_at, white="alice"):
    return FetchedGame(
        pgn="",
        white=white,
        black="bob",
        result="1-0",
        lichess_id=game_id,
        event="blitz",
        finished_at=finished_at,
    )


def test_newest_game_across_picks_truly_newest_by_finish_time(monkeypatch):
    """Two linked identities: the older primary loses to the newer second."""
    import prepforge_chess.services.lichess_fetch as fetch_mod

    calls = []

    def _fake_meta(username, count=1, **kwargs):
        calls.append(username)
        if username == "alice":
            return [_meta_game("old1111", "2024-06-05T12:00:00+00:00", white="alice")]
        return [_meta_game("new2222", "2024-06-06T12:00:00+00:00", white="bob2")]

    monkeypatch.setattr(fetch_mod, "fetch_latest_games_meta", _fake_meta)
    game, source = newest_game_across(["alice", "bob2"])
    assert game.lichess_id == "new2222"
    assert source == "bob2"
    assert sorted(calls) == ["alice", "bob2"]


def test_newest_game_across_dedups_game_ids(monkeypatch):
    import prepforge_chess.services.lichess_fetch as fetch_mod

    dup = _meta_game("same9999", "2024-06-06T12:00:00+00:00")
    monkeypatch.setattr(
        fetch_mod,
        "fetch_latest_games_meta",
        lambda username, count=1, **kw: [dup],
    )
    game, source = newest_game_across(["alice", "bob2"])
    assert game.lichess_id == "same9999"
    assert source in ("alice", "bob2")


def test_newest_game_across_tolerates_partial_failure(monkeypatch):
    """One account 429s: the other still wins instead of failing the request."""
    import prepforge_chess.services.lichess_fetch as fetch_mod

    def _fake_meta(username, count=1, **kwargs):
        if username == "alice":
            raise LichessFetchError("Lichess responded with HTTP 429 for user alice")
        return [_meta_game("solo3333", "2024-06-06T12:00:00+00:00")]

    monkeypatch.setattr(fetch_mod, "fetch_latest_games_meta", _fake_meta)
    game, source = newest_game_across(["alice", "bob2"])
    assert game.lichess_id == "solo3333"
    assert source == "bob2"


def test_newest_game_across_raises_when_every_account_fails(monkeypatch):
    import prepforge_chess.services.lichess_fetch as fetch_mod

    def _boom(username, count=1, **kwargs):
        raise LichessFetchError("down")

    monkeypatch.setattr(fetch_mod, "fetch_latest_games_meta", _boom)
    try:
        newest_game_across(["alice", "bob2"])
    except LichessFetchError:
        pass
    else:
        raise AssertionError("expected LichessFetchError when all accounts fail")


def test_newest_game_across_returns_none_when_no_games(monkeypatch):
    import prepforge_chess.services.lichess_fetch as fetch_mod

    monkeypatch.setattr(
        fetch_mod, "fetch_latest_games_meta", lambda username, count=1, **kw: []
    )
    assert newest_game_across(["alice", "bob2"]) == (None, None)
    assert newest_game_across([]) == (None, None)
