"""Workspace endpoints: owner-scoped data reads and repertoire mutations."""
from __future__ import annotations

import hashlib
import json

import base64
import hmac
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Literal, TypeVar

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from prepforge_chess.core.limits import (
    MAX_REPERTOIRE_PACKAGE_CHARS,
    MAX_ANNOTATIONS_PER_KIND,
    MAX_ADD_MOVES_BATCH,
    MAX_DELETE_NODES_BATCH,
    PGN_LIMITS,
)
from prepforge_chess.api.config import Settings, get_settings
from prepforge_chess.api.db import get_db
from prepforge_chess.api.deps import current_owner, current_user, get_repository
from prepforge_chess.api.models import LinkedAccount, User
from prepforge_chess.storage.types import Plan
from prepforge_chess.api.ratelimit import limiter
from prepforge_chess.api.routers.teams import user_team_ids
from prepforge_chess.storage.repositories.repertoires import ROLE_RANK
from prepforge_chess.core.models import Color, MoveSource, OpeningNode
from prepforge_chess.services.opening_builder import (
    CreateRepertoireRequest,
    OpeningBuilderService,
)
from prepforge_chess.services import streak
from prepforge_chess.services.repertoire_export import RepertoireExportService
from prepforge_chess.services.workspace_view import build_workspace_payload
from prepforge_chess.storage import sa_tables as t
from prepforge_chess.storage.repositories.settings import PLAYED_SESSIONS_KEY, REVIEW_ARCHIVE_KEY, prune_review_archive
from prepforge_chess.storage.repositories.repertoires import NodeGone, RevisionConflict
from prepforge_chess.storage.repositories.workspace import WorkspaceRepository

router = APIRouter(prefix="/api", tags=["workspace"])
T = TypeVar("T")



def _repertoire_cap(user: User, settings: Settings) -> int | None:
    """The Free-plan cap every repertoire-producing route passes to the save,
    which enforces it in the write transaction (402 via the app handler)."""
    return None if user.plan == Plan.pro else settings.free_repertoire_limit


def _repertoire_access(
    repo: WorkspaceRepository, repertoire_id: str, user_id: str, need: str = "view"
) -> dict[str, Any]:
    """The one access gate. Returns the repertoire's meta with the caller's
    ``role`` (owner / edit / copy / view). 404 when the caller has no access at
    all (never revealing the repertoire), 403 when their role is below ``need``."""
    meta, role = repo.access_role(repertoire_id, user_id)
    if role is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="repertoire not found")
    if ROLE_RANK[role] < ROLE_RANK[need]:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=_DENIED[need])
    return {**meta, "role": role}


_DENIED = {
    "copy": "The owner hasn't allowed copies of this repertoire.",
    "edit": "You can't edit this repertoire.",
    "owner": "Only the owner can do this.",
}


def _owned_repertoire(repo: WorkspaceRepository, repertoire_id: str, owner: str) -> dict[str, Any]:
    """Owner-only actions: rename, delete, enable/disable, sharing, and Train.
    Tags the writes this request makes with their author for the op log."""
    meta = _repertoire_access(repo, repertoire_id, owner, "owner")
    repo.op_actor = owner
    return meta


def _editable_repertoire(
    repo: WorkspaceRepository, repertoire_id: str, user_id: str, kind: str
) -> dict[str, Any]:
    """Edit gate for tree mutations: the owner or an ``edit`` grant (404 without
    access, 403 below edit). Tags the writes this request makes with their author
    and kind for the ``repertoire_ops`` log."""
    meta = _repertoire_access(repo, repertoire_id, user_id, "edit")
    repo.op_actor = user_id
    repo.op_kind = kind
    return meta


_REBASE_ATTEMPTS = 3


def _rebased(repo: WorkspaceRepository, meta: dict[str, Any], apply: Callable[[], T]) -> T:
    """Server-side rebase: an edit runs against the repertoire as it is now, not
    the revision the client last saw, so concurrent edits that do not touch the
    same node all land. The edit's own preconditions decide (a deleted node is
    ``NodeGone`` → 409). A write committing between this request's read and its
    commit trips the revision fence; the edit then re-runs on the newer tree."""
    revision = meta["revision"]
    for attempt in range(_REBASE_ATTEMPTS):
        repo.expect_repertoire_revision(meta["id"], revision)
        try:
            return apply()
        except RevisionConflict as conflict:
            if attempt == _REBASE_ATTEMPTS - 1:
                raise
            revision = conflict.current_revision


def _strip_readonly_build_payload(payload: dict[str, Any]) -> None:
    """Remove the owner's personal training colour from a payload someone else sees.

    Share links and grants must not leak health or per-node mastery derived from
    the owner's training progress."""
    payload.pop("health", None)
    for node in payload.get("nodes", []):
        node.pop("mastery", None)


def _payload(repo: WorkspaceRepository, meta: dict[str, Any], **kwargs: Any) -> dict[str, Any]:
    """The Build payload as the caller may see it. Always computed against the
    owner's progress (so the cached health badge stays the owner's), then stripped
    of that progress for anyone else. ``role``/``writable`` drive the client."""
    payload = build_workspace_payload(repo, meta["id"], owner_user_id=meta["owner_user_id"], **kwargs)
    payload["role"] = meta["role"]
    payload["writable"] = ROLE_RANK[meta["role"]] >= ROLE_RANK["edit"]
    if meta["role"] != "owner":
        _strip_readonly_build_payload(payload)
        payload["shared"] = True
    return payload


