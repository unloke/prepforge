"""Lichess account linking.

Lichess is NOT a login here -- an authenticated (email) user links their Lichess
account so we can import their games. The OAuth2 PKCE flow reuses the existing
``services.lichess_oauth`` helpers; the resulting token is stored **encrypted at
rest** in ``linked_accounts`` (the legacy server kept it as plaintext JSON).

The short-lived PKCE state/verifier is carried across the redirect in an
encrypted, HttpOnly cookie (``pf_lichess_oauth``) rather than server-side state,
so the flow works across multiple workers without a shared store.
"""
from __future__ import annotations

import json
import time
import urllib.parse
from collections import OrderedDict

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from prepforge_chess.api.config import Settings, get_settings
from prepforge_chess.api.db import get_db
from prepforge_chess.api.deps import current_owner, current_user, get_repository
from prepforge_chess.api.models import LinkedAccount, User
from prepforge_chess.api.security import decrypt_token, encrypt_token
from prepforge_chess.services import lichess_fetch
from prepforge_chess.services.lichess_oauth import (
    LichessOAuthError,
    build_authorize_url,
    code_challenge_for,
    exchange_code,
    fetch_username,
    generate_code_verifier,
    generate_state,
)
from prepforge_chess.storage.repositories import PrepForgeRepository

# Per-owner key for the "you just finished a game" watcher's de-dup marker. Stored on
# the owner's profile blob (multi-tenant), reused from the legacy server's setting name.
_LAST_SEEN_KEY = "lichess.last_seen_game_id"

router = APIRouter(prefix="/api/lichess", tags=["lichess"])
# Legacy (unprefixed) routes the existing SPA still hits. Kept as thin compatibility
# shims so the FastAPI cutover doesn't 404/405 the SPA before web-src/app.js is updated
# to the new surface (see docs/ROADMAP.md "SPA cutover note").
legacy_router = APIRouter(tags=["lichess"])

PROVIDER = "lichess"
_FLOW_COOKIE = "pf_lichess_oauth"
# Frontend clamps the compare count to 1..50; mirror that server-side so the POST
# shim can't be coaxed into a huge fetch.
_COMPARE_COUNT_MAX = 50


class LinkStatus(BaseModel):
    linked: bool
    username: str | None = None


def _redirect_uri(request: Request) -> str:
    base = str(request.base_url).rstrip("/")
    return f"{base}/api/lichess/callback"


def _link_for(db: Session, user_id: str) -> LinkedAccount | None:
    return db.scalar(
        select(LinkedAccount).where(
            LinkedAccount.user_id == user_id, LinkedAccount.provider == PROVIDER
        )
    )


@router.get("", response_model=LinkStatus)
def status_(user: User = Depends(current_user), db: Session = Depends(get_db)) -> LinkStatus:
    link = _link_for(db, user.id)
    if link is None:
        return LinkStatus(linked=False)
    return LinkStatus(linked=True, username=link.provider_user_id)


@router.get("/status")
def status_legacy(
    user: User = Depends(current_user), db: Session = Depends(get_db)
) -> dict:
    """Legacy-shape status shim. The SPA's account chip / OAuth fallback poll / game
    watcher read ``{connected, username}`` (web-src/app.js); the new surface is
    ``GET /api/lichess`` -> ``{linked, username}``. Keep both until the SPA migrates."""
    link = _link_for(db, user.id)
    username = link.provider_user_id if link is not None else None
    return {"connected": bool(username), "username": username}


def _start_login_flow(request: Request, user: User, settings: Settings) -> Response:
    verifier = generate_code_verifier()
    state = generate_state()
    url = build_authorize_url(
        redirect_uri=_redirect_uri(request),
        state=state,
        code_challenge=code_challenge_for(verifier),
    )
    response = RedirectResponse(url, status_code=status.HTTP_307_TEMPORARY_REDIRECT)
    flow = encrypt_token(json.dumps({"state": state, "verifier": verifier, "uid": user.id}))
    response.set_cookie(
        key=_FLOW_COOKIE,
        value=flow,
        max_age=600,  # 10 min: the user has to approve on lichess.org
        httponly=True,
        secure=settings.is_production,
        samesite="lax",
        path="/",
    )
    return response


