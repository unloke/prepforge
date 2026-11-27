"""Recent repertoire activity and conflict-checked inverse edits."""
from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from prepforge_chess.api.deps import current_owner, get_repository, member_name
from prepforge_chess.api.access import require_access
from prepforge_chess.services.workflows import (
    build_payload_for_viewer, refresh_health_badge_after_tree_edit, revert_repertoire_edit,
)
from prepforge_chess.storage.repositories.collaboration import EditNotFound, RevertConflict
from prepforge_chess.storage.ports import ActivityRoutes

router = APIRouter(prefix="/api/build", tags=["activity"])


@router.get("/activity")
def activity(repertoire_id: str, owner: str = Depends(current_owner),
             repo: ActivityRoutes = Depends(get_repository)):
    meta = require_access(repo, repertoire_id, owner)
    seen = repo.get_user_setting(owner, f"activity.seen.{repertoire_id}", 0)
    rows = repo.activity_rows(repertoire_id)
    reversed_revisions = {json.loads(row["op_json"]).get("reverted_revision") for row in rows}
    entries, unread_nodes = [], set()
    for row in rows:
        op = json.loads(row["op_json"])
        unread = row["revision"] > seen and row["actor_user_id"] not in (owner, None)
        if unread:
            unread_nodes.update(op.get("nodes", []))
        delta = op.get("delta", {})
        entries.append({
            "revision": row["revision"], "kind": row["kind"],
            "actor": member_name(row["display_name"], row["email"]) if row["actor_user_id"] else "PrepForge",
            "created_at": row["created_at"].isoformat(), "unread": unread,
            "nodes": op.get("nodes", []), "removed": op.get("removed", []),
            "added": sum(change["before"] is None for change in delta.values()),
            "edited": sum(change["before"] is not None and change["after"] is not None for change in delta.values()),
            "deleted": len(op.get("removed", [])),
            "can_revert": meta["role"] == "owner" and bool(delta or op.get("metadata"))
                          and row["revision"] not in reversed_revisions,
            "reverted": row["revision"] in reversed_revisions,
            "discussion_id": op.get("discussion_id"),
        })
    return {"revision": meta["revision"], "seen": seen, "entries": entries,
            "unread_nodes": sorted(unread_nodes),
            "truncated": bool(rows and rows[-1]["revision"] > 1)}


class SeenBody(BaseModel):
    repertoire_id: str
    revision: int = Field(ge=0)


@router.post("/activity/seen")
def activity_seen(body: SeenBody, owner: str = Depends(current_owner),
                  repo: ActivityRoutes = Depends(get_repository)):
    meta = require_access(repo, body.repertoire_id, owner)
    revision = min(body.revision, meta["revision"])
    seen = repo.mutate_user_setting(owner, f"activity.seen.{body.repertoire_id}",
                                   lambda value: max(value or 0, revision))
    return {"seen": seen}


class RevertBody(SeenBody):
    pass


@router.post("/activity/revert")
def activity_revert(body: RevertBody, owner: str = Depends(current_owner),
                    repo: ActivityRoutes = Depends(get_repository)):
    meta = require_access(repo, body.repertoire_id, owner, "owner")
    repo.op_actor, repo.op_kind = owner, "revert"
    try:
        revert_repertoire_edit(repo, body.repertoire_id, body.revision)
    except EditNotFound as exc:
        raise HTTPException(404, detail=str(exc)) from exc
    except RevertConflict as exc:
        raise HTTPException(409, detail=str(exc)) from exc
    refresh_health_badge_after_tree_edit(repo, meta)
    return build_payload_for_viewer(repo, meta)