@router.get("/dashboard")
def dashboard(
    local_date: str | None = None,
    owner: str = Depends(current_owner),
    repo: WorkspaceRepository = Depends(get_repository),
) -> dict[str, Any]:
    """Owner-scoped counters for the home screen. Training counters reach the owner
    through repertoire ownership (``training_sessions`` has no owner column).
    ``local_date`` is the client's calendar day, used only to phrase the daily
    streak (is it alive? trained today?) in the player's timezone."""
    now = datetime.now(timezone.utc)
    reps = t.repertoires
    with repo.engine.connect() as conn:
        games = conn.execute(
            select(func.count())
            .select_from(t.games)
            .where(t.games.c.owner_user_id == owner)
        ).scalar_one()
        repertoires = conn.execute(
            select(func.count()).select_from(reps).where(reps.c.owner_user_id == owner)
        ).scalar_one()
        active_ids = set(conn.scalars(select(reps.c.id).where(
            reps.c.owner_user_id == owner, reps.c.is_active == 1,
        )))
        sessions = conn.execute(
            select(func.count())
            .select_from(t.training_sessions.join(reps, reps.c.id == t.training_sessions.c.repertoire_id))
            .where(reps.c.owner_user_id == owner)
        ).scalar_one()
        tp = t.training_progress
        # Moves reviewed in the last 7 days: one progress row per move, so a
        # move reviewed five times counts once.
        reviews_7d = conn.execute(
            select(func.count())
            .select_from(tp.join(reps, reps.c.id == tp.c.repertoire_id))
            .where(
                reps.c.owner_user_id == owner,
                tp.c.owner_user_id == owner,
                tp.c.last_reviewed_at >= now - timedelta(days=7),
            )
        ).scalar_one()
    week_ago_iso = (now - timedelta(days=7)).isoformat()
    # Today and the recap describe what the Smart queue can schedule now: the
    # Library's buckets (effective-enabled own moves, weak before due before
    # mastered) over active repertoires.
    counts = repo.due_windows_by_repertoire(owner, now=now, until=now + timedelta(hours=24))
    def total(bucket: str) -> int:
        return sum(counts.get(rid, {}).get(bucket, 0) for rid in active_ids)
    due_reviews = total("due")
    due_soon = total("due_until") - due_reviews
    mastered_now = total("mastered")
    weak_now = total("weak")
    replaced = repo.get_user_setting(owner, PLAYED_SESSIONS_KEY)
    if isinstance(replaced, int) and replaced > 0:
        sessions += replaced
    # Reviews of moves deleted since then still count toward the week.
    archived = repo.get_user_setting(owner, REVIEW_ARCHIVE_KEY)
    if isinstance(archived, list):
        reviews_7d += len(prune_review_archive(archived, week_ago_iso))
    local_day = streak.resolve_day(local_date)
    return {
        "games": games,
        "repertoires": repertoires,
        "training_sessions": sessions,
        "due_reviews": due_reviews,
        "due_soon": due_soon,
        "streak": streak.as_view(
            repo.get_user_setting(owner, streak.STREAK_KEY),
            local_day,
        ),
        "recap": _weekly_recap(
            repo, owner, local_day,
            reviews_7d=reviews_7d, mastered_now=mastered_now, weak_now=weak_now,
        ),
    }


# Per-owner mastery snapshot taken at the start of each (player-local) week, so the
# recap can phrase progress as a delta ("5 mastered, +2 this week") without a history
# table. Lives in user_settings; refreshing it is an idempotent once-a-week write.
_RECAP_SNAPSHOT_KEY = "recap.weekly_snapshot"


def _weekly_recap(
    repo: WorkspaceRepository,
    owner: str,
    local_day,
    *,
    reviews_7d: int,
    mastered_now: int,
    weak_now: int,
) -> dict[str, Any]:
    week_start = (local_day - timedelta(days=local_day.weekday())).isoformat()

    # Read first: while this week's baseline already exists, the dashboard GET
    # stays a pure read (mutate_user_setting takes a row lock even when the
    # mutator returns the value unchanged). The atomic mutation is reserved for
    # the actual roll — first visit of a new week — where it still can't clobber
    # a streak advance racing on the same settings blob (lost update).
    snap = repo.get_user_setting(owner, _RECAP_SNAPSHOT_KEY)
    if not (isinstance(snap, dict) and snap.get("week_start") == week_start):

        def _roll(current: Any) -> dict[str, Any]:
            # Keep this week's existing baseline; only (re)seed on a new week.
            if isinstance(current, dict) and current.get("week_start") == week_start:
                return current
            return {"week_start": week_start, "mastered": mastered_now, "weak": weak_now}

        snap = repo.mutate_user_setting(owner, _RECAP_SNAPSHOT_KEY, _roll)

    def _baseline(key: str, current: int) -> int:
        try:
            return int(snap.get(key, current))
        except (TypeError, ValueError):
            return current

    return {
        "week_start": week_start,
        "moves_reviewed_7d": reviews_7d,
        "mastered_now": mastered_now,
        "mastered_delta": mastered_now - _baseline("mastered", mastered_now),
        "weak_now": weak_now,
        "weak_delta": weak_now - _baseline("weak", weak_now),
    }


_LISTING_HEALTH_FIELDS = ("trainable", "untrained", "weak", "due", "mastered", "mastery_pct", "computed_at")


def _listing_health(health: dict[str, Any] | None) -> dict[str, Any] | None:
    """The cached badge reduced to what a Library row draws, plus its provenance.

    ``computed_at`` says how fresh the cached counts are (the ``due`` count is
    recomputed live, so the two can differ). ``revision``, ``learning`` and
    ``shallow_lines`` are drawn nowhere.
    """
    if health is None:
        return None
    return {key: health[key] for key in _LISTING_HEALTH_FIELDS if key in health}


@router.get("/repertoires")
def list_repertoires(
    owner: str = Depends(current_owner),
    repo: WorkspaceRepository = Depends(get_repository),
) -> dict[str, Any]:
    """The caller's own repertoires (metadata + a cached ``health`` badge — no tree
    load and no per-row health walk; the badge is refreshed off the Build payload and
    train summary, and is ``None`` until a rep is first opened/trained), plus a
    lightweight ``shared`` list of repertoires others shared with the caller, each
    at the caller's role (no health/tree load to keep this cheap)."""
    return {
        "repertoires": [
            {
                "id": row["id"],
                "name": row["name"],
                "color": row["color"],
                # Cached coverage badge (None until first opened/trained); not recomputed here.
                # Only the counts the rows draw (trainable / untrained / weak / due /
                # mastered / mastery_pct): this listing is fetched several times per
                # boot, so its cache bookkeeping (computed_at, revision) stays here.
                "health": _listing_health(row["health"]),
                "is_active": row["is_active"],
                "shared": row["shared"],
            }
            for row in repo.list_owner_repertoire_listings(owner_user_id=owner)
        ],
        "shared": [
            {key: item[key] for key in ("id", "name", "color", "role", "team_id", "owner_display_name")}
            for item in repo.list_shared_with(owner)
        ],
    }


