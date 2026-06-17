"""Teams (Phase 5, redesigned).

A *team* is a feature, not a pricing tier: creating one is **open to every signed-in
user** (no Pro requirement, no per-seat billing). Membership has roles
(owner/admin/member); owners and admins ("managers") handle membership, member
roles, and the team's invite link.

Members are added two ways:

* by **Lichess username** -- resolved to the PrepForge user who linked that handle
  (chess-native; no email to remember); or
* via the team's **invite link** -- a shareable code anyone can redeem to join
  themselves (covers people who have not linked Lichess yet).

Repertoires are shared to a team via ``POST /api/repertoires/share`` (in
``workspace.py``); team members then get **read-only** access -- mutations stay
owner-only, so sharing never widens write access.
"""
from __future__ import annotations

import hashlib
import secrets
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from prepforge_chess.api.db import get_db
from prepforge_chess.api.deps import current_user, get_repository
from prepforge_chess.api.models import (
    LinkedAccount,
    Team,
    TeamInvite,
    TeamMember,
    TeamRole,
    User,
)
from prepforge_chess.storage.repositories import PrepForgeRepository

router = APIRouter(prefix="/api/teams", tags=["teams"])

# Roles allowed to manage membership, roles, and the invite link.
_MANAGER_ROLES = {TeamRole.owner, TeamRole.admin}
# Roles assignable to a member: owner is single + immutable here (no second owner,
# no ownership transfer via these endpoints).
_ASSIGNABLE_ROLES = {TeamRole.admin, TeamRole.member}

# Lichess identities live in ``LinkedAccount`` under this provider string (see
# ``routers.lichess.PROVIDER``). Inlined to keep the teams<-workspace import graph
# acyclic; the value is a stable public OAuth provider name.
_LICHESS_PROVIDER = "lichess"


def user_team_ids(db: Session, user_id: str) -> set[str]:
    """Every team id the user belongs to -- the read-access widening set used by the
    repertoire-sharing gate. Empty set means no widening (isolation preserved)."""
    rows = db.execute(
        select(TeamMember.team_id).where(TeamMember.user_id == user_id)
    ).scalars().all()
    return set(rows)


def _membership(db: Session, team_id: str, user_id: str) -> TeamMember | None:
    return db.execute(
        select(TeamMember).where(
            TeamMember.team_id == team_id, TeamMember.user_id == user_id
        )
    ).scalar_one_or_none()


def _require_member(db: Session, team_id: str, user: User) -> TeamMember:
    """Caller must belong to the team, else 404 (don't reveal a team's existence)."""
    member = _membership(db, team_id, user.id)
    if member is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="team not found")
    return member


def _require_manager(db: Session, team_id: str, user: User) -> TeamMember:
    member = _require_member(db, team_id, user)
    if member.role not in _MANAGER_ROLES:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="owner or admin role required"
        )
    return member


def _member_count(db: Session, team_id: str) -> int:
    return int(
        db.execute(
            select(func.count()).select_from(TeamMember).where(TeamMember.team_id == team_id)
        ).scalar_one()
    )


def _team_out(db: Session, team: Team, role: TeamRole) -> dict[str, object]:
    return {
        "id": team.id,
        "name": team.name,
        "role": role.value,
        "member_count": _member_count(db, team.id),
    }


# --- invite-code hashing ----------------------------------------------------
# Only the SHA-256 of the code is stored (mirrors ``security.hash_session_token``):
# a DB leak never yields a working invite. The raw code is shown once, at mint time.

def _hash_invite_code(code: str) -> str:
    return hashlib.sha256(code.encode("utf-8")).hexdigest()


def _live_invite(db: Session, code: str) -> TeamInvite | None:
    """The invite a (raw) code names, if it exists and has not expired; else None."""
    invite = db.execute(
        select(TeamInvite).where(TeamInvite.code_hash == _hash_invite_code(code))
    ).scalar_one_or_none()
    if invite is None:
        return None
    if invite.expires_at is not None and invite.expires_at <= datetime.now(timezone.utc):
        return None
    return invite


# --- create / list ----------------------------------------------------------


