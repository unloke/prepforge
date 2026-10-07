"""Exercise webhook transactions with independent connections, not sequential deliveries."""
from concurrent.futures import ThreadPoolExecutor
import os
from threading import Barrier
from time import sleep
from uuid import uuid4

import pytest
import stripe
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session, sessionmaker

from prepforge_chess.api.config import Settings
from prepforge_chess.api.db import get_db
from prepforge_chess.storage.sa_tables import metadata
from prepforge_chess.api.models import StripeEvent, User
from prepforge_chess.storage.types import Plan
from prepforge_chess.api.routers import billing


@pytest.fixture(params=["sqlite", "postgresql"])
def webhook(tmp_path, monkeypatch, request):
    admin = None
    if request.param == "postgresql":
        raw = os.environ.get("TEST_POSTGRES_URL")
        if not raw:
            pytest.skip("TEST_POSTGRES_URL not configured")
        url = make_url(raw).set(drivername="postgresql+psycopg")
        schema = "billing_test_" + uuid4().hex
        admin = create_engine(url)
        with admin.begin() as db:
            db.execute(text(f'CREATE SCHEMA "{schema}"'))
        engine = create_engine(url, connect_args={"options": f"-csearch_path={schema}"})
    else:
        engine = create_engine(f"sqlite:///{(tmp_path / 'webhook.sqlite').as_posix()}")
    metadata.create_all(engine)
    class RacingSession(Session):
        initial_checks = None

        def get(self, entity, ident, **kwargs):
            result = super().get(entity, ident, **kwargs)
            if entity is StripeEvent and self.initial_checks is not None:
                self.initial_checks.wait(timeout=5)
            return result

    factory = sessionmaker(engine, class_=RacingSession)
    with factory() as db:
        db.add(User(id="owner", email="owner@example.test", password_hash="unused",
                    stripe_customer_id="cus_owner", plan=Plan.free))
        db.commit()
    app = FastAPI()
    app.include_router(billing.router)

    def session():
        with factory() as db:
            yield db

    app.dependency_overrides[get_db] = session
    app.dependency_overrides[billing.get_settings] = lambda: Settings(stripe_webhook_secret="secret")
    event = {"id": "evt_shared", "type": "checkout.session.completed",
             "data": {"object": {"customer": "cus_owner", "client_reference_id": "owner"}}}
    monkeypatch.setattr(stripe.Webhook, "construct_event", lambda *a: event)
    yield TestClient(app, raise_server_exceptions=False), factory, event
    engine.dispose()
    if admin is not None:
        with admin.begin() as db:
            db.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        admin.dispose()


def test_parallel_deliveries_claim_event_before_applying(webhook, monkeypatch):
    client, factory, _ = webhook
    factory.class_.initial_checks = Barrier(2)
    original = billing._apply_event
    calls = []

    def apply(db, event):
        calls.append(event["id"])
        sleep(0.05)  # second request arrives while the first transaction is open
        original(db, event)

    monkeypatch.setattr(billing, "_apply_event", apply)
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda _: client.post(billing.WEBHOOK_PATH, content=b"{}"), range(2)))
    assert [r.status_code for r in responses] == [200, 200]
    assert calls == ["evt_shared"]
    with factory() as db:
        assert db.get(User, "owner").plan == Plan.pro
        assert len(db.scalars(select(StripeEvent)).all()) == 1


def test_customer_is_authoritative_over_reference_metadata(webhook):
    client, factory, event = webhook
    event["data"]["object"]["customer"] = "cus_unbound"
    assert client.post(billing.WEBHOOK_PATH, content=b"{}").status_code == 200
    with factory() as db:
        assert db.get(User, "owner").plan == Plan.free
        assert db.get(User, "owner").stripe_customer_id == "cus_owner"


def test_failed_effect_rolls_back_claim_for_retry(webhook, monkeypatch):
    client, factory, _ = webhook
    original = billing._apply_event

    def fail(db, event):
        original(db, event)
        raise RuntimeError("effect failed")

    monkeypatch.setattr(billing, "_apply_event", fail)
    assert client.post(billing.WEBHOOK_PATH, content=b"{}").status_code == 500
    with factory() as db:
        assert db.get(User, "owner").plan == Plan.free
        assert db.scalar(select(StripeEvent)) is None
    monkeypatch.setattr(billing, "_apply_event", original)
    assert client.post(billing.WEBHOOK_PATH, content=b"{}").status_code == 200


def test_customer_reference_mismatch_is_ignored(webhook):
    client, factory, event = webhook
    event["data"]["object"]["metadata"] = {"user_id": "another_user"}
    assert client.post(billing.WEBHOOK_PATH, content=b"{}").status_code == 200
    with factory() as db:
        assert db.get(User, "owner").plan == Plan.free


def test_missing_event_id_cannot_mutate_plan(webhook):
    client, factory, event = webhook
    del event["id"]
    assert client.post(billing.WEBHOOK_PATH, content=b"{}").status_code == 400
    with factory() as db:
        assert db.get(User, "owner").plan == Plan.free