@router.get("/build/load")
def build_load(
    repertoire_id: str,
    owner: str = Depends(current_owner),
    repo: WorkspaceRepository = Depends(get_repository),
) -> dict[str, Any]:
    """The Build-view payload for a repertoire the caller can read, with their
    ``role``; ``writable`` for the owner and editors. Computes no chess — pure
    serialization of the stored tree + training progress."""
    return _payload(repo, _repertoire_access(repo, repertoire_id, owner))


@router.get("/build/changes")
def build_changes(
    repertoire_id: str,
    since: int = Query(ge=0),
    owner: str = Depends(current_owner),
    repo: WorkspaceRepository = Depends(get_repository),
) -> dict[str, Any]:
    """What changed in a readable repertoire after revision ``since``: the current
    state of every node written since then, the ids deleted since then, the name,
    and one entry per write (kind, author, client) so the viewer can say what
    happened. Polled by every open Build view; an unchanged repertoire costs one
    indexed read. ``reset`` means the log no longer reaches back to ``since``
    (or the tree was replaced): reload it with ``/build/load``. Anyone but the
    owner gets no training colour (health/mastery), as in ``_payload``."""
    meta = _repertoire_access(repo, repertoire_id, owner)
    revision = meta["revision"]
    if since >= revision:
        return {"revision": revision}
    ops = repo.repertoire_ops_since(repertoire_id, since)
    if not ops or ops[0]["revision"] != since + 1 or any(op.get("reset") for op in ops):
        return {"revision": revision, "reset": True}
    view = _payload(repo, meta)
    removed = {node_id for op in ops for node_id in op.get("removed", ())}
    written = {node_id for op in ops for node_id in op.get("nodes", ())} - removed
    nodes = [node for node in view["nodes"] if node["id"] in written]
    # A written node that is gone now went with a deleted ancestor.
    removed |= written - {node["id"] for node in nodes}
    return {
        # The tree was read after these ops, so it holds at least all of them.
        "revision": ops[-1]["revision"],
        "name": view["name"],
        "nodes_total": view["nodes_total"],
        "health": view.get("health"),
        "nodes": nodes,
        "removed": sorted(removed),
        "ops": [
            {key: op[key] for key in ("revision", "kind", "actor_user_id", "client_id")}
            for op in ops
        ],
    }


# ---- Access: who a repertoire is shared with, and how -----------------------
# Owner-only. A grant names one team (the owner must be in it) or one person
# (found by email or Lichess username) with a role: view, copy or edit.

Role = Literal["view", "copy", "edit"]


def _access_state(repo: WorkspaceRepository, meta: dict[str, Any], secret: str) -> dict[str, Any]:
    link = _share_state(meta)
    if link["share_enabled"]:
        link["url"] = "/?shared={0}".format(mint_share_token(meta["id"], secret, link["share_rev"]))
    return {"repertoire_id": meta["id"], "link": link, "grants": repo.repertoire_grants(meta["id"])}


@router.get("/repertoires/access")
def repertoire_access(
    repertoire_id: str,
    owner: str = Depends(current_owner),
    repo: WorkspaceRepository = Depends(get_repository),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """The Share dialog's state: the link (with its URL while on) and every grant."""
    meta = _owned_repertoire(repo, repertoire_id, owner)
    return _access_state(repo, meta, settings.secret_key)


class GrantBody(BaseModel):
    repertoire_id: str
    role: Role = "view"
    team_id: str | None = None
    user_id: str | None = None
    # A person to add: their email or Lichess username.
    person: str | None = Field(default=None, max_length=320)


def _find_person(db: Session, person: str) -> User | None:
    handle = person.strip()
    if "@" in handle:
        return db.scalar(select(User).where(func.lower(User.email) == handle.lower()))
    link = db.scalar(select(LinkedAccount).where(
        LinkedAccount.provider == "lichess",
        func.lower(LinkedAccount.provider_user_id) == handle.lower(),
    ))
    return db.get(User, link.user_id) if link is not None else None


@router.post("/repertoires/access")
@limiter.limit("30/minute")
def grant_access(
    request: Request,
    body: GrantBody,
    user: User = Depends(current_user),
    owner: str = Depends(current_owner),
    repo: WorkspaceRepository = Depends(get_repository),
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Share with a team or a person at a role, or change an existing grant's role."""
    meta = _owned_repertoire(repo, body.repertoire_id, owner)
    if sum(bool(v) for v in (body.team_id, body.user_id, body.person and body.person.strip())) != 1:
        raise HTTPException(status_code=400, detail="name one team or one person")
    if body.team_id:
        if body.team_id not in user_team_ids(db, user.id):
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="team not found")
        repo.set_grant(body.repertoire_id, team_id=body.team_id, role=body.role, created_by=owner)
    elif body.user_id:  # a role change for someone already on the list
        if not any(g.get("user_id") == body.user_id for g in repo.repertoire_grants(body.repertoire_id)):
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not shared with this person")
        repo.set_grant(body.repertoire_id, user_id=body.user_id, role=body.role, created_by=owner)
    else:
        target = _find_person(db, body.person)
        if target is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="No PrepForge account has that email or Lichess username.",
            )
        if target.id == owner:
            raise HTTPException(status_code=400, detail="This repertoire is already yours.")
        repo.set_grant(body.repertoire_id, user_id=target.id, role=body.role, created_by=owner)
    return _access_state(repo, meta, settings.secret_key)


class RevokeBody(BaseModel):
    repertoire_id: str
    team_id: str | None = None
    user_id: str | None = None


