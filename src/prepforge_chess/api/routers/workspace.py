"""Ported workspace endpoints (Phase 2b).

The first slices of the ``web/server.py`` ``/api/*`` migration: owner-scoped data
reads (2b-1) and repertoire mutations (2b-2a) that prove the strangler pattern
end-to-end (FastAPI identity -> bridge -> SQLAlchemy repository) without the legacy
server's global ``request_lock``. Every handler is scoped by ``current_owner`` so one
user never sees or mutates another's data; mutations additionally pass through
``_owned_repertoire``, the IDOR gate (a foreign or missing repertoire is 404).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import func, select

from prepforge_chess.api.deps import current_owner, get_repository
from prepforge_chess.core.models import Color, MoveSource, OpeningNode
from prepforge_chess.services.opening_builder import (
    CreateRepertoireRequest,
    OpeningBuilderService,
)
from prepforge_chess.services.progress import compute_health
from prepforge_chess.services.repertoire_export import RepertoireExportService
from prepforge_chess.services.workspace_view import build_workspace_payload
from prepforge_chess.storage import sa_tables as t
from prepforge_chess.storage.repositories import PrepForgeRepository

router = APIRouter(prefix="/api", tags=["workspace"])


def _owned_repertoire(repo: PrepForgeRepository, repertoire_id: str, owner: str) -> dict[str, Any]:
    """Owner gate for repertoire mutations. Returns the repertoire's lightweight meta,
    or raises 404 if it is missing or owned by a different user (don't reveal another
    owner's repertoire). Unclaimed/legacy rows (``owner_user_id`` NULL) are allowed,
    mirroring the legacy ``_assert_repertoire_owner``."""
    meta = repo.repertoire_meta(repertoire_id)
    if meta is None or meta["owner_user_id"] not in (None, owner):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="repertoire not found")
    return meta

# Static next-action hints the dashboard surfaces (carried over verbatim from the
# legacy server so the existing SPA renders unchanged).
_RECOMMENDATIONS = [
    "Next action: analyze a PGN and review classifications.",
    "Next action: generate or extend one repertoire branch in Build.",
    "Next action: start a trainer session from an imported repertoire package.",
]


@router.get("/dashboard")
def dashboard(
    owner: str = Depends(current_owner),
    repo: PrepForgeRepository = Depends(get_repository),
) -> dict[str, Any]:
    """Owner-scoped counters for the home screen. Training counters reach the owner
    through repertoire ownership (the reliable link: ``training_sessions`` has no
    owner column and ``training_progress.user_profile_id`` is nullable)."""
    now_iso = datetime.now(timezone.utc).isoformat()
    reps = t.repertoires
    with repo.engine.connect() as conn:
        games = conn.execute(
            select(func.count())
            .select_from(t.games)
            .where(t.games.c.owner_user_id == owner)
        ).scalar_one()
        repertoires = conn.execute(
            select(func.count()).select_from(reps).where(reps.c.user_profile_id == owner)
        ).scalar_one()
        sessions = conn.execute(
            select(func.count())
            .select_from(t.training_sessions.join(reps, reps.c.id == t.training_sessions.c.repertoire_id))
            .where(reps.c.user_profile_id == owner)
        ).scalar_one()
        tp = t.training_progress
        joined = tp.join(reps, reps.c.id == tp.c.repertoire_id)
        open_mistakes = conn.execute(
            select(func.count())
            .select_from(joined)
            .where(tp.c.attempts > tp.c.correct_attempts, reps.c.user_profile_id == owner)
        ).scalar_one()
        due_reviews = conn.execute(
            select(func.count())
            .select_from(joined)
            .where(
                tp.c.due_at.is_not(None),
                tp.c.due_at <= now_iso,
                reps.c.user_profile_id == owner,
            )
        ).scalar_one()
    return {
        "games": games,
        "repertoires": repertoires,
        "training_sessions": sessions,
        "open_mistakes": open_mistakes,
        "due_reviews": due_reviews,
        "recommendations": _RECOMMENDATIONS,
    }


@router.get("/repertoires")
def list_repertoires(
    owner: str = Depends(current_owner),
    repo: PrepForgeRepository = Depends(get_repository),
) -> dict[str, Any]:
    """This owner's repertoires, each with a computed health summary."""
    return {
        "repertoires": [
            {
                "id": rep.id,
                "name": rep.name,
                "color": rep.color.value,
                "root_fen": rep.root_fen,
                "notes": rep.notes,
                "tags": rep.tags,
                "is_active": getattr(rep, "is_active", True),
                "health": compute_health(
                    rep.root_node,
                    rep.color,
                    {p.node_id: p for p in repo.list_training_progress(rep.id)},
                ).to_dict(),
            }
            for rep in repo.list_repertoires(owner_user_id=owner)
        ]
    }


@router.get("/build/load")
def build_load(
    repertoire_id: str,
    owner: str = Depends(current_owner),
    repo: PrepForgeRepository = Depends(get_repository),
) -> dict[str, Any]:
    """The Build-view payload for one of this owner's repertoires (read-only). Computes
    no chess — pure serialization of the stored tree + training progress."""
    _owned_repertoire(repo, repertoire_id, owner)
    return build_workspace_payload(repo, repertoire_id)


class DeleteRepertoireRequest(BaseModel):
    repertoire_id: str


@router.post("/repertoires/delete")
def delete_repertoire(
    body: DeleteRepertoireRequest,
    owner: str = Depends(current_owner),
    repo: PrepForgeRepository = Depends(get_repository),
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
    repo: PrepForgeRepository = Depends(get_repository),
) -> dict[str, Any]:
    """Toggle a repertoire's active flag (drives trainer eligibility in the SPA)."""
    meta = _owned_repertoire(repo, body.repertoire_id, owner)
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


def _load_node_or_400(
    repo: PrepForgeRepository, repertoire_id: str, node_id: str
) -> OpeningNode:
    """Load a repertoire and locate a node, raising 400 if either is missing — used by
    the toggle actions that need the node's current state. (Ownership is already
    enforced by the caller's ``_owned_repertoire`` gate.)"""
    repertoire = repo.load_repertoire(repertoire_id)
    node = _find_node(repertoire.root_node, node_id) if repertoire is not None else None
    if node is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="opening node not found: {0}".format(node_id),
        )
    return node


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
    """Slugify a repertoire name into a download-safe filename stem (mirrors legacy)."""
    return "".join(
        char if char.isalnum() or char in {"-", "_"} else "-" for char in name.lower()
    ).strip("-") or "repertoire"


