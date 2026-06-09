"""Stripe billing: Checkout, customer portal, and the webhook that owns plan state.

Design
------
* **The webhook is the source of truth for ``users.plan``**, never the Checkout
  redirect — a user could close the tab before returning, and the redirect is not
  trustworthy. Stripe calls ``POST /api/stripe/webhook`` (signature-verified,
  CSRF-exempt) and *that* flips the plan.
* **Idempotent.** Stripe delivers at-least-once; each event id is recorded in
  ``stripe_events`` in the same transaction as its effect, so a redelivery is a
  no-op.
* **Guarded.** Every route 503s until ``STRIPE_SECRET_KEY`` is configured, so the
  feature is dark in environments without billing set up.
* The Stripe SDK is touched only through this module, and only via the public
  ``stripe.*`` surface, so tests monkeypatch ``stripe.checkout.Session.create`` etc.
"""
from __future__ import annotations

import stripe
from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from prepforge_chess.api.config import Settings, get_settings
from prepforge_chess.api.db import get_db
from prepforge_chess.api.deps import current_user
from prepforge_chess.api.models import Plan, StripeEvent, User

router = APIRouter(tags=["billing"])

# The Stripe webhook is machine-to-machine and authenticated by its signature, so
# it must bypass the double-submit CSRF check. main.create_app() reads this and
# passes it into CSRFMiddleware (no mutable module-level global — see middleware).
WEBHOOK_PATH = "/api/stripe/webhook"

# Subscription statuses that grant Pro. Anything else (canceled, unpaid, past_due,
# incomplete_expired) drops the user back to Free.
_ACTIVE_STATUSES = {"active", "trialing"}


def _stripe(settings: Settings) -> object:
    """Configure and return the Stripe SDK, or 503 if billing isn't set up."""
    if not settings.billing_enabled:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="billing not configured"
        )
    stripe.api_key = settings.stripe_secret_key
    return stripe


def _app_base_url(request: Request, settings: Settings) -> str:
    """Absolute base for Checkout success/cancel redirects: the first configured
    allowed origin (the real site), falling back to the request's own origin."""
    if settings.origins:
        return settings.origins[0].rstrip("/")
    return str(request.base_url).rstrip("/")


def _ensure_customer(sdk, db: Session, user: User) -> str:
    """Return the user's Stripe customer id, creating the customer on first need."""
    if user.stripe_customer_id:
        return user.stripe_customer_id
    customer = sdk.Customer.create(email=user.email, metadata={"user_id": user.id})
    customer_id = customer["id"] if isinstance(customer, dict) else customer.id
    user.stripe_customer_id = customer_id
    db.commit()
    return customer_id


@router.get("/api/billing/status")
def billing_status(
    user: User = Depends(current_user),
    settings: Settings = Depends(get_settings),
) -> dict[str, object]:
    """The caller's plan + whether billing is wired up (so the SPA can show/hide
    the upgrade button)."""
    return {
        "plan": user.plan.value,
        "billing_enabled": settings.billing_enabled,
        "price_configured": bool(settings.stripe_price_pro),
    }


@router.post("/api/billing/checkout")
def create_checkout(
    request: Request,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> dict[str, str]:
    """Start a Stripe Checkout for the Pro subscription; return the redirect URL."""
    sdk = _stripe(settings)
    if not settings.stripe_price_pro:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Pro price not configured"
        )
    if user.plan == Plan.pro:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="already on Pro")
    customer_id = _ensure_customer(sdk, db, user)
    base = _app_base_url(request, settings)
    session = sdk.checkout.Session.create(
        mode="subscription",
        customer=customer_id,
        line_items=[{"price": settings.stripe_price_pro, "quantity": 1}],
        client_reference_id=user.id,
        metadata={"user_id": user.id},
        success_url=f"{base}/?billing=success",
        cancel_url=f"{base}/?billing=cancelled",
    )
    url = session["url"] if isinstance(session, dict) else session.url
    return {"url": url}


@router.post("/api/billing/portal")
def create_portal(
    request: Request,
    user: User = Depends(current_user),
    settings: Settings = Depends(get_settings),
) -> dict[str, str]:
    """Open the Stripe customer portal (manage/cancel the subscription)."""
    sdk = _stripe(settings)
    if not user.stripe_customer_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="no billing account yet"
        )
    base = _app_base_url(request, settings)
    session = sdk.billing_portal.Session.create(
        customer=user.stripe_customer_id, return_url=f"{base}/",
    )
    url = session["url"] if isinstance(session, dict) else session.url
    return {"url": url}


def _set_plan_by_customer(db: Session, customer_id: str | None, plan: Plan) -> None:
    if not customer_id:
        return
    user = db.query(User).filter(User.stripe_customer_id == customer_id).one_or_none()
    if user is not None and user.plan != plan:
        user.plan = plan


def _apply_event(db: Session, event: dict) -> None:
    """Translate a Stripe event into a plan change. Unknown types are ignored."""
    etype = event.get("type", "")
    obj = event.get("data", {}).get("object", {})
    if etype == "checkout.session.completed":
        customer_id = obj.get("customer")
        user_id = obj.get("client_reference_id") or obj.get("metadata", {}).get("user_id")
        user = db.get(User, user_id) if user_id else None
        if user is not None:
            user.plan = Plan.pro
            if customer_id and not user.stripe_customer_id:
                user.stripe_customer_id = customer_id
        else:
            _set_plan_by_customer(db, customer_id, Plan.pro)
    elif etype == "customer.subscription.updated":
        plan = Plan.pro if obj.get("status") in _ACTIVE_STATUSES else Plan.free
        _set_plan_by_customer(db, obj.get("customer"), plan)
    elif etype == "customer.subscription.deleted":
        _set_plan_by_customer(db, obj.get("customer"), Plan.free)


@router.post(WEBHOOK_PATH)
async def stripe_webhook(
    request: Request,
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> dict[str, bool]:
    """Stripe → us. Signature-verified, idempotent; the authority on ``users.plan``."""
    if not settings.stripe_webhook_secret:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="webhook not configured"
        )
    payload = await request.body()
    sig = request.headers.get("Stripe-Signature", "")
    try:
        event = stripe.Webhook.construct_event(payload, sig, settings.stripe_webhook_secret)
    except ValueError as exc:  # malformed JSON body
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="invalid payload") from exc
    except stripe.error.SignatureVerificationError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="invalid signature"
        ) from exc

    # construct_event returns a stripe object; normalize to a plain dict.
    event = dict(event)
    event_id = event.get("id")
    if event_id and db.get(StripeEvent, event_id) is not None:
        return {"received": True}  # already processed — idempotent no-op

    _apply_event(db, event)
    if event_id:
        db.add(StripeEvent(id=event_id, type=event.get("type", "")))
    db.commit()
    return {"received": True}