@router.post("/repertoires/access/revoke")
def revoke_access(
    body: RevokeBody,
    owner: str = Depends(current_owner),
    repo: WorkspaceRepository = Depends(get_repository),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Stop sharing with one team or person. Their access ends with their next request."""
    meta = _owned_repertoire(repo, body.repertoire_id, owner)
    if bool(body.team_id) == bool(body.user_id):
        raise HTTPException(status_code=400, detail="name one team or one person")
    repo.delete_grant(body.repertoire_id, team_id=body.team_id, user_id=body.user_id)
    return _access_state(repo, meta, settings.secret_key)


class DeleteRepertoireRequest(BaseModel):
    repertoire_id: str


@router.post("/repertoires/delete")
def delete_repertoire(
    body: DeleteRepertoireRequest,
    owner: str = Depends(current_owner),
    repo: WorkspaceRepository = Depends(get_repository),
) -> dict[str, Any]:
    """Delete one of this owner's repertoires (cascades to its nodes/training)."""
    _owned_repertoire(repo, body.repertoire_id, owner)
    repo.delete_repertoire(body.repertoire_id)
    return {"deleted": body.repertoire_id}


class SetActiveRequest(BaseModel):
    repertoire_id: str
    active: bool = True


@router.post("/repertoires/set-active")
def set_repertoire_active(
    body: SetActiveRequest,
    owner: str = Depends(current_owner),
    repo: WorkspaceRepository = Depends(get_repository),
) -> dict[str, Any]:
    """Toggle a repertoire's active flag (drives trainer eligibility in the SPA)."""
    meta = _owned_repertoire(repo, body.repertoire_id, owner)
    repo.op_kind = "set_active"
    repo.set_repertoire_active(body.repertoire_id, body.active)
    return {"id": body.repertoire_id, "name": meta["name"], "is_active": body.active}


# ---- Build write path (2b-2c) ----------------------------------------------
# create / rename / add-move are pure data mutations on the stored tree — they
# never read the Maia model, so they run on the (now Maia-free) builder and return
# the shared Build payload. Ownership: create *claims* a freshly-made repertoire for
# the caller; rename/add-move pass through the `_owned_repertoire` IDOR gate first.


def _find_node(root: OpeningNode, node_id: str) -> OpeningNode | None:
    if root.id == node_id:
        return root
    for child in root.children:
        found = _find_node(child, node_id)
        if found is not None:
            return found
    return None


def _walk_nodes(root: OpeningNode):
    yield root
    for child in root.children:
        yield from _walk_nodes(child)


def _reassign_ids(repertoire) -> None:
    """Mint fresh ids for an imported repertoire and all its nodes (in place).

    A package carries the *original* repertoire/node ids. Without re-iding, a second
    user importing the same package would upsert onto the first user's row (a
    cross-tenant overwrite). Re-iding makes every import an independent repertoire the
    importer owns. Parent links are remapped through the old→new id table."""
    new_rep_id = uuid.uuid4().hex
    id_map = {node.id: uuid.uuid4().hex for node in _walk_nodes(repertoire.root_node)}
    for node in _walk_nodes(repertoire.root_node):
        node.id = id_map[node.id]
        node.repertoire_id = new_rep_id
        if node.parent_id is not None:
            node.parent_id = id_map.get(node.parent_id, node.parent_id)
    repertoire.id = new_rep_id


def _safe_filename(name: str) -> str:
    """Slugify a repertoire name into a download-safe filename stem."""
    return "".join(
        char if char.isalnum() or char in {"-", "_"} else "-" for char in name.lower()
    ).strip("-") or "repertoire"


class CreateRepertoireBody(BaseModel):
    name: str = ""
    color: Literal["white", "black"] = "white"


@router.post("/repertoires/create")
def create_repertoire(
    body: CreateRepertoireBody,
    user: User = Depends(current_user),
    owner: str = Depends(current_owner),
    repo: WorkspaceRepository = Depends(get_repository),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Create a new repertoire owned by the caller and return its Build payload.

    Free-plan users are capped at ``settings.free_repertoire_limit`` repertoires;
    exceeding it returns 402 naming the limit and what clears it."""
    name = body.name.strip() or "Untitled repertoire"
    builder = OpeningBuilderService(repo)
    repertoire = builder.create_repertoire(
        CreateRepertoireRequest(name=name, color=Color(body.color)),
        owner, max_owned=_repertoire_cap(user, settings),
    )
    return build_workspace_payload(
        repo, repertoire.id, selected_node_id=repertoire.root_node.id, owner_user_id=owner
    )


# ---- Public share links -------------------------------------------------------
# A share link is a signed token: base64url(rep_id) + "." + share_rev + "." +
# HMAC slice. Knowing the link grants READ of the tree (name + moves +
# comments), plus a copy when ``share_role`` is 'copy'; it never grants edit.
# The public payload is stripped of the owner's training state. Forking copies
# the tree under the CALLER with fresh ids (same mechanics as package import).
#
# F-01: the link is independently governable per repertoire:
# - ``share_enabled`` off kills the link (without touching grants);
# - ``share_rev`` rotation re-signs, so every previously minted link dies;
# - ``share_expires_at`` is an optional deadline.


def _share_signature(repertoire_id: str, secret: str, rev: int) -> str:
    digest = hmac.new(
        secret.encode("utf-8"),
        "share:{0}:{1}".format(repertoire_id, rev).encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return digest[:32]


def mint_share_token(repertoire_id: str, secret: str, rev: int) -> str:
    rid = base64.urlsafe_b64encode(repertoire_id.encode("utf-8")).decode("ascii").rstrip("=")
    return "{0}.{1}.{2}".format(rid, rev, _share_signature(repertoire_id, secret, rev))


def parse_share_token(token: str, secret: str) -> tuple[str, int] | None:
    """Return the repertoire id and revision for a valid signed token."""
    try:
        rid, rev_text, signature = token.split(".")
        repertoire_id = base64.urlsafe_b64decode(
            (rid + "=" * (-len(rid) % 4)).encode("ascii")
        ).decode("utf-8")
        rev = int(rev_text)
    except (ValueError, UnicodeError):
        return None
    if repertoire_id and rev >= 0 and hmac.compare_digest(
        signature, _share_signature(repertoire_id, secret, rev)
    ):
        return repertoire_id, rev
    return None


def _share_state(meta: dict[str, Any]) -> dict[str, Any]:
    return {
        "share_enabled": bool(meta.get("share_enabled")),
        "share_rev": int(meta.get("share_rev") or 0),
        "share_expires_at": meta.get("share_expires_at"),
        "share_role": meta.get("share_role"),
    }


def _share_link_live(meta: dict[str, Any], token_rev: int, now: datetime) -> bool:
    """Does this token still grant read under the repertoire's share state?"""
    if not meta.get("share_enabled"):
        return False
    expires_at = meta.get("share_expires_at")
    if expires_at is not None and expires_at <= now:
        return False
    current_rev = int(meta.get("share_rev") or 0)
    return token_rev == current_rev


def _resolve_share_link(
    repo: WorkspaceRepository, token: str, secret: str
) -> dict[str, Any]:
    """The meta of the repertoire a token currently opens, with the link's role.
    Bad, revoked, rotated and expired links are all 404 (F-01)."""
    parsed = parse_share_token(token, secret)
    meta = repo.repertoire_meta(parsed[0]) if parsed is not None else None
    if meta is None or not _share_link_live(meta, parsed[1], datetime.now(timezone.utc)):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="unknown share link")
    return {**meta, "role": meta["share_role"]}


class ShareLinkBody(BaseModel):
    repertoire_id: str
    # Optional deadline for the link (1–365 days). None = no expiry.
    expires_in_days: int | None = Field(default=None, ge=1, le=365)
    # What anyone with the link may do. None keeps the current role.
    role: Literal["view", "copy"] | None = None


def _share_expiry(expires_in_days: int | None) -> datetime | None:
    if expires_in_days is None:
        return None
    return (
        datetime.now(timezone.utc) + timedelta(days=expires_in_days)
    )


@router.post("/repertoires/share-link")
def create_share_link(
    body: ShareLinkBody,
    owner: str = Depends(current_owner),
    repo: WorkspaceRepository = Depends(get_repository),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Turn on (or update) the public link for one of the caller's OWN repertoires.

    Idempotent mint: while a link is live, this returns the current token. If
    the link was off, enabling mints a FRESH link (rotation) — a revoked link
    never comes back to life (F-01). ``role`` sets what the link allows."""
    meta = _owned_repertoire(repo, body.repertoire_id, owner)
    expires_at = _share_expiry(body.expires_in_days)
    if not meta["share_enabled"]:
        state = repo.set_share_state(
            body.repertoire_id, enabled=True, rotate=True, expires_at=expires_at, role=body.role
        )
    else:
        state = repo.set_share_state(body.repertoire_id, expires_at=expires_at, role=body.role)
    token = mint_share_token(body.repertoire_id, settings.secret_key, state["share_rev"])
    return {
        "token": token,
        "url": "/?shared={0}".format(token),
        **state,
    }


@router.post("/repertoires/share-link/rotate")
def rotate_share_link(
    body: ShareLinkBody,
    owner: str = Depends(current_owner),
    repo: WorkspaceRepository = Depends(get_repository),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Regenerate the public link: bumps the share revision so every previously
    minted link stops working immediately."""
    _owned_repertoire(repo, body.repertoire_id, owner)
    expires_at = _share_expiry(body.expires_in_days)
    state = repo.set_share_state(
        body.repertoire_id, enabled=True, rotate=True, expires_at=expires_at, role=body.role
    )
    token = mint_share_token(body.repertoire_id, settings.secret_key, state["share_rev"])
    return {"token": token, "url": "/?shared={0}".format(token), **state}


@router.post("/repertoires/share-link/revoke")
def revoke_share_link(
    body: ShareLinkBody,
    owner: str = Depends(current_owner),
    repo: WorkspaceRepository = Depends(get_repository),
) -> dict[str, Any]:
    """Turn the public link OFF. Grants are untouched — the two are
    independent controls (F-01)."""
    _owned_repertoire(repo, body.repertoire_id, owner)
    state = repo.set_share_state(body.repertoire_id, enabled=False)
    return state


@router.get("/shared/{token}")
def shared_repertoire(
    token: str,
    repo: WorkspaceRepository = Depends(get_repository),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Public (unauthenticated) read of a shared repertoire's tree.

    Reuses the Build payload shape so the SPA's viewer is the Build view in
    read-only mode — minus the owner's training colour (health/mastery). ``role``
    is the link's (view / copy). Revoked / rotated / expired links are 404 (F-01)."""
    meta = _resolve_share_link(repo, token, settings.secret_key)
    payload = _payload(repo, meta)
    payload["writable"] = False
    return payload


def _fork(repo: WorkspaceRepository, repertoire_id: str, owner: str, user: User, settings: Settings) -> dict[str, Any]:
    repertoire = repo.load_repertoire(repertoire_id)
    if repertoire is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="repertoire not found")
    _reassign_ids(repertoire)  # fresh ids -> caller's own copy, no cross-tenant clobber
    repo.save_repertoire(repertoire, owner_user_id=owner, max_owned=_repertoire_cap(user, settings))
    return {"repertoire_id": repertoire.id, "name": repertoire.name}


@router.post("/shared/{token}/fork")
def fork_shared_repertoire(
    token: str,
    user: User = Depends(current_user),
    owner: str = Depends(current_owner),
    repo: WorkspaceRepository = Depends(get_repository),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Copy a shared repertoire into the caller's account (fresh ids, caller-owned)
    when the link allows copies (403 otherwise). Same free-plan cap as creating one
    from scratch. Revoked / rotated / expired links are 404 (F-01) — an already-made
    copy is independent and cannot be recalled by revoking the link."""
    meta = _resolve_share_link(repo, token, settings.secret_key)
    if meta["role"] != "copy":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=_DENIED["copy"])
    return _fork(repo, meta["id"], owner, user, settings)


class ForkRepertoireBody(BaseModel):
    repertoire_id: str


@router.post("/repertoires/fork")
def fork_repertoire(
    body: ForkRepertoireBody,
    user: User = Depends(current_user),
    owner: str = Depends(current_owner),
    repo: WorkspaceRepository = Depends(get_repository),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Copy a repertoire shared with the caller (role copy or edit) into their own
    account. Callers who already own it get 400 — there is nothing to fork."""
    meta = _repertoire_access(repo, body.repertoire_id, owner, "copy")
    if meta["role"] == "owner":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="repertoire is already yours",
        )
    return _fork(repo, body.repertoire_id, owner, user, settings)


class RenameRepertoireBody(BaseModel):
    repertoire_id: str
    name: str = ""


@router.post("/build/rename")
def build_rename(
    body: RenameRepertoireBody,
    owner: str = Depends(current_owner),
    repo: WorkspaceRepository = Depends(get_repository),
) -> dict[str, Any]:
    """Rename one of the caller's repertoires and return its refreshed Build payload."""
    meta = _owned_repertoire(repo, body.repertoire_id, owner)
    repo.op_kind = "rename"
    try:
        # Last writer wins: a concurrent rename on another device is replaced.
        _rebased(repo, meta, lambda: OpeningBuilderService(repo).rename_repertoire(
            body.repertoire_id, body.name))
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    return _payload(repo, meta)


class AddMoveBody(BaseModel):
    repertoire_id: str
    parent_node_id: str
    move_uci: str


@router.post("/build/add-move")
def build_add_move(
    body: AddMoveBody,
    owner: str = Depends(current_owner),
    repo: WorkspaceRepository = Depends(get_repository),
) -> dict[str, Any]:
    """Append a manual move under a parent node and return the refreshed Build payload.
    Classifies ownership: a move played on the owner's turn is flagged
    ``prepared``; the first enabled child of a parent becomes the mainline."""
    meta = _editable_repertoire(repo, body.repertoire_id, owner, "add_moves")

    def apply():
        repertoire = repo.load_repertoire(body.repertoire_id)
        if repertoire is None:  # gate passed but row vanished — treat as not found
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="repertoire not found")
        parent = _find_node(repertoire.root_node, body.parent_node_id)
        if parent is None:
            raise NodeGone(body.parent_node_id)
        is_prepared = parent.side_to_move is repertoire.color
        node = OpeningBuilderService(repo).add_move(
            body.repertoire_id,
            body.parent_node_id,
            body.move_uci,
            source=MoveSource.MANUAL,
            is_mainline=not any(child.is_enabled for child in parent.children),
            is_user_prepared_move=is_prepared,
            tags=["prepared"] if is_prepared else [],
            repertoire=repertoire,
        )
        return repertoire, node

    try:
        repertoire, node = _rebased(repo, meta, apply)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    return _payload(
        repo, meta, selected_node_id=node.id, repertoire=repertoire,
        summary={"added_nodes": 1, "updated_nodes": 0, "high_probability_unprepared": 0},
    )


# ---- Build local-first: batched manual moves (Phase 1) ----------------------
# The manual sibling of apply-plan. The SPA plays moves locally (optimistic
# render) and flushes a batch of `{tempId, parentRef, uci}` on idle/hard-flush;
# the server runs NO engine. It re-validates legality + parentage, forces
# MANUAL source, recomputes the persisted flags, and persists all-or-nothing.
# The refreshed payload carries `id_map` (tmp -> real) so the client reconciles
# its optimistic nodes. Owner-gated like every other Build mutation.


class AddMovesItem(BaseModel):
    tempId: str
    parentRef: str
    uci: str


def _build_batch_receipt(repo, owner, kind, body):
    # The complete request (including base revision) is the stable retry identity.
    digest = hashlib.sha256(json.dumps(body.model_dump(), sort_keys=True).encode()).hexdigest()
    key = "build-receipt:" + kind + ":" + digest
    return key, repo.get_user_setting(owner, key)


class AddMovesBody(BaseModel):
    repertoire_id: str
    moves: list[AddMovesItem] = Field(default_factory=list, max_length=MAX_ADD_MOVES_BATCH)


@router.post("/build/add-moves")
@limiter.limit("30/minute")
def build_add_moves(
    request: Request,
    body: AddMovesBody,
    owner: str = Depends(current_owner),
    repo: WorkspaceRepository = Depends(get_repository),
) -> dict[str, Any]:
    """Apply a batch of manual moves (local-first Build flush) and return the
    refreshed Build payload plus an ``id_map`` of ``tempId -> real node id``.

    No compute: the service re-validates legality + parentage and recomputes the
    persisted flags itself, so a malformed batch raises ``ValueError`` → 400
    before anything lands. Owner-gated so a user can't flush onto another's tree."""
    meta = _editable_repertoire(repo, body.repertoire_id, owner, "add_moves")
    key, receipt = _build_batch_receipt(repo, owner, "adds", body)
    if receipt is not None:
        payload = _payload(repo, meta)
        payload.update(receipt)
        return payload
    service = OpeningBuilderService(repo)
    try:
        repertoire, summary, id_map = _rebased(repo, meta, lambda: service.add_moves_batch(
            body.repertoire_id,
            [item.model_dump() for item in body.moves],
            receipt_target=(owner, key),
        ))
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    payload = _payload(
        repo, meta, repertoire=repertoire,
        summary={
            "added_nodes": summary.added_nodes,
            "updated_nodes": summary.updated_nodes,
            "high_probability_unprepared": summary.high_probability_unprepared,
        },
    )
    payload["id_map"] = id_map
    payload["dropped"] = service.dropped_temp_ids
    return payload


class DeleteNodesBody(BaseModel):
    repertoire_id: str
    node_ids: list[str] = Field(default_factory=list, max_length=MAX_DELETE_NODES_BATCH)


@router.post("/build/delete-nodes")
@limiter.limit("30/minute")
def build_delete_nodes(
    request: Request,
    body: DeleteNodesBody,
    owner: str = Depends(current_owner),
    repo: WorkspaceRepository = Depends(get_repository),
) -> dict[str, Any]:
    """Delete a batch of subtrees (local-first Build flush) and return the
    refreshed Build payload.

    The sibling of ``/build/add-moves`` for the delete half of the local-first
    queue: the SPA prunes the subtree from its tree immediately and flushes the
    subtree-root ids on the same debounce. Idempotent per id (an id deleted by
    an earlier subtree in the batch, or by a previous flush, is skipped) so an
    optimistic over-delete can't fail the whole flush. Owner-gated."""
    meta = _editable_repertoire(repo, body.repertoire_id, owner, "delete_nodes")
    key, receipt = _build_batch_receipt(repo, owner, "deletes", body)
    if receipt is not None:
        payload = _payload(repo, meta)
        payload.update(receipt)
        return payload
    service = OpeningBuilderService(repo)
    try:
        removed = _rebased(repo, meta, lambda: service.delete_nodes_batch(
            body.repertoire_id, list(body.node_ids), receipt_target=(owner, key)
        ))
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    payload = _payload(repo, meta, repertoire=service.loaded_repertoire)
    payload["removed_node_ids"] = removed
    return payload


# ---- Build generate: apply-plan (2b-2d-ii) ----------------------------------
# The browser ran the whole generation recursion locally (Stockfish + Maia3 in
# WebAssembly) and submits a tree-mutation plan; the server runs NO engine. It
# re-validates every move's legality + parentage, RECOMPUTES the persisted flags
# itself (never trusting the client), and persists all-or-nothing.
# deploy doesn't run ("the server stores data, never computes chess").


class ApplyPlanBody(BaseModel):
    repertoire_id: str
    root_node_id: str
    plan: dict[str, Any] | None = None
    operation_id: uuid.UUID | None = None


@router.post("/build/generate/apply-plan")
@limiter.limit("10/minute")
def build_apply_plan(
    request: Request,
    body: ApplyPlanBody,
    owner: str = Depends(current_owner),
    repo: WorkspaceRepository = Depends(get_repository),
) -> dict[str, Any]:
    """Apply a browser-built Build-Generate plan and return the refreshed payload.

    No compute: the service re-validates legality + parentage and recomputes the
    persisted flags itself, so a malformed plan raises ``ValueError`` → 400 before
    anything lands. Owner-gated so a user can't apply a plan onto another's tree."""
    if not isinstance(body.plan, dict):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="plan must be an object")
    meta = _editable_repertoire(repo, body.repertoire_id, owner, "generate")
    receipt_target = None
    if body.operation_id is not None:
        key = "build-receipt:plan:" + str(body.operation_id)
        digest = hashlib.sha256(json.dumps(
            body.model_dump(mode="json"), sort_keys=True
        ).encode()).hexdigest()
        receipt = repo.get_user_setting(owner, key)
        if receipt is not None:
            if receipt.get("digest") != digest:
                raise HTTPException(status_code=409, detail="operation_id reused with a different plan")
            payload = _payload(repo, meta, summary=receipt["summary"])
            payload["id_map"] = receipt.get("id_map", {})
            return payload
        receipt_target = (owner, key, digest)
    builder = OpeningBuilderService(repo)
    try:
        repertoire, summary = _rebased(repo, meta, lambda: builder.apply_generation_plan(
            body.repertoire_id, body.root_node_id, body.plan, receipt_target=receipt_target
        ))
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    payload = _payload(
        repo, meta, selected_node_id=body.root_node_id, repertoire=repertoire,
        summary={
            "added_nodes": summary.added_nodes,
            "updated_nodes": summary.updated_nodes,
            "high_probability_unprepared": summary.high_probability_unprepared,
        },
    )
    payload["id_map"] = builder.applied_plan_id_map
    return payload


