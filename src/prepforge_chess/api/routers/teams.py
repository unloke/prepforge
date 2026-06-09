"""Teams & classroom (Phase 5).

A *team* is a feature, not a pricing tier: creating one is gated to Pro
(``require_pro``), but there is **no per-seat billing**. Membership has roles
(owner/admin/member); owners and admins manage membership. Repertoires are shared
to a team via ``POST /api/repertoires/share`` (in ``workspace.py``); team members
then get **read-only** access — mutations stay owner-only, so sharing never widens
write access. ``kind='classroom'`` is stored for later teacher/student affordances.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from prepforge_chess.api.db import get_db
from prepforge_chess.api.deps import current_user, require_pro
from prepforge_chess.api.models import Team, TeamMember, TeamRole, User

router = APIRouter(prefix="/api/teams", tags=["teams"])

# Roles allowed to manage membership.
_MANAGER_ROLES = {TeamRole.owner, TeamRole.admin}


def user_team_ids(db: Session, user_id: str) -> set[str]:
    """Every team id the user belongs to — the read-access widening set used by the
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


class CreateTeamBody(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    kind: str = Field(default="team")


def _team_out(db: Session, team: Team, role: TeamRole) -> dict[str, object]:
    count = db.execute(
        select(func.count()).select_from(TeamMember).where(TeamMember.team_id == team.id)
    ).scalar_one()
    return {
        "id": team.id,
        "name": team.name,
        "kind": team.kind,
        "role": role.value,
        "member_count": int(count),
    }


@router.post("")
def create_team(
    body: CreateTeamBody,
    user: User = Depends(require_pro),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    """Create a team (Pro only) and enroll the caller as its owner."""
    kind = body.kind if body.kind in ("team", "classroom") else "team"
    team = Team(name=body.name.strip(), owner_user_id=user.id, kind=kind)
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


@router.get("/{team_id}")
def team_detail(
    team_id: str,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    """Team + its members (caller must be a member)."""
    me = _require_member(db, team_id, user)
    team = db.get(Team, team_id)
    members = db.execute(
        select(TeamMember, User)
        .join(User, User.id == TeamMember.user_id)
        .where(TeamMember.team_id == team_id)
        .order_by(TeamMember.created_at)
    ).all()
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
    return out


class AddMemberBody(BaseModel):
    email: EmailStr
    role: str = Field(default="member")


@router.post("/{team_id}/members")
def add_member(
    team_id: str,
    body: AddMemberBody,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    """Add an existing user (by email) to the team. Owner/admin only."""
    _require_manager(db, team_id, user)
    try:
        role = TeamRole(body.role)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="invalid role"
        ) from None
    if role == TeamRole.owner:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="cannot add a second owner"
        )
    target = db.execute(
        select(User).where(func.lower(User.email) == body.email.lower())
    ).scalar_one_or_none()
    if target is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="no such user")
    if _membership(db, team_id, target.id) is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="already a member"
        )
    db.add(TeamMember(team_id=team_id, user_id=target.id, role=role))
    db.commit()
    return {"user_id": target.id, "email": target.email, "role": role.value}


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
