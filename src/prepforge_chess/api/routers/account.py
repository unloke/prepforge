"""Account data management (F-05): self-service export and deletion.

Export bundles everything the account owns (profile, linked identities,
settings, games with PGN, repertoires as packages, training progress and
sessions) into one JSON document whose scope matches what deletion removes.

Deletion is a complete flow, not a policy paragraph: it takes an explicit
confirmation, removes owned data with per-table counts, kills every session and
reset token, unlinks accounts, revokes share links (their repertoire rows die),
and reports what was removed. Shared engine data (positions, evaluation
snapshots) is intentionally NOT deleted here — two owners' identical analyses
can share one snapshot row — it is reclaimed by the data-lifecycle pass when
nothing references it (see services/data_lifecycle.py).
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from prepforge_chess.api.config import Settings, get_settings
from prepforge_chess.api.db import get_db
from prepforge_chess.api.deps import current_user, get_repository
from prepforge_chess.api.models import (
    AuthSession,
    LinkedAccount,
    PasswordResetToken,
    Team,
    TeamInvite,
    TeamMember,
    User,
)
from prepforge_chess.api.ratelimit import limiter
from prepforge_chess.services.repertoire_export import RepertoireExportService
from prepforge_chess.storage.repositories.workspace import WorkspaceRepository

router = APIRouter(prefix="/api/account", tags=["account"])


@router.get("/export")
@limiter.limit("5/hour")
def export_account(
    request: Request,
    user: User = Depends(current_user),
    repo: WorkspaceRepository = Depends(get_repository),
    db: Session = Depends(get_db),
) -> StreamingResponse:
    """Download everything this account owns as one JSON bundle.

    The scope is exactly the deletion scope below — what you can take with you
    is what leaving removes (minus shared engine snapshots)."""
    exporter = RepertoireExportService()
    linked = db.scalars(
        select(LinkedAccount).where(LinkedAccount.user_id == user.id)
    ).all()
    settings_rows = repo.list_owner_settings(user.id)
    metadata = {
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "account": {
            "id": user.id,
            "email": user.email,
            "plan": user.plan.value,
            "display_name": user.display_name,
            "created_at": user.created_at.isoformat() if user.created_at else None,
        },
        "linked_accounts": [
            {
                "provider": row.provider,
                "provider_user_id": row.provider_user_id,
                "is_primary": row.is_primary,
            }
            for row in linked
        ],
        "settings": settings_rows,
    }

    def games():
        for game in repo.iter_games(owner_user_id=user.id, render_pgn=True):
            yield {
                "id": game.id,
                "source": game.source.value,
                "white": game.white,
                "black": game.black,
                "result": game.result.value,
                "played_at": game.played_at.isoformat() if game.played_at else None,
                "lichess_id": game.lichess_id,
                "pgn": game.pgn,
            }

    def repertoires():
        for row in repo.list_repertoire_metas(owner_user_id=user.id):
            rep = repo.load_repertoire(row["id"], owner_user_id=user.id)
            if rep is not None:
                yield json.loads(exporter.export_package_json(rep))

    def stream():
        yield json.dumps(metadata, ensure_ascii=True)[:-1]
        for key, entries in [
            ("games", games()),
            ("repertoires", repertoires()),
            ("training_progress", repo.iter_owner_training_progress(user.id)),
            ("training_sessions", repo.iter_owner_training_sessions(user.id)),
        ]:
            yield f',"{key}":['
            first = True
            for entry in entries:
                yield ("" if first else ",") + json.dumps(entry, ensure_ascii=True, default=lambda value: value.isoformat())
                first = False
            yield "]"
        yield "}"

    filename = "prepforge-export-{0}.json".format(datetime.now(timezone.utc).date().isoformat())
    return StreamingResponse(stream(), media_type="application/json", headers={
        "Content-Disposition": f'attachment; filename="{filename}"',
    })


class DeleteAccountBody(BaseModel):
    confirm: str


@router.delete("")
@limiter.limit("5/hour")
def delete_account(
    request: Request,
    body: DeleteAccountBody,
    response: Response,
    user: User = Depends(current_user),
    repo: WorkspaceRepository = Depends(get_repository),
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Delete the account and everything it owns — a completable flow (F-05).

    Requires the explicit ``confirm: "DELETE"`` payload. Returns per-table
    counts so the user (and support) can see what happened. Every session and
    reset token dies with the account, and public share links stop resolving
    because their repertoire rows are gone. Already-made copies by other users
    (forks) are independent and cannot be recalled."""
    if body.confirm != "DELETE":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail='confirm must be exactly "DELETE"',
        )
    # D-05: domain rows (Core repository) and identity rows (ORM Session) used
    # to commit as two transactions, so a failure in the second left an account
    # whose content was gone but which could still sign in. Both halves now run
    # on THIS session's connection and commit together.
    counts = repo.delete_owner_data(user.id, conn=db.connection())

    try:
        # Identity rows: explicit deletes (FK cascades are not relied on — SQLite
        # in tests does not enforce them, and a dangling session would be a
        # credential outliving the account).
        counts["sessions"] = len(
            db.scalars(select(AuthSession).where(AuthSession.user_id == user.id)).all()
        )
        for row in db.scalars(select(AuthSession).where(AuthSession.user_id == user.id)).all():
            db.delete(row)
        counts["password_reset_tokens"] = len(
            db.scalars(
                select(PasswordResetToken).where(PasswordResetToken.user_id == user.id)
            ).all()
        )
        for row in db.scalars(
            select(PasswordResetToken).where(PasswordResetToken.user_id == user.id)
        ).all():
            db.delete(row)
        counts["linked_accounts"] = len(
            db.scalars(select(LinkedAccount).where(LinkedAccount.user_id == user.id)).all()
        )
        for row in db.scalars(
            select(LinkedAccount).where(LinkedAccount.user_id == user.id)
        ).all():
            db.delete(row)
        # Teams this user owns die with the account; memberships elsewhere end too
        # (a removed member can no longer read anything shared to that team).
        owned_teams = db.scalars(select(Team).where(Team.owner_user_id == user.id)).all()
        counts["teams"] = len(owned_teams)
        for team in owned_teams:
            for member in db.scalars(
                select(TeamMember).where(TeamMember.team_id == team.id)
            ).all():
                db.delete(member)
            invite = db.scalar(select(TeamInvite).where(TeamInvite.team_id == team.id))
            if invite is not None:
                db.delete(invite)
            db.delete(team)
        counts["team_memberships"] = len(
            db.scalars(select(TeamMember).where(TeamMember.user_id == user.id)).all()
        )
        for row in db.scalars(
            select(TeamMember).where(TeamMember.user_id == user.id)
        ).all():
            db.delete(row)

        db.delete(user)
        db.commit()
    except Exception:
        # Nothing partial survives: the content delete is in this transaction too.
        db.rollback()
        raise

    response.delete_cookie(settings.session_cookie_name, path="/")
    return {"deleted": counts}