# ---- Build node actions / annotations / export (2b-2e) ----------------------
# Pure data operations on the stored tree (no engine) use the Maia-free builder.
# Owner-gated via `_owned_repertoire`; the node-action/annotation handlers return
# the shared Build payload, export returns a downloadable blob.


class NodeActionBody(BaseModel):
    repertoire_id: str
    node_id: str
    # Each action states its result (disable vs enable), never "toggle": a
    # rebased edit must mean the same thing on whatever tree it lands on.
    action: Literal[
        "set_mainline",
        "mark_prepared",
        "disable_branch",
        "enable_branch",
        "delete",
        "add_comment",
        "add_tag",
        "add_training_queue",
        "mark_critical",
    ]
    value: str | None = None


@router.post("/build/action")
def build_action(
    body: NodeActionBody,
    owner: str = Depends(current_owner),
    repo: WorkspaceRepository = Depends(get_repository),
) -> dict[str, Any]:
    """Apply a node action (set-mainline / prepared / disable / enable / delete /
    comment / tag / queue / critical) and return the refreshed Build payload.
    Scalar edits are last-writer-wins; an action on a node deleted elsewhere is 409."""
    action = body.action
    meta = _editable_repertoire(repo, body.repertoire_id, owner, action)
    builder = OpeningBuilderService(repo)
    rid, node_id = body.repertoire_id, body.node_id

    def apply() -> str | None:
        if action == "set_mainline":
            builder.set_as_mainline(rid, node_id)
        elif action == "mark_prepared":
            builder.mark_prepared(rid, node_id, body.value != "false")
        elif action == "disable_branch":
            builder.disable_branch(rid, node_id)
        elif action == "enable_branch":
            builder.enable_branch(rid, node_id)
        elif action == "delete":
            return builder.delete_node(rid, node_id)
        elif action == "add_comment":
            builder.add_comment(rid, node_id, body.value or "")
        elif action == "add_tag":
            if not body.value:
                raise ValueError("tag is required")
            builder.add_tag(rid, node_id, body.value)
        elif action == "add_training_queue":
            builder.add_tag(rid, node_id, "training-queue")
        else:  # mark_critical
            builder.add_tag(rid, node_id, "critical")
        return node_id

    try:
        selected_node_id = _rebased(repo, meta, apply)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    return _payload(
        repo, meta, selected_node_id=selected_node_id, repertoire=builder.loaded_repertoire
    )