@router.get("/login")
def login(
    request: Request,
    user: User = Depends(current_user),
    settings: Settings = Depends(get_settings),
) -> Response:
    return _start_login_flow(request, user, settings)


@legacy_router.get("/oauth/login")
def oauth_login(
    request: Request,
    user: User = Depends(current_user),
    settings: Settings = Depends(get_settings),
) -> Response:
    """Legacy popup entrypoint. The SPA opens ``/oauth/login`` (web-src/app.js); the
    new route is ``/api/lichess/login``. Both mint the same PKCE flow whose
    ``redirect_uri`` is ``/api/lichess/callback``, so the callback handler is shared."""
    return _start_login_flow(request, user, settings)


@router.get("/callback")
def callback(
    request: Request,
    code: str = "",
    state: str = "",
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> Response:
    raw = request.cookies.get(_FLOW_COOKIE)
    if not raw:
        raise HTTPException(status_code=400, detail="missing or expired oauth flow")
    try:
        flow = json.loads(decrypt_token(raw))
    except Exception as exc:  # noqa: BLE001 - any tamper/expiry -> reject
        raise HTTPException(status_code=400, detail="invalid oauth flow") from exc

    # Bind the flow to this session: state must match and the flow must belong to
    # the logged-in user (it was minted for them).
    if not code or not state or state != flow.get("state") or flow.get("uid") != user.id:
        raise HTTPException(status_code=400, detail="oauth state mismatch")

    try:
        token = exchange_code(
            code=code, code_verifier=flow["verifier"], redirect_uri=_redirect_uri(request)
        )
        username = fetch_username(token["access_token"])
    except LichessOAuthError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc

    # Refuse to attach a Lichess identity already linked to a different user.
    existing = db.scalar(
        select(LinkedAccount).where(
            LinkedAccount.provider == PROVIDER, LinkedAccount.provider_user_id == username
        )
    )
    if existing is not None and existing.user_id != user.id:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="this Lichess account is already linked to another user",
        )

    encrypted = encrypt_token(json.dumps(token))
    link = _link_for(db, user.id)
    if link is None:
        link = LinkedAccount(user_id=user.id, provider=PROVIDER)
        db.add(link)
    link.provider_user_id = username
    link.encrypted_token = encrypted
    db.commit()

    response = RedirectResponse("/?lichess=linked", status_code=status.HTTP_303_SEE_OTHER)
    response.delete_cookie(_FLOW_COOKIE, path="/")
    return response


@router.delete("", status_code=status.HTTP_204_NO_CONTENT)
def unlink(user: User = Depends(current_user), db: Session = Depends(get_db)) -> Response:
    link = _link_for(db, user.id)
    if link is not None:
        db.delete(link)
        db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ---- Opening explorer proxy --------------------------------------------------
# explorer.lichess.ovh dropped anonymous access in early 2026 (DDoS mitigation), so
# the SPA can no longer call it directly. This thin proxy attaches the caller's own
# linked-account token server-side — the token never reaches the page — and memoises
# responses in-process. Opening stats are public, slow-moving data, so one user's
# lookup serves everyone (the first few plies cover most traffic), and the SPA keeps
# its own week-long cache + debounce + 429 cooldown on top (web-src/explorer.js).

_EXPLORER_DBS = ("masters", "lichess")
_EXPLORER_RATINGS = {"600", "1000", "1200", "1400", "1600", "1800", "2000", "2200", "2500"}
_EXPLORER_CACHE_TTL_SECONDS = 24 * 3600
_EXPLORER_CACHE_CAP = 500
_explorer_cache: OrderedDict[str, tuple[float, dict]] = OrderedDict()