class CreateRepertoireBody(BaseModel):
    name: str = ""
    color: str = "white"


@router.post("/repertoires/create")
def create_repertoire(
    body: CreateRepertoireBody,
    owner: str = Depends(current_owner),
    repo: PrepForgeRepository = Depends(get_repository),
) -> dict[str, Any]:
    """Create a new repertoire owned by the caller and return its Build payload."""
    name = body.name.strip() or "Untitled repertoire"
    try:
        color = Color(body.color)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="color must be 'white' or 'black'"
        ) from None
    builder = OpeningBuilderService(repo)
    repertoire = builder.create_repertoire(CreateRepertoireRequest(name=name, color=color))
    repo.claim_repertoire(repertoire.id, owner)
    return build_workspace_payload(
        repo, repertoire.id, selected_node_id=repertoire.root_node.id
    )


class RenameRepertoireBody(BaseModel):
    repertoire_id: str
    name: str = ""


@router.post("/build/rename")
def build_rename(
    body: RenameRepertoireBody,
    owner: str = Depends(current_owner),
    repo: PrepForgeRepository = Depends(get_repository),
) -> dict[str, Any]:
    """Rename one of the caller's repertoires and return its refreshed Build payload."""
    _owned_repertoire(repo, body.repertoire_id, owner)
    try:
        OpeningBuilderService(repo).rename_repertoire(body.repertoire_id, body.name)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    return build_workspace_payload(repo, body.repertoire_id)


class AddMoveBody(BaseModel):
    repertoire_id: str
    parent_node_id: str
    move_uci: str