class AnnotationsBody(BaseModel):
    repertoire_id: str
    node_id: str
    arrows: list[str] = Field(default_factory=list, max_length=MAX_ANNOTATIONS_PER_KIND)
    circles: list[str] = Field(default_factory=list, max_length=MAX_ANNOTATIONS_PER_KIND)


@router.post("/build/annotations")
@limiter.limit("60/minute")
def build_annotations(
    request: Request,
    body: AnnotationsBody,
    owner: str = Depends(current_owner),
    repo: WorkspaceRepository = Depends(get_repository),
) -> dict[str, Any]:
    """Persist a node's arrows/circles and echo them back (the SPA ignores the rest of
    a Build payload here, so no full reserialization)."""
    meta = _editable_repertoire(repo, body.repertoire_id, owner, "annotate")
    try:
        _rebased(repo, meta, lambda: OpeningBuilderService(repo).set_annotations(
            body.repertoire_id, body.node_id, body.arrows, body.circles
        ))
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    return {
        "node_id": body.node_id,
        "arrows": list(body.arrows),
        "circles": list(body.circles),
        "revision": repo.repertoire_reply_revision(body.repertoire_id),
    }


class ExportBody(BaseModel):
    repertoire_id: str
    format: Literal["json", "pgn"]
    node_id: str | None = None


