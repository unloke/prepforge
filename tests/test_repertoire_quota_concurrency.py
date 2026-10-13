"""The Free-plan cap holds when creates race on independent connections."""
from concurrent.futures import ThreadPoolExecutor
import os
from threading import Barrier
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session

from prepforge_chess.api.models import User
from prepforge_chess.core.models import Color
from prepforge_chess.services.opening_builder import CreateRepertoireRequest, OpeningBuilderService
from prepforge_chess.storage.repositories.repertoires import RepertoireQuotaExceeded
from prepforge_chess.storage.repositories.workspace import WorkspaceRepository
from prepforge_chess.storage.sa_tables import metadata
from prepforge_chess.storage.types import Plan


@pytest.fixture(params=["sqlite", "postgresql"])
def engine(tmp_path, request):
    if request.param == "postgresql":
        raw = os.environ.get("TEST_POSTGRES_URL")
        if not raw:
            pytest.skip("TEST_POSTGRES_URL not configured")
        url = make_url(raw).set(drivername="postgresql+psycopg")
        schema = "quota_test_" + uuid4().hex
        admin = create_engine(url)
        with admin.begin() as db:
            db.execute(text(f'CREATE SCHEMA "{schema}"'))
        engine = create_engine(url, connect_args={"options": f"-csearch_path={schema}"})
    else:
        admin = None
        engine = create_engine(f"sqlite:///{(tmp_path / 'quota.sqlite').as_posix()}")
    metadata.create_all(engine)
    with Session(engine) as db:
        db.add(User(id="owner", email="owner@example.test", password_hash="unused", plan=Plan.free))
        db.commit()
    yield engine
    engine.dispose()
    if admin is not None:
        with admin.begin() as db:
            db.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        admin.dispose()


def _create(engine, name, gate=None):
    if gate is not None:
        gate.wait(timeout=5)
    try:
        OpeningBuilderService(WorkspaceRepository(engine)).create_repertoire(
            CreateRepertoireRequest(name=name, color=Color.WHITE), "owner", max_owned=5,
        )
        return True
    except RepertoireQuotaExceeded:
        return False


def test_concurrent_creates_at_the_cap_admit_exactly_one(engine):
    for index in range(4):
        assert _create(engine, f"rep {index}")
    gate = Barrier(2)
    with ThreadPoolExecutor(2) as pool:
        results = list(pool.map(lambda name: _create(engine, name, gate), ["a", "b"]))
    assert sorted(results) == [False, True]
    assert len(WorkspaceRepository(engine).list_repertoire_metas(owner_user_id="owner")) == 5
    # A refused create leaves no partial tree behind.
    with engine.connect() as conn:
        orphans = conn.execute(text(
            "SELECT count(*) FROM opening_nodes WHERE repertoire_id NOT IN (SELECT id FROM repertoires)"
        )).scalar_one()
    assert orphans == 0