class CreateTeamBody(BaseModel):
    name: str = Field(min_length=1, max_length=120)

    @field_validator("name")
    @classmethod
    def name_not_blank(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("name must not be blank")
        return stripped


@router.post("")
def create_team(
    body: CreateTeamBody,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    """Create a team (any signed-in user) and enroll the caller as its owner."""
    team = Team(name=body.name, owner_user_id=user.id, kind="team")
    db.add(team)
    db.flush()  # assign team.id before the membership row references it
    db.add(TeamMember(team_id=team.id, user_id=user.id, role=TeamRole.owner))
    db.commit()
    return _team_out(db, team, TeamRole.owner)


@router.get("")
def list_teams(
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    """Teams the caller belongs to, each with the caller's role."""
    rows = db.execute(
        select(Team, TeamMember.role)
        .join(TeamMember, TeamMember.team_id == Team.id)
        .where(TeamMember.user_id == user.id)
        .order_by(Team.created_at.desc())
    ).all()
    return {"teams": [_team_out(db, team, role) for team, role in rows]}


# --- invite link: redeem (declared before ``/{team_id}`` so the literal "join"
#     segment is unambiguous) -------------------------------------------------


@router.get("/join/{code}")
def join_preview(
    code: str,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    """Preview the team an invite code points at, so the joiner sees what they're
    joining before committing. 404 if the code is unknown or expired."""
    invite = _live_invite(db, code)
    team = db.get(Team, invite.team_id) if invite is not None else None
    if invite is None or team is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="this invite link is invalid or has expired",
        )
    return {
        "team_id": team.id,
        "name": team.name,
        "member_count": _member_count(db, team.id),
        "already_member": _membership(db, team.id, user.id) is not None,
    }


@router.post("/join/{code}")
def join_team(
    code: str,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    """Redeem an invite code to join its team as a plain member. Idempotent: a
    second redemption by an existing member is a no-op (never an error)."""
    invite = _live_invite(db, code)
    team = db.get(Team, invite.team_id) if invite is not None else None
    if invite is None or team is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="this invite link is invalid or has expired",
        )
    existing = _membership(db, team.id, user.id)
    if existing is not None:
        return {
            "joined": False,
            "already_member": True,
            "team": _team_out(db, team, existing.role),
        }
    db.add(TeamMember(team_id=team.id, user_id=user.id, role=TeamRole.member))
    db.commit()
    return {
        "joined": True,
        "already_member": False,
        "team": _team_out(db, team, TeamRole.member),
    }


# --- team detail ------------------------------------------------------------


@router.get("/{team_id}")
def team_detail(
    team_id: str,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
    repo: PrepForgeRepository = Depends(get_repository),
) -> dict[str, object]:
    """Team + its members + repertoires shared to it (caller must be a member).
    Managers additionally see whether an invite link exists (never the code)."""
    me = _require_member(db, team_id, user)
    team = db.get(Team, team_id)
    members = db.execute(
        select(TeamMember, User)
        .join(User, User.id == TeamMember.user_id)
        .where(TeamMember.team_id == team_id)
        .order_by(TeamMember.created_at)
    ).all()
    shared = repo.list_repertoires_shared_to_team(team_id)
    owner_ids = {item["owner_user_id"] for item in shared}
    owners_by_id = {}
    if owner_ids:
        owners = db.execute(select(User).where(User.id.in_(owner_ids))).scalars().all()
        owners_by_id = {u.id: u for u in owners}
    out = _team_out(db, team, me.role)
    out["members"] = [
        {
            "user_id": u.id,
            "email": u.email,
            "display_name": u.display_name,
            "role": m.role.value,
        }
        for m, u in members
    ]
    out["shared_repertoires"] = [
        {
            "id": item["id"],
            "name": item["name"],
            "color": item["color"],
            "owner_user_id": item["owner_user_id"],
            "owner_email": owners_by_id[item["owner_user_id"]].email
            if item["owner_user_id"] in owners_by_id
            else None,
            "owner_display_name": owners_by_id[item["owner_user_id"]].display_name
            if item["owner_user_id"] in owners_by_id
            else None,
        }
        for item in shared
    ]
    if me.role in _MANAGER_ROLES:
        invite = db.execute(
            select(TeamInvite).where(TeamInvite.team_id == team_id)
        ).scalar_one_or_none()
        out["invite"] = (
            {
                "exists": True,
                "created_at": invite.created_at.isoformat() if invite.created_at else None,
                "expires_at": invite.expires_at.isoformat() if invite.expires_at else None,
            }
            if invite is not None
            else {"exists": False}
        )
    return out


# --- membership: add / remove / role ----------------------------------------


class AddMemberBody(BaseModel):
    lichess_username: str = Field(min_length=1, max_length=120)
    role: str = Field(default="member")

    @field_validator("lichess_username")
    @classmethod
    def username_not_blank(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("lichess_username must not be blank")
        return stripped


@router.post("/{team_id}/members")
def add_member(
    team_id: str,
    body: AddMemberBody,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    """Add a member by their Lichess username. Owner/admin only. The handle is
    resolved to the PrepForge user who linked it (case-insensitive); if no member
    has linked that handle we 404 with an actionable message pointing at the invite
    link -- we never silently create anything."""
    _require_manager(db, team_id, user)
    try:
        role = TeamRole(body.role)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="invalid role"
        ) from None
    if role not in _ASSIGNABLE_ROLES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="role must be admin or member",
        )
    handle = body.lichess_username.strip()
    target_link = db.execute(
        select(LinkedAccount).where(
            LinkedAccount.provider == _LICHESS_PROVIDER,
            func.lower(LinkedAccount.provider_user_id) == handle.lower(),
        )
    ).scalars().first()
    if target_link is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=(
                f"No PrepForge member has linked the Lichess account '{handle}'. "
                "Send them an invite link to add them."
            ),
        )
    if _membership(db, team_id, target_link.user_id) is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="already a member"
        )
    db.add(TeamMember(team_id=team_id, user_id=target_link.user_id, role=role))
    db.commit()
    target = db.get(User, target_link.user_id)
    return {
        "user_id": target_link.user_id,
        "email": target.email if target else None,
        "display_name": target.display_name if target else None,
        "lichess_username": target_link.provider_user_id,
        "role": role.value,
    }


@router.delete("/{team_id}/members/{user_id}")
def remove_member(
    team_id: str,
    user_id: str,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict[str, bool]:
    """Remove a member. Owner/admin can remove anyone (except the owner); any member
    may remove themselves (leave)."""
    target = _membership(db, team_id, user_id)
    if target is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not a member")
    if target.role == TeamRole.owner:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="cannot remove the team owner"
        )
    if user_id != user.id:
        _require_manager(db, team_id, user)  # removing someone else needs manage rights
    else:
        _require_member(db, team_id, user)  # self-leave still requires being a member
    db.delete(target)
    db.commit()
    return {"removed": True}


class UpdateMemberRoleBody(BaseModel):
    role: str


@router.patch("/{team_id}/members/{user_id}")
def update_member_role(
    team_id: str,
    user_id: str,
    body: UpdateMemberRoleBody,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    """Promote/demote a member between admin and member. Owner/admin only. The owner
    is immutable here (no demoting the sole owner, no minting a second owner); an
    admin may demote themselves. A no-op (role unchanged) succeeds idempotently."""
    _require_manager(db, team_id, user)
    try:
        role = TeamRole(body.role)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="invalid role"
        ) from None
    if role not in _ASSIGNABLE_ROLES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="role must be admin or member",
        )
    target = _membership(db, team_id, user_id)
    if target is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not a member")
    if target.role == TeamRole.owner:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="cannot change the team owner's role",
        )
    if target.role != role:
        target.role = role
        db.commit()
    return {"user_id": user_id, "role": role.value}


