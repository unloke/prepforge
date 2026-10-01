from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from time import sleep

from sqlalchemy import create_engine

from prepforge_chess.api import db


def test_concurrent_requests_share_one_lazy_engine_and_session_factory(monkeypatch):
    monkeypatch.setattr(db, "_engine", None)
    monkeypatch.setattr(db, "_SessionLocal", None)
    engines = []

    def make_engine():
        sleep(0.04)
        engine = create_engine("sqlite://")
        engines.append(engine)
        return engine

    monkeypatch.setattr(db, "make_engine", make_engine)
    gate = Barrier(8)

    def request():
        gate.wait(timeout=5)
        return db._ensure_session_factory()

    try:
        with ThreadPoolExecutor(max_workers=8) as pool:
            factories = list(pool.map(lambda _: request(), range(8)))
        assert len(engines) == 1
        assert all(factory is factories[0] for factory in factories)
        assert factories[0].kw["bind"] is db.get_engine()
    finally:
        for engine in engines:
            engine.dispose()
