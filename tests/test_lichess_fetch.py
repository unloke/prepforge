"""Parsing helpers for fetched Lichess games (the watcher's recency signal)."""
from prepforge_chess.services.lichess_fetch import (
    FetchedGame,
    LichessFetchError,
    _build_fetched_game,
    _build_fetched_game_from_json,
    _iso_from_epoch_ms,
    _iso_from_pgn_datetime,
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
    # A PGN block without UTCDate/UTCTime carries no finish timestamp.
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


def test_iso_from_pgn_datetime_derives_canonical_finish_time():
    assert _iso_from_pgn_datetime("2026.06.08", "10:00:00") == "2026-06-08T10:00:00+00:00"
    assert _iso_from_pgn_datetime(None, "10:00:00") is None
    assert _iso_from_pgn_datetime("2026.06.08", None) is None
    assert _iso_from_pgn_datetime("2026.??.??", "10:00:00") is None
    assert _iso_from_pgn_datetime("2026.06.08", "??:??:??") is None
    assert _iso_from_pgn_datetime("not-a-date", "10:00:00") is None


def test_build_fetched_game_derives_finished_at_from_utc_headers():
    pgn_block = (
        '[Event "Rated blitz game"]\n'
        '[Site "https://lichess.org/abcd1234"]\n'
        '[UTCDate "2026.06.08"]\n'
        '[UTCTime "10:00:00"]\n'
        '[White "alice"]\n'
        '[Black "bob"]\n'
        '[Result "1-0"]\n\n'
        "1. e4 e5 2. Nf3 1-0\n"
    )
    game = _build_fetched_game(pgn_block)
    assert game.finished_at == "2026-06-08T10:00:00+00:00"


def test_newest_game_across_pgn_path_ranks_by_end_timestamp(monkeypatch):
    """S1: My-last-game PGN fetch must rank by UTCDate/UTCTime, so the truly
    newest game wins even when the older account answers first."""
    import time

    import prepforge_chess.services.lichess_fetch as fetch_mod

    def _block(username, date, game_id, delay=0.0):
        return (
            '[Event "Rated blitz game"]\n'
            '[Site "https://lichess.org/{0}"]\n'
            '[UTCDate "{1}"]\n'
            '[UTCTime "10:00:00"]\n'
            '[White "{2}"]\n'
            '[Black "Opponent"]\n'
            '[Result "1-0"]\n\n'
            "1. e4 e5 1-0\n"
        ).format(game_id, date, username), delay

    blocks = {
        "alice": _block("alice", "2026.06.07", "pgn-older"),
        "bob2": _block("bob2", "2026.06.08", "pgn-newer", delay=0.05),
    }

    def _fake_pgn(username, count=1, **kwargs):
        from prepforge_chess.services.lichess_fetch import _build_fetched_game

        text, delay = blocks[username]
        if delay:
            time.sleep(delay)
        return [_build_fetched_game(text)]

    monkeypatch.setattr(fetch_mod, "fetch_recent_pgns", _fake_pgn)
    game, source = fetch_mod.newest_game_across(["alice", "bob2"], with_moves=True)
    assert game.lichess_id == "pgn-newer"
    assert source == "bob2"


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
