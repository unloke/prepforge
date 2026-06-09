"""Phase 4: Stripe billing — Checkout, customer portal, webhook, and Free quota.

The Stripe SDK is never hit over the network here: every ``stripe.*`` call the
router makes is monkeypatched. These tests prove the *contract* — billing is dark
until configured, Checkout/portal produce a redirect URL and create the customer,
the webhook is signature-verified + idempotent and is the authority on
``users.plan``, and the Free-plan repertoire quota gates with 402.
"""
from __future__ import annotations

import stripe
from fastapi.testclient import TestClient

from api_helpers import csrf_headers


def _register(client: TestClient, email: str = "a@example.com") -> str:
    r = client.post(
        "/api/auth/register",
        json={"email": email, "password": "longpassword1"},
        headers=csrf_headers(client),
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _enable_billing(monkeypatch, *, with_webhook: bool = True, price: str = "price_pro_123",
                    free_limit: int | None = None) -> None:
    """Turn billing on by setting the Stripe env + clearing the settings cache."""
    monkeypatch.setenv("PREPFORGE_STRIPE_SECRET_KEY", "sk_test_xxx")
    monkeypatch.setenv("PREPFORGE_STRIPE_PRICE_PRO", price)
    if with_webhook:
        monkeypatch.setenv("PREPFORGE_STRIPE_WEBHOOK_SECRET", "whsec_test")
    if free_limit is not None:
        monkeypatch.setenv("PREPFORGE_FREE_REPERTOIRE_LIMIT", str(free_limit))
    from prepforge_chess.api import config

    config.get_settings.cache_clear()


# ---- status / gating -------------------------------------------------------


def test_status_requires_auth(client):
    assert client.get("/api/billing/status").status_code == 401


def test_status_reports_free_and_disabled(client):
    _register(client)
    body = client.get("/api/billing/status").json()
    assert body == {"plan": "free", "billing_enabled": False, "price_configured": False}


def test_checkout_503_when_billing_unconfigured(client):
    _register(client)
    r = client.post("/api/billing/checkout", headers=csrf_headers(client))
    assert r.status_code == 503


def test_checkout_requires_csrf(client, monkeypatch):
    _register(client)
    _enable_billing(monkeypatch)
    assert client.post("/api/billing/checkout").status_code == 403


# ---- checkout --------------------------------------------------------------


def test_checkout_creates_customer_and_returns_url(client, monkeypatch):
    _register(client)
    _enable_billing(monkeypatch)
    created = {}

    def fake_customer_create(**kwargs):
        created["email"] = kwargs.get("email")
        return {"id": "cus_abc"}

    def fake_session_create(**kwargs):
        created["customer"] = kwargs.get("customer")
        created["client_reference_id"] = kwargs.get("client_reference_id")
        return {"url": "https://checkout.stripe.test/sess_1"}

    monkeypatch.setattr(stripe.Customer, "create", fake_customer_create)
    monkeypatch.setattr(stripe.checkout.Session, "create", fake_session_create)

    r = client.post("/api/billing/checkout", headers=csrf_headers(client))
    assert r.status_code == 200, r.text
    assert r.json()["url"] == "https://checkout.stripe.test/sess_1"
    # The customer was created once and threaded into the Checkout session.
    assert created["customer"] == "cus_abc"


def test_checkout_409_when_already_pro(client, monkeypatch):
    user_id = _register(client)
    _enable_billing(monkeypatch)
    _flip_to_pro_via_webhook(client, monkeypatch, user_id, customer_id="cus_x")
    r = client.post("/api/billing/checkout", headers=csrf_headers(client))
    assert r.status_code == 409


# ---- portal ----------------------------------------------------------------


def test_portal_400_without_customer(client, monkeypatch):
    _register(client)
    _enable_billing(monkeypatch)
    r = client.post("/api/billing/portal", headers=csrf_headers(client))
    assert r.status_code == 400


def test_portal_returns_url_after_customer_exists(client, monkeypatch):
    _register(client)
    _enable_billing(monkeypatch)
    monkeypatch.setattr(stripe.Customer, "create", lambda **k: {"id": "cus_p"})
    monkeypatch.setattr(stripe.checkout.Session, "create", lambda **k: {"url": "u"})
    client.post("/api/billing/checkout", headers=csrf_headers(client))  # creates the customer

    monkeypatch.setattr(
        stripe.billing_portal.Session, "create",
        lambda **k: {"url": "https://portal.stripe.test/p_1"},
    )
    r = client.post("/api/billing/portal", headers=csrf_headers(client))
    assert r.status_code == 200, r.text
    assert r.json()["url"] == "https://portal.stripe.test/p_1"


# ---- webhook ---------------------------------------------------------------


def _flip_to_pro_via_webhook(client, monkeypatch, user_id, customer_id="cus_abc"):
    event = {
        "id": "evt_pro_{0}".format(user_id),
        "type": "checkout.session.completed",
        "data": {"object": {"customer": customer_id, "client_reference_id": user_id}},
    }
    monkeypatch.setattr(stripe.Webhook, "construct_event", lambda *a, **k: dict(event))
    r = client.post("/api/stripe/webhook", content=b"{}",
                    headers={"Stripe-Signature": "t=1,v1=sig"})
    assert r.status_code == 200, r.text
    return event


def test_webhook_503_without_secret(client, monkeypatch):
    _enable_billing(monkeypatch, with_webhook=False)
    r = client.post("/api/stripe/webhook", content=b"{}")
    assert r.status_code == 503


def test_webhook_is_csrf_exempt_but_400_on_bad_signature(client, monkeypatch):
    _enable_billing(monkeypatch)

    def boom(*a, **k):
        raise stripe.error.SignatureVerificationError("bad", "sig")

    monkeypatch.setattr(stripe.Webhook, "construct_event", boom)
    # No X-CSRF-Token header at all — proves the path is CSRF-exempt (else 403),
    # and the bad signature yields 400 rather than passing through.
    r = client.post("/api/stripe/webhook", content=b"{}",
                    headers={"Stripe-Signature": "bogus"})
    assert r.status_code == 400


def test_webhook_checkout_completed_flips_plan_to_pro(client, monkeypatch):
    user_id = _register(client)
    _enable_billing(monkeypatch)
    _flip_to_pro_via_webhook(client, monkeypatch, user_id)
    assert client.get("/api/billing/status").json()["plan"] == "pro"


def test_webhook_is_idempotent(client, monkeypatch):
    user_id = _register(client)
    _enable_billing(monkeypatch)
    event = {
        "id": "evt_same",
        "type": "checkout.session.completed",
        "data": {"object": {"customer": "cus_1", "client_reference_id": user_id}},
    }
    monkeypatch.setattr(stripe.Webhook, "construct_event", lambda *a, **k: dict(event))
    for _ in range(3):
        r = client.post("/api/stripe/webhook", content=b"{}",
                        headers={"Stripe-Signature": "s"})
        assert r.status_code == 200
    # Still Pro, and no error from re-inserting the same event id.
    assert client.get("/api/billing/status").json()["plan"] == "pro"


def test_webhook_subscription_deleted_downgrades_to_free(client, monkeypatch):
    user_id = _register(client)
    _enable_billing(monkeypatch)
    _flip_to_pro_via_webhook(client, monkeypatch, user_id, customer_id="cus_d")
    assert client.get("/api/billing/status").json()["plan"] == "pro"

    deleted = {
        "id": "evt_del",
        "type": "customer.subscription.deleted",
        "data": {"object": {"customer": "cus_d"}},
    }
    monkeypatch.setattr(stripe.Webhook, "construct_event", lambda *a, **k: dict(deleted))
    client.post("/api/stripe/webhook", content=b"{}", headers={"Stripe-Signature": "s"})
    assert client.get("/api/billing/status").json()["plan"] == "free"


# ---- Free-plan quota -------------------------------------------------------


def _create_rep(client, name):
    return client.post(
        "/api/repertoires/create",
        json={"name": name, "color": "white"},
        headers=csrf_headers(client),
    )


def test_free_plan_repertoire_quota_blocks_with_402(client, monkeypatch):
    _register(client)
    _enable_billing(monkeypatch, free_limit=2)
    assert _create_rep(client, "one").status_code == 200
    assert _create_rep(client, "two").status_code == 200
    r = _create_rep(client, "three")
    assert r.status_code == 402
    assert "Upgrade to Pro" in r.json()["detail"]


def test_pro_plan_bypasses_repertoire_quota(client, monkeypatch):
    user_id = _register(client)
    _enable_billing(monkeypatch, free_limit=1)
    assert _create_rep(client, "one").status_code == 200
    assert _create_rep(client, "two").status_code == 402
    _flip_to_pro_via_webhook(client, monkeypatch, user_id, customer_id="cus_q")
    # Now unlimited.
    assert _create_rep(client, "three").status_code == 200
    assert _create_rep(client, "four").status_code == 200