@router.post("/build/add-move")
def build_add_move(
    body: AddMoveBody,
    owner: str = Depends(current_owner),
    repo: PrepForgeRepository = Depends(get_repository),
) -> dict[str, Any]:
    """Append a manual move under a parent node and return the refreshed Build payload.
    Mirrors the legacy classification: a move played on the owner's turn is flagged
    ``prepared``; the first enabled child of a parent becomes the mainline."""
    _owned_repertoire(repo, body.repertoire_id, owner)
    repertoire = repo.load_repertoire(body.repertoire_id)
    if repertoire is None:  # gate passed but row vanished — treat as not found
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="repertoire not found")
    parent = _find_node(repertoire.root_node, body.parent_node_id)
    if parent is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="opening node not found: {0}".format(body.parent_node_id),
        )
    is_prepared = parent.side_to_move is repertoire.color
    is_mainline = not any(child.is_enabled for child in parent.children)
    try:
        node = OpeningBuilderService(repo).add_move(
            body.repertoire_id,
            body.parent_node_id,
            body.move_uci,
            source=MoveSource.MANUAL,
            is_mainline=is_mainline,
            is_user_prepared_move=is_prepared,
            tags=["prepared"] if is_prepared else [],
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    return build_workspace_payload(
        repo,
        body.repertoire_id,
        selected_node_id=node.id,
        summary={"added_nodes": 1, "updated_nodes": 0, "high_probability_unprepared": 0},
    )


# ---- Build generate: apply-plan (2b-2d-ii) ----------------------------------
# The browser ran the whole generation recursion locally (Stockfish + Maia3 in
# WebAssembly) and submits a tree-mutation plan; the server runs NO engine. It
# re-validates every move's legality + parentage, RECOMPUTES the persisted flags
# itself (never trusting the client), and persists all-or-nothing. The legacy
# *server-engine* variants (`/api/build/generate`, `/start`, `/cancel`, `/status`)
# are deliberately dropped — they require a server-side Stockfish/Maia the SaaS
# deploy doesn't run ("the server stores data, never computes chess").


class ApplyPlanBody(BaseModel):
    repertoire_id: str
    root_node_id: str
    plan: dict[str, Any] | None = None


@router.post("/build/generate/apply-plan")
def build_apply_plan(
    body: ApplyPlanBody,
    owner: str = Depends(current_owner),
    repo: PrepForgeRepository = Depends(get_repository),
) -> dict[str, Any]:
    """Apply a browser-built Build-Generate plan and return the refreshed payload.

    No compute: the service re-validates legality + parentage and recomputes the
    persisted flags itself, so a malformed plan raises ``ValueError`` → 400 before
    anything lands. Owner-gated so a user can't apply a plan onto another's tree."""
    if not isinstance(body.plan, dict):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="plan must be an object")
    _owned_repertoire(repo, body.repertoire_id, owner)
    try:
        _repertoire, summary = OpeningBuilderService(repo).apply_generation_plan(
            body.repertoire_id, body.root_node_id, body.plan
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    return build_workspace_payload(
        repo,
        body.repertoire_id,
        selected_node_id=body.root_node_id,
        summary={
            "added_nodes": summary.added_nodes,
            "updated_nodes": summary.updated_nodes,
            "high_probability_unprepared": summary.high_probability_unprepared,
        },
    )


# ---- Build node actions / annotations / export (2b-2e) ----------------------
# The last SPA Build mutations living only in the legacy server. All are pure
# data ops on the stored tree (no engine), so they run on the Maia-free builder.
# Owner-gated via `_owned_repertoire`; the node-action/annotation handlers return
# the shared Build payload, export returns a downloadable blob.


class NodeActionBody(BaseModel):
    repertoire_id: str
    node_id: str
    action: str
    value: str | None = None


@router.post("/build/action")
def build_action(
    body: NodeActionBody,
    owner: str = Depends(current_owner),
    repo: PrepForgeRepository = Depends(get_repository),
) -> dict[str, Any]:
    """Apply a node action (set-mainline / toggle-prepared / toggle-branch / delete /
    comment / tag / queue / critical) and return the refreshed Build payload. Mirrors
    the legacy ``build_node_action_payload``; toggles read the node's current state."""
    _owned_repertoire(repo, body.repertoire_id, owner)
    builder = OpeningBuilderService(repo)
    action = body.action
    selected_node_id: str | None = body.node_id
    try:
        if action == "set_mainline":
            builder.set_as_mainline(body.repertoire_id, body.node_id)
        elif action == "mark_prepared":
            node = _load_node_or_400(repo, body.repertoire_id, body.node_id)
            builder.mark_prepared(body.repertoire_id, body.node_id, not node.is_user_prepared_move)
        elif action == "disable_branch":
            node = _load_node_or_400(repo, body.repertoire_id, body.node_id)
            if node.is_enabled:
                builder.disable_branch(body.repertoire_id, body.node_id)
            else:
                builder.enable_branch(body.repertoire_id, body.node_id)
        elif action == "delete":
            selected_node_id = builder.delete_node(body.repertoire_id, body.node_id)
        elif action == "add_comment":
            builder.add_comment(body.repertoire_id, body.node_id, body.value or "")
        elif action == "add_tag":
            if not body.value:
                raise ValueError("tag is required")
            builder.add_tag(body.repertoire_id, body.node_id, body.value)
        elif action == "add_training_queue":
            builder.add_tag(body.repertoire_id, body.node_id, "training-queue")
        elif action == "mark_critical":
            builder.add_tag(body.repertoire_id, body.node_id, "critical")
        else:
            raise ValueError("unsupported node action: {0}".format(action))
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    return build_workspace_payload(repo, body.repertoire_id, selected_node_id=selected_node_id)


class AnnotationsBody(BaseModel):
    repertoire_id: str
    node_id: str
    arrows: list[str] = []
    circles: list[str] = []


@router.post("/build/annotations")
def build_annotations(
    body: AnnotationsBody,
    owner: str = Depends(current_owner),
    repo: PrepForgeRepository = Depends(get_repository),
) -> dict[str, Any]:
    """Persist a node's arrows/circles and echo them back (the SPA ignores the rest of
    a Build payload here, so no full reserialization)."""
    _owned_repertoire(repo, body.repertoire_id, owner)
    try:
        OpeningBuilderService(repo).set_annotations(
            body.repertoire_id, body.node_id, body.arrows, body.circles
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    return {"node_id": body.node_id, "arrows": list(body.arrows), "circles": list(body.circles)}


class ExportBody(BaseModel):
    repertoire_id: str
    format: str
    node_id: str | None = None


@router.post("/build/export")
def build_export(
    body: ExportBody,
    owner: str = Depends(current_owner),
    repo: PrepForgeRepository = Depends(get_repository),
) -> dict[str, Any]:
    """Serialize a repertoire to a downloadable blob: ``json`` (full package) or
    ``pgn`` (mainline, or the path to ``node_id`` when given). Pure serialization."""
    _owned_repertoire(repo, body.repertoire_id, owner)
    repertoire = repo.load_repertoire(body.repertoire_id)
    if repertoire is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="repertoire not found")
    exporter = RepertoireExportService()
    safe_name = _safe_filename(repertoire.name)
    if body.format == "json":
        content = exporter.export_package_json(repertoire)
        filename = "{0}.prepforge.json".format(safe_name)
        mime = "application/json"
    elif body.format == "pgn":
        content = (
            exporter.export_node_path_pgn(repertoire, body.node_id)
            if body.node_id
            else exporter.export_mainline_pgn(repertoire)
        )
        filename = "{0}.pgn".format(safe_name)
        mime = "application/x-chess-pgn"
    else:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="unsupported export format: {0}".format(body.format),
        )
    return {"filename": filename, "mime": mime, "content": content}


