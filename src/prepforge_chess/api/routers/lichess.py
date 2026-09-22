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
from prepforge_chess.api.ratelimit import limiter
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


class LinkedAccountOut(BaseModel):
    id: str
    username: str
    is_primary: bool


class LinkStatus(BaseModel):
    linked: bool
    username: str | None = None
    accounts: list[LinkedAccountOut] = []


def _redirect_uri(request: Request) -> str:
    base = str(request.base_url).rstrip("/")
    return f"{base}/api/lichess/callback"


def _links_for(db: Session, user_id: str) -> list[LinkedAccount]:
    return list(
        db.scalars(
            select(LinkedAccount)
            .where(LinkedAccount.user_id == user_id, LinkedAccount.provider == PROVIDER)
            .order_by(LinkedAccount.created_at, LinkedAccount.id)
        )
    )


def _link_for(db: Session, user_id: str) -> LinkedAccount | None:
    links = _links_for(db, user_id)
    for link in links:
        if link.is_primary:
            return link
    return links[0] if links else None


def _accounts_out(links: list[LinkedAccount]) -> list[LinkedAccountOut]:
    return [
        LinkedAccountOut(
            id=link.id, username=link.provider_user_id, is_primary=bool(link.is_primary)
        )
        for link in links
    ]


def _demote_others(db: Session, user_id: str, keep_id: str) -> None:
    for link in _links_for(db, user_id):
        if link.id != keep_id and link.is_primary:
            link.is_primary = False


@router.get("", response_model=LinkStatus)
def status_(user: User = Depends(current_user), db: Session = Depends(get_db)) -> LinkStatus:
    links = _links_for(db, user.id)
    link = _link_for(db, user.id)
    if link is None:
        return LinkStatus(linked=False)
    return LinkStatus(
        linked=True, username=link.provider_user_id, accounts=_accounts_out(links)
    )


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


class SetPrimaryBody(BaseModel):
    account_id: str


@router.post("/primary")
def set_primary(
    body: SetPrimaryBody,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> LinkStatus:
    link = db.scalar(
        select(LinkedAccount).where(
            LinkedAccount.id == body.account_id,
            LinkedAccount.user_id == user.id,
            LinkedAccount.provider == PROVIDER,
        )
    )
    if link is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="unknown linked account")
    link.is_primary = True
    _demote_others(db, user.id, link.id)
    db.commit()
    links = _links_for(db, user.id)
    return LinkStatus(
        linked=True, username=link.provider_user_id, accounts=_accounts_out(links)
    )


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
    same_identity = db.scalar(
        select(LinkedAccount).where(
            LinkedAccount.user_id == user.id,
            LinkedAccount.provider == PROVIDER,
            LinkedAccount.provider_user_id == username,
        )
    )
    if same_identity is not None:
        same_identity.encrypted_token = encrypted
        same_identity.is_primary = True
        _demote_others(db, user.id, same_identity.id)
        db.commit()
    else:
        link = LinkedAccount(
            user_id=user.id,
            provider=PROVIDER,
            provider_user_id=username,
            encrypted_token=encrypted,
            is_primary=not _links_for(db, user.id),
        )
        db.add(link)
        db.flush()
        if link.is_primary:
            _demote_others(db, user.id, link.id)
        db.commit()

    response = RedirectResponse("/?lichess=linked", status_code=status.HTTP_303_SEE_OTHER)
    response.delete_cookie(_FLOW_COOKIE, path="/")
    return response


@router.delete("/{account_id}", status_code=status.HTTP_204_NO_CONTENT)
def unlink_one(
    account_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> Response:
    link = db.scalar(
        select(LinkedAccount).where(
            LinkedAccount.id == account_id,
            LinkedAccount.user_id == user.id,
            LinkedAccount.provider == PROVIDER,
        )
    )
    if link is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="unknown linked account")
    was_primary = bool(link.is_primary)
    db.delete(link)
    db.flush()
    if was_primary:
        remaining = _links_for(db, user.id)
        if remaining:
            remaining[0].is_primary = True
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete("", status_code=status.HTTP_204_NO_CONTENT)
def unlink(user: User = Depends(current_user), db: Session = Depends(get_db)) -> Response:
    link = _link_for(db, user.id)
    if link is not None:
        db.delete(link)
        db.flush()
        remaining = _links_for(db, user.id)
        if remaining and not any(r.is_primary for r in remaining):
            remaining[0].is_primary = True
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


def _link_for_account(db: Session, user_id: str, account_id: str | None) -> LinkedAccount | None:
    if account_id:
        link = db.scalar(
            select(LinkedAccount).where(
                LinkedAccount.id == account_id,
                LinkedAccount.user_id == user_id,
                LinkedAccount.provider == PROVIDER,
            )
        )
        if link is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="unknown linked account"
            )
        return link
    return _link_for(db, user_id)


def _linked_token(db: Session, user_id: str, account_id: str | None = None) -> str | None:
    link = _link_for_account(db, user_id, account_id)
    if link is None or not link.encrypted_token:
        return None
    try:
        return json.loads(decrypt_token(link.encrypted_token)).get("access_token")
    except Exception:  # noqa: BLE001 - an undecryptable token is just "not linked"
        return None


@router.get("/explorer/{db_name}")
@limiter.limit("120/minute")
def explorer_proxy(
    request: Request,
    db_name: str,
    fen: str,
    ratings: str | None = None,
    top_games: int = 0,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict:
    """Opening-explorer stats for one position (masters or the player pool).

    Query params beyond ``fen``/``ratings`` are pinned server-side, so this can't
    be used as a general-purpose proxy. The ratings list is validated against the
    explorer's own buckets."""
    if db_name not in _EXPLORER_DBS:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="unknown explorer database")
    if db_name == "masters":
        clamped = max(0, min(4, top_games))
        params: dict[str, str] = {"fen": fen, "moves": "12", "topGames": str(clamped)}
    else:
        params = {"fen": fen, "moves": "12"}
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


