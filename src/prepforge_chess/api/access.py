"""The repertoire access gate every router shares.

A route that reads or changes a repertoire passes the caller through here first,
so Build, Train, discussions and activity apply one rule and one set of errors.
"""
from __future__ import annotations

from typing import Any

from fastapi import HTTPException, status

from prepforge_chess.storage.ports import AccessStore, EditGate
from prepforge_chess.storage.repositories.repertoires import ROLE_RANK

ACCESS_DENIED = {
    "copy": "The owner hasn't allowed copies of this repertoire.",
    "edit": "You can't edit this repertoire.",
    "owner": "Only the owner can do this.",
}


def require_access(
    repo: AccessStore, repertoire_id: str, user_id: str, need: str = "view"
) -> dict[str, Any]:
    """Returns the repertoire's meta with the caller's ``role`` (owner / edit /
    copy / view). 404 when the caller has no access at all (never revealing the
    repertoire), 403 when their role is below ``need``."""
    meta, role = repo.access_role(repertoire_id, user_id)
    if role is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="repertoire not found")
    if ROLE_RANK[role] < ROLE_RANK[need]:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=ACCESS_DENIED[need])
    return {**meta, "role": role}


def owned_repertoire(repo: EditGate, repertoire_id: str, owner: str) -> dict[str, Any]:
    """Owner-only actions: rename, delete, enable/disable, sharing.
    Tags the writes this request makes with their author for the op log."""
    meta = require_access(repo, repertoire_id, owner, "owner")
    repo.op_actor = owner
    return meta


def editable_repertoire(
    repo: EditGate, repertoire_id: str, user_id: str, kind: str
) -> dict[str, Any]:
    """Edit gate for tree mutations: the owner or an ``edit`` grant (404 without
    access, 403 below edit). Tags the writes this request makes with their author
    and kind for the ``repertoire_ops`` log."""
    meta = require_access(repo, repertoire_id, user_id, "edit")
    repo.op_actor = user_id
    repo.op_kind = kind
    return meta