def _linked_token(db: Session, user_id: str) -> str | None:
    link = _link_for(db, user_id)
    if link is None or not link.encrypted_token:
        return None
    try:
        return json.loads(decrypt_token(link.encrypted_token)).get("access_token")
    except Exception:  # noqa: BLE001 - an undecryptable token is just "not linked"
        return None


@router.get("/explorer/{db_name}")
def explorer_proxy(
    db_name: str,
    fen: str,
    ratings: str | None = None,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict:
    """Opening-explorer stats for one position (masters or the player pool).

    Query params beyond ``fen``/``ratings`` are pinned server-side, so this can't
    be used as a general-purpose proxy. The ratings list is validated against the
    explorer's own buckets."""
    if db_name not in _EXPLORER_DBS:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="unknown explorer database")
    params: dict[str, str] = {"fen": fen, "moves": "12", "topGames": "0"}
    if db_name == "lichess":
        params["variant"] = "standard"
        params["speeds"] = "blitz,rapid,classical"
        buckets = [r for r in (ratings or "").split(",") if r in _EXPLORER_RATINGS]
        params["ratings"] = ",".join(buckets) if buckets else "1600,1800"
        params["recentGames"] = "0"
    url = "{0}/{1}?{2}".format(
        lichess_fetch.EXPLORER_BASE_URL, db_name, urllib.parse.urlencode(params)
    )

    now = time.time()
    hit = _explorer_cache.get(url)
    if hit and now - hit[0] < _EXPLORER_CACHE_TTL_SECONDS:
        _explorer_cache.move_to_end(url)
        return hit[1]

    token = _linked_token(db, user.id)
    if not token:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="link your Lichess account to use the opening explorer",
        )
    try:
        data = lichess_fetch.fetch_explorer_json(url, token)
    except lichess_fetch.ExplorerRateLimitedError as exc:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Lichess explorer rate limit - try again shortly",
        ) from exc
    except lichess_fetch.LichessFetchError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc

    _explorer_cache[url] = (now, data)
    _explorer_cache.move_to_end(url)
    while len(_explorer_cache) > _EXPLORER_CACHE_CAP:
        _explorer_cache.popitem(last=False)
    return data


# ---- Game import / compare (Phase 2b-2d-iv) --------------------------------
# Lichess's public games API needs no token, only the username -- so compare/latest
# operate on the caller's *linked* username (``LinkedAccount.provider_user_id``), never
# an arbitrary client-supplied one. Comparison is owner-scoped (matches only against the
# caller's own repertoires) and the "you just finished a game" marker lives per-owner on
# the profile blob. These replace the legacy ``/api/lichess/{compare,latest,seen}``.


def _linked_username_or_400(db: Session, user_id: str) -> str:
    link = _link_for(db, user_id)
    if link is None or not link.provider_user_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="link your Lichess account first",
        )
    return link.provider_user_id


def _run_compare(
    count: int,
    user: User,
    owner: str,
    db: Session,
    repo: PrepForgeRepository,
) -> dict:
    """Fetch the linked account's recent public games and match each against THIS
    owner's repertoires (did my prep hold up / where did I leave book)."""
    username = _linked_username_or_400(db, user.id)
    count = max(1, min(_COMPARE_COUNT_MAX, count))
    try:
        summaries = lichess_fetch.compare_recent_games(
            repo, username, count, owner_user_id=owner
        )
    except lichess_fetch.LichessFetchError as exc:
        # Upstream Lichess failed -- this server proxied the fetch, so 502.
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc
    # Close the play→train loop: a game where the user left their own prep becomes a
    # recall miss on the forgotten node, so it surfaces in the next smart session.
    misses_recorded = lichess_fetch.record_departure_misses(
        repo, summaries, owner_user_id=owner
    )
    return {
        "username": username,
        "count": len(summaries),
        "misses_recorded": misses_recorded,
        "games": [
            {
                "lichess_id": s.lichess_id,
                "white": s.white,
                "black": s.black,
                "result": s.result,
                "user_color": s.user_color,
                "in_repertoire": s.in_repertoire,
                "matched_plies": s.matched_plies,
                "departure_ply": s.departure_ply,
                "departure_move_uci": s.departure_move_uci,
                "departure_reason": s.departure_reason,
                "repertoire_id": s.repertoire_id,
                "repertoire_name": s.repertoire_name,
                "move_san_history": s.move_san_history,
                "expected_move_uci": s.expected_move_uci,
                "expected_move_san": s.expected_move_san,
                "training_recorded": s.training_recorded,
            }
            for s in summaries
        ],
    }