@router.post("/build/export")
def build_export(
    body: ExportBody,
    owner: str = Depends(current_owner),
    repo: WorkspaceRepository = Depends(get_repository),
) -> dict[str, Any]:
    """Serialize a repertoire to a downloadable blob: ``json`` (full package) or
    ``pgn`` (mainline, or the path to ``node_id`` when given). Pure serialization."""
    _repertoire_access(repo, body.repertoire_id, owner, "copy")
    repertoire = repo.load_repertoire(body.repertoire_id)
    if repertoire is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="repertoire not found")
    exporter = RepertoireExportService()
    safe_name = _safe_filename(repertoire.name)
    if body.format == "json":
        content = exporter.export_package_json(repertoire)
        filename = "{0}.prepforge.json".format(safe_name)
        mime = "application/json"
    else:  # pgn
        content = (
            exporter.export_node_path_pgn(repertoire, body.node_id)
            if body.node_id
            else exporter.export_mainline_pgn(repertoire)
        )
        filename = "{0}.pgn".format(safe_name)
        mime = "application/x-chess-pgn"
    return {"filename": filename, "mime": mime, "content": content}


@router.get("/repertoires/export-pgn")
def export_tree_pgn(
    repertoire_id: str,
    owner: str = Depends(current_owner),
    repo: WorkspaceRepository = Depends(get_repository),
) -> dict[str, Any]:
    """Full tree-with-variations PGN for the top-level "Export PGN" action (the SPA's
    per-line export goes through ``/build/export``). Pure serialization, owner-gated."""
    _repertoire_access(repo, repertoire_id, owner, "copy")
    repertoire = repo.load_repertoire(repertoire_id)
    if repertoire is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="repertoire not found")
    content = RepertoireExportService().export_tree_pgn(repertoire)
    return {
        "filename": "{0}.tree.pgn".format(_safe_filename(repertoire.name)),
        "mime": "application/x-chess-pgn",
        "content": content,
    }


