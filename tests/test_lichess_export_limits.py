from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
from threading import Lock
from time import sleep
from urllib.error import HTTPError
from urllib.request import Request

import pytest

from prepforge_chess.services import lichess_fetch as fetch


@pytest.fixture(autouse=True)
def reset_exports(monkeypatch):
    fetch._export_cache.clear()
    monkeypatch.setattr(fetch, "_export_cooldown_until", 0)
    yield
    fetch._export_cache.clear()


def test_cached_exports_are_bounded_and_isolated_by_format(monkeypatch):
    calls = []

    def response(request, **kwargs):
        calls.append(request.full_url)
        return BytesIO(b"public games")

    monkeypatch.setattr(fetch.urllib.request, "urlopen", response)
    monkeypatch.setattr(fetch, "_EXPORT_CACHE_BYTES", 12)
    first = Request("https://lichess.org/first", headers={"Accept": "pgn"})
    assert fetch._read_game_export(first, timeout=1) == "public games"
    fetch._read_game_export(first, timeout=1)
    assert len(calls) == 1
    fetch._read_game_export(Request(first.full_url, headers={"Accept": "json"}), timeout=1)
    assert len(calls) == 2
    assert len(fetch._export_cache) == 1


def test_cache_expires(monkeypatch):
    now = [0]
    monkeypatch.setattr(fetch.time, "monotonic", lambda: now[0])
    calls = []
    monkeypatch.setattr(fetch.urllib.request, "urlopen", lambda *a, **k: calls.append(1) or BytesIO(b""))
    request = Request("https://lichess.org/export")
    fetch._read_game_export(request, timeout=1)
    now[0] = fetch._EXPORT_CACHE_TTL + 1
    fetch._read_game_export(request, timeout=1)
    assert len(calls) == 2


def test_shared_429_cooldown_prevents_other_username_requests(monkeypatch):
    calls = []

    def response(request, **kwargs):
        calls.append(1)
        raise HTTPError(request.full_url, 429, "limited", {"Retry-After": "120"}, None)

    monkeypatch.setattr(fetch.urllib.request, "urlopen", response)
    for name in ["alpha", "beta"]:
        with pytest.raises(fetch.GamesRateLimitedError) as error:
            fetch.fetch_recent_pgns(name, 10)
        assert 1 <= error.value.retry_after <= 120
    assert len(calls) == 1


def test_response_size_is_bounded(monkeypatch):
    monkeypatch.setattr(fetch, "_EXPORT_RESPONSE_BYTES", 5)
    monkeypatch.setattr(fetch.urllib.request, "urlopen", lambda *a, **k: BytesIO(b"123456"))
    with pytest.raises(fetch.LichessFetchError, match="size limit"):
        fetch.fetch_recent_pgns("alpha", 10)
    assert not fetch._export_cache


def test_parallel_requests_share_four_upstream_slots(monkeypatch):
    lock = Lock()
    active = 0
    peak = 0

    def response(*args, **kwargs):
        nonlocal active, peak
        with lock:
            active += 1
            peak = max(peak, active)
        sleep(0.02)
        with lock:
            active -= 1
        return BytesIO(b"")

    monkeypatch.setattr(fetch.urllib.request, "urlopen", response)
    with ThreadPoolExecutor(max_workers=12) as pool:
        list(pool.map(lambda i: fetch.fetch_recent_pgns(f"user{i}", 10), range(12)))
    assert peak <= 4


def test_service_budget_rejects_before_repository_or_upstream():
    with pytest.raises(ValueError, match="at most"):
        fetch.compare_many_identities(None, [f"user{i}" for i in range(9)], 10)
    with pytest.raises(ValueError, match="fewer accounts"):
        fetch.compare_many_identities(None, [f"user{i}" for i in range(5)], 50)