@router.get("/compare")
def compare(
    count: int = 10,
    user: User = Depends(current_user),
    owner: str = Depends(current_owner),
    db: Session = Depends(get_db),
    repo: PrepForgeRepository = Depends(get_repository),
) -> dict:
    return _run_compare(count, user, owner, db, repo)


class CompareBody(BaseModel):
    # The SPA still POSTs ``{username, count}`` (web-src/app.js). ``username`` is
    # ignored -- compare always runs against the caller's *linked* account, never a
    # client-supplied one (multi-tenant isolation); only ``count`` is honoured.
    username: str | None = None
    count: int = 10


@router.post("/compare")
def compare_post(
    body: CompareBody,
    user: User = Depends(current_user),
    owner: str = Depends(current_owner),
    db: Session = Depends(get_db),
    repo: PrepForgeRepository = Depends(get_repository),
) -> dict:
    """Legacy POST shim: the old single-tenant server dispatched compare on POST with a
    client-supplied username (server.py). Here the username is dropped on purpose; the
    fetch is owner-scoped to the linked account."""
    return _run_compare(body.count, user, owner, db, repo)


@router.get("/latest")
def latest(
    include_moves: bool = True,
    light: bool = False,
    user: User = Depends(current_user),
    owner: str = Depends(current_owner),
    db: Session = Depends(get_db),
    repo: PrepForgeRepository = Depends(get_repository),
) -> dict:
    """The linked account's most recent game, flagged ``is_new`` against the per-owner
    last-seen marker. ``include_moves`` returns the full PGN (for feeding into Analyze);
    the lightweight form returns NDJSON metadata only (the finish-time watcher probe).

    Legacy compat: the SPA's watcher hits ``?light=1`` (web-src/app.js), which the old
    server mapped to ``include_moves=False`` (the metadata-only path that carries the
    true finish time). ``light`` wins when set, so the recency gate keeps working."""
    if light:
        include_moves = False
    username = _linked_username_or_400(db, user.id)
    try:
        if include_moves:
            games = lichess_fetch.fetch_recent_pgns(username, 1, include_moves=True)
        else:
            games = lichess_fetch.fetch_latest_games_meta(username, 1)
    except lichess_fetch.LichessFetchError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc
    if not games:
        return {"has_game": False}
    game = games[0]
    last_seen = repo.get_profile_setting(owner, _LAST_SEEN_KEY)
    payload = {
        "has_game": True,
        "lichess_id": game.lichess_id,
        "white": game.white,
        "black": game.black,
        "result": game.result,
        "is_new": bool(game.lichess_id) and game.lichess_id != last_seen,
        "finished_at": game.finished_at,
    }
    if include_moves:
        payload["pgn"] = game.pgn
    return payload


class MarkSeenBody(BaseModel):
    lichess_id: str | None = None


@router.post("/seen")
def mark_seen(
    body: MarkSeenBody,
    owner: str = Depends(current_owner),
    repo: PrepForgeRepository = Depends(get_repository),
) -> dict:
    """Record the latest game this owner has acknowledged, so the watcher stops
    re-surfacing it as new."""
    if body.lichess_id:
        repo.set_profile_setting(owner, _LAST_SEEN_KEY, body.lichess_id)
    return {"ok": True}