# ---- Repertoire import (2b-2e) ----------------------------------------------
# Import a repertoire from a saved package (JSON) or a tree PGN. Both create a
# brand-new repertoire stamped to the caller via `save_repertoire(owner_user_id=...)`.


class ImportPackageBody(BaseModel):
    package_json: str = Field(default="", max_length=MAX_REPERTOIRE_PACKAGE_CHARS)


@router.post("/repertoires/import")
@limiter.limit("10/minute")
def import_repertoire(
    request: Request,
    body: ImportPackageBody,
    user: User = Depends(current_user),
    owner: str = Depends(current_owner),
    repo: WorkspaceRepository = Depends(get_repository),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Import a repertoire from a saved ``.prepforge.json`` package, owned by the caller."""
    if not body.package_json.strip():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="repertoire package is empty")
    try:
        repertoire = RepertoireExportService().import_package_json(body.package_json)
    except (ValueError, KeyError) as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    _reassign_ids(repertoire)  # fresh ids → importer's own copy, no cross-tenant clobber
    repo.save_repertoire(repertoire, owner_user_id=owner, max_owned=_repertoire_cap(user, settings))
    return build_workspace_payload(
        repo,
        repertoire.id,
        selected_node_id=repertoire.root_node.id,
        owner_user_id=owner,
        summary={
            "added_nodes": sum(1 for _ in _walk_nodes(repertoire.root_node)),
            "updated_nodes": 0,
            "high_probability_unprepared": 0,
        },
    )


class ImportPgnBody(BaseModel):
    pgn: str = Field(default="", max_length=PGN_LIMITS.max_chars)
    name: str = Field(default="Imported", max_length=200)
    color: Literal["white", "black"] = "white"


@router.post("/repertoires/import-pgn")
@limiter.limit("10/minute")
def import_repertoire_pgn(
    request: Request,
    body: ImportPgnBody,
    user: User = Depends(current_user),
    owner: str = Depends(current_owner),
    repo: WorkspaceRepository = Depends(get_repository),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Import a repertoire from a tree PGN (variations become branches), owned by the caller."""
    try:
        repertoire = RepertoireExportService().import_tree_pgn(
            body.pgn, name=body.name, color=Color(body.color)
        )
    except (ValueError, KeyError) as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    repo.save_repertoire(repertoire, owner_user_id=owner, max_owned=_repertoire_cap(user, settings))
    return build_workspace_payload(
        repo, repertoire.id, selected_node_id=repertoire.root_node.id, owner_user_id=owner
    )