@router.get("/repertoires/export-pgn")
def export_tree_pgn(
    repertoire_id: str,
    owner: str = Depends(current_owner),
    repo: PrepForgeRepository = Depends(get_repository),
) -> dict[str, Any]:
    """Full tree-with-variations PGN for the top-level "Export PGN" action (the SPA's
    per-line export goes through ``/build/export``). Pure serialization, owner-gated."""
    _owned_repertoire(repo, repertoire_id, owner)
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
    package_json: str = ""


@router.post("/repertoires/import")
def import_repertoire(
    body: ImportPackageBody,
    owner: str = Depends(current_owner),
    repo: PrepForgeRepository = Depends(get_repository),
) -> dict[str, Any]:
    """Import a repertoire from a saved ``.prepforge.json`` package, owned by the caller."""
    if not body.package_json.strip():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="repertoire package is empty")
    try:
        repertoire = RepertoireExportService().import_package_json(body.package_json)
    except (ValueError, KeyError) as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    _reassign_ids(repertoire)  # fresh ids → importer's own copy, no cross-tenant clobber
    repo.save_repertoire(repertoire, owner_user_id=owner)
    return build_workspace_payload(
        repo,
        repertoire.id,
        selected_node_id=repertoire.root_node.id,
        summary={
            "added_nodes": sum(1 for _ in _walk_nodes(repertoire.root_node)),
            "updated_nodes": 0,
            "high_probability_unprepared": 0,
        },
    )


class ImportPgnBody(BaseModel):
    pgn: str = ""
    name: str = "Imported"
    color: str = "white"


@router.post("/repertoires/import-pgn")
def import_repertoire_pgn(
    body: ImportPgnBody,
    owner: str = Depends(current_owner),
    repo: PrepForgeRepository = Depends(get_repository),
) -> dict[str, Any]:
    """Import a repertoire from a tree PGN (variations become branches), owned by the caller."""
    try:
        color = Color(body.color)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="color must be 'white' or 'black'"
        ) from None
    try:
        repertoire = RepertoireExportService().import_tree_pgn(body.pgn, name=body.name, color=color)
    except (ValueError, KeyError) as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    repo.save_repertoire(repertoire, owner_user_id=owner)
    return build_workspace_payload(
        repo, repertoire.id, selected_node_id=repertoire.root_node.id
    )
