"""Train's projection over a repertoire tree: the owner's per-node mastery and
the health badge the Library caches.

The Build tree payload carries none of this. The Build view reads the mastery
on its own (``/api/train/mastery``), and tree writes keep the cached badge
current through ``services.workflows``. Only the owner's progress colours a
tree, so there is nothing here to redact for anyone else: they never get it.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, Optional

from prepforge_chess.core.models import Repertoire
from prepforge_chess.services.progress import compute_health, mastery_map
from prepforge_chess.storage.ports import TrainingColourStore


def owner_training_colour(
    store: TrainingColourStore,
    repertoire: Repertoire,
    revision: Optional[int],
    owner_user_id: str,
) -> Dict[str, str]:
    """Per-node mastery against the owner's progress, keyed by node id. Refreshes
    the owner's cached health badge off the same walk when it moved.

    Uses only the tree's shape (no SAN/FEN), so a structurally loaded tree gives
    the same answer as a hydrated one."""
    progress_by_id = {
        p.node_id: p
        for p in store.list_training_progress(repertoire.id, owner_user_id=owner_user_id)
    }
    mastery = mastery_map(repertoire.root_node, repertoire.color, progress_by_id)
    health = compute_health(repertoire.root_node, repertoire.color, progress_by_id, states=mastery)
    # D-01: the cache records computed_at + tree revision so readers can tell how
    # fresh the static numbers are; time-dependent numbers (due) are recomputed
    # live wherever they are displayed (see repository.due_counts_by_repertoire).
    cached = getattr(repertoire, "_cached_health", None) or {}
    cached_static = {k: v for k, v in cached.items() if k not in ("computed_at", "revision")}
    if cached_static != health.to_dict() or cached.get("revision") != revision:
        health_data = dict(health.to_dict())
        health_data["computed_at"] = datetime.now(timezone.utc).isoformat()
        health_data["revision"] = revision
        store.set_repertoire_health(
            repertoire.id, health_data,
            expected_cache=getattr(repertoire, "_cached_health", None), cache_snapshot=True,
        )
        repertoire._cached_health = health_data
    return mastery


def repertoire_mastery(
    store: TrainingColourStore, repertoire_id: str, owner_user_id: str
) -> Dict[str, Any]:
    """The Build view's training overlay: ``{repertoire_id, revision, mastery}``,
    where ``mastery`` maps each own-side node id to its state. Raises
    ``ValueError`` if the repertoire does not exist."""
    revision = store.repertoire_reply_revision(repertoire_id)
    repertoire = store.load_repertoire(repertoire_id, hydrate=False)
    if repertoire is None:
        raise ValueError("repertoire not found: {0}".format(repertoire_id))
    return {
        "repertoire_id": repertoire.id,
        "revision": revision,
        "mastery": owner_training_colour(store, repertoire, revision, owner_user_id),
    }