# --- invite link: manage ----------------------------------------------------


@router.post("/{team_id}/invite")
def create_invite(
    team_id: str,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    """Mint (or rotate) the team's invite link. Owner/admin only. Returns the raw
    code **once** -- only its hash is stored, so it can't be re-displayed; calling
    this again rotates the code, invalidating the previous link."""
    _require_manager(db, team_id, user)
    code = secrets.token_urlsafe(9)
    invite = db.execute(
        select(TeamInvite).where(TeamInvite.team_id == team_id)
    ).scalar_one_or_none()
    if invite is None:
        invite = TeamInvite(
            team_id=team_id,
            code_hash=_hash_invite_code(code),
            created_by_user_id=user.id,
        )
        db.add(invite)
    else:
        invite.code_hash = _hash_invite_code(code)
        invite.created_by_user_id = user.id
        invite.created_at = datetime.now(timezone.utc)
        invite.expires_at = None
    db.commit()
    return {"code": code, "url": f"/?join={code}", "expires_at": None}


@router.delete("/{team_id}/invite", status_code=status.HTTP_204_NO_CONTENT)
def revoke_invite(
    team_id: str,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> Response:
    """Revoke the team's invite link (existing links stop working). Owner/admin only."""
    _require_manager(db, team_id, user)
    invite = db.execute(
        select(TeamInvite).where(TeamInvite.team_id == team_id)
    ).scalar_one_or_none()
    if invite is not None:
        db.delete(invite)
        db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# --- rename / delete --------------------------------------------------------


class UpdateTeamBody(BaseModel):
    name: str = Field(min_length=1, max_length=120)

    @field_validator("name")
    @classmethod
    def name_not_blank(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("name must not be blank")
        return stripped


@router.patch("/{team_id}")
def update_team(
    team_id: str,
    body: UpdateTeamBody,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    """Rename a team. Owner/admin only."""
    member = _require_manager(db, team_id, user)
    team = db.get(Team, team_id)
    if team is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="team not found")
    team.name = body.name
    db.commit()
    return _team_out(db, team, member.role)


@router.delete("/{team_id}")
def delete_team(
    team_id: str,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
    repo: PrepForgeRepository = Depends(get_repository),
) -> dict[str, bool]:
    """Delete a team and unshare its repertoires. Team owner only. The team's invite
    row cascades away with it (FK ON DELETE CASCADE)."""
    member = _require_member(db, team_id, user)
    if member.role != TeamRole.owner:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="team owner role required"
        )
    team = db.get(Team, team_id)
    if team is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="team not found")
    repo.unshare_all_for_team(team_id)
    db.delete(team)
    db.commit()
    return {"deleted": True}