def _linked_username_or_400(
    db: Session, user_id: str, account_id: str | None = None
) -> str:
    link = _link_for_account(db, user_id, account_id)
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
    account_id: str | None = None,
    account_ids: list[str] | None = None,
) -> dict:
    """Fetch recent public games and match each against THIS owner's repertoires.

    ``account_id`` selects one identity explicitly. A list (or the default)
    aggregates "self": every linked identity gets a fair share of ``count``,
    results dedupe by game id, and each game carries ``source_account``."""
    count = max(1, min(_COMPARE_COUNT_MAX, count))
    if account_ids:
        links = []
        for aid in account_ids:
            links.append(_link_for_account(db, user.id, aid))
    elif account_id:
        links = [_link_for_account(db, user.id, account_id)]
    else:
        links = _links_for(db, user.id)
        primaries = [link for link in links if link.is_primary]
        links = primaries + [link for link in links if not link.is_primary]
    usernames = [link.provider_user_id for link in links if link.provider_user_id]
    if not usernames:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="link your Lichess account first",
        )
    try:
        if len(usernames) == 1:
            summaries = lichess_fetch.compare_recent_games(
                repo, usernames[0], count, owner_user_id=owner
            )
            pairs = [(s, usernames[0]) for s in summaries]
        else:
            pairs = lichess_fetch.compare_many_identities(
                repo, usernames, count, owner_user_id=owner
            )
    except lichess_fetch.LichessFetchError as exc:
        # Upstream Lichess failed -- this server proxied the fetch, so 502.
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc
    summaries = [s for s, _ in pairs]
    # Close the play→train loop: a game where the user left their own prep becomes a
    # recall miss on the forgotten node, so it surfaces in the next smart session.
    misses_recorded = lichess_fetch.record_departure_misses(
        repo, summaries, owner_user_id=owner
    )
    sources = sorted({source for _, source in pairs})
    return {
        "username": usernames[0] if len(usernames) == 1 else "self",
        "count": len(summaries),
        "misses_recorded": misses_recorded,
        "sources": sources,
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
                "expected_node_id": s.expected_node_id,
                "last_matched_node_id": s.last_matched_node_id,
                "training_recorded": s.training_recorded,
                "source_account": source,
            }
            for (s, source) in pairs
        ],
    }


@router.get("/compare")
def compare(
    count: int = 10,
    account_id: str | None = None,
    account_ids: str | None = None,
    user: User = Depends(current_user),
    owner: str = Depends(current_owner),
    db: Session = Depends(get_db),
    repo: PrepForgeRepository = Depends(get_repository),
) -> dict:
    ids = [a for a in (account_ids or "").split(",") if a] or None
    return _run_compare(count, user, owner, db, repo, account_id, ids)


class CompareBody(BaseModel):
    # The SPA still POSTs ``{username, count}`` (web-src/app.js). ``username`` is
    # ignored -- compare always runs against the caller's *linked* account, never a
    # client-supplied one (multi-tenant isolation); only ``count`` is honoured.
    # ``account_id`` selects one identity explicitly; ``account_ids`` selects
    # several; omitted means "self" (all linked identities aggregated).
    username: str | None = None
    count: int = 10
    account_id: str | None = None
    account_ids: list[str] | None = None


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
    return _run_compare(body.count, user, owner, db, repo, body.account_id, body.account_ids)


@router.get("/latest")
def latest(
    include_moves: bool = True,
    light: bool = False,
    account_id: str | None = None,
    user: User = Depends(current_user),
    owner: str = Depends(current_owner),
    db: Session = Depends(get_db),
    repo: PrepForgeRepository = Depends(get_repository),
) -> dict:
    """The newest game across the caller's linked Lichess identities.

    ``account_id`` selects one identity explicitly; the default aggregates ALL
    linked accounts ("self"): each identity's most recent game is fetched with
    bounded concurrency, duplicates are dropped by game id, and the truly
    newest by finish time wins. A quiet ``source_account`` names the identity
    the game came from so the UI can show it. Partial failures degrade: one
    account failing never blocks the others.
    """
    if light:
        include_moves = False
    if account_id:
        links = [_link_for_account(db, user.id, account_id)]
    else:
        # "Self": every linked identity, primary first.
        links = _links_for(db, user.id)
        primaries = [link for link in links if link.is_primary]
        others = [link for link in links if not link.is_primary]
        links = primaries + others
    if not links or not any(link.provider_user_id for link in links):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="link your Lichess account first",
        )
    try:
        if include_moves:
            game, source = lichess_fetch.newest_game_across(
                [link.provider_user_id for link in links],
                per_account=1,
                with_moves=True,
            )
        else:
            game, source = lichess_fetch.newest_game_across(
                [link.provider_user_id for link in links],
                per_account=1,
                with_moves=False,
            )
    except lichess_fetch.LichessFetchError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc
    if game is None:
        return {"has_game": False}
    last_seen = repo.get_profile_setting(owner, _LAST_SEEN_KEY)
    payload = {
        "has_game": True,
        "lichess_id": game.lichess_id,
        "white": game.white,
        "black": game.black,
        "result": game.result,
        "is_new": bool(game.lichess_id) and game.lichess_id != last_seen,
        "finished_at": game.finished_at,
        "source_account": source,
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
