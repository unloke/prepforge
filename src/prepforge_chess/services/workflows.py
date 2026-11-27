"""Application services: the named places where one domain's change reaches another.

Each function here is a workflow that spans stores (repertoire tree, training,
settings, sharing) on ONE transaction from the shared unit of work, so the
atomicity of the old repository methods is unchanged. Storage modules no longer
reach across domains themselves; when a tree write must touch training state,
it happens here, under a name that says so.
"""
from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from fsrs import Rating

from prepforge_chess.core.models import Color, Repertoire, TrainingProgress
from prepforge_chess.services.lichess_fetch import GameMatchSummary, determine_user_color
from prepforge_chess.services.srs import review
from prepforge_chess.services.training_colour import owner_training_colour
from prepforge_chess.services.workspace_view import build_workspace_payload
from prepforge_chess.storage.ports import (
    BuildStore, MissStore, RepertoireReader, RevertStore, TrainingColourStore,
)
from prepforge_chess.storage.repositories.repertoires import ROLE_RANK

# ----------------------------------------------------------------- Build payload


def build_payload_for_viewer(
    store: RepertoireReader, meta: Dict[str, Any], **kwargs: Any
) -> Dict[str, Any]:
    """The Build tree payload as the caller may see it: the tree plus the caller's
    ``role``, whether they may write, and ``shared`` when it isn't theirs. The tree
    holds nothing personal, so sharing redacts nothing here; the owner's training
    colour is a separate read (``training_colour``) that only the owner gets."""
    payload = build_workspace_payload(store, meta["id"], **kwargs)
    payload["role"] = meta["role"]
    payload["writable"] = ROLE_RANK[meta["role"]] >= ROLE_RANK["edit"]
    if meta["role"] != "owner":
        payload["shared"] = True
    return payload


def refresh_health_badge_after_tree_edit(
    store: TrainingColourStore, meta: Dict[str, Any], repertoire: Optional[Repertoire] = None
) -> None:
    """A tree edit changes what the owner has to train, so the owner's cached
    Library badge is recomputed against the owner's progress, whoever edited.
    ``repertoire`` is the tree the edit left, when the caller already holds it."""
    repertoire = repertoire or store.load_repertoire(meta["id"], hydrate=False)
    if repertoire is None:
        return
    owner_training_colour(
        store, repertoire, store.repertoire_reply_revision(meta["id"]), meta["owner_user_id"]
    )


# ------------------------------------------------------- Tree deletes and training


def _week_ago() -> datetime:
    return datetime.now(timezone.utc) - timedelta(days=7)


def delete_repertoire_subtree_and_archive_training(
    store: BuildStore,
    repertoire_id: str,
    node_ids: List[str],
    *,
    receipt: Optional[tuple] = None,
) -> None:
    """Delete opening nodes and keep training consistent, in one transaction.

    Progress rows cascade away with their nodes, so this week's review
    timestamps move into each trainer's archive first and the dashboard's
    review count stays put; live sessions pointing at a node let go of it.
    ``receipt`` (a ``write_user_setting`` argument tuple) commits with the delete."""
    if not node_ids:
        if receipt is not None:
            with store.edit_transaction() as conn:
                store.write_user_setting(conn, *receipt)
        return
    week_ago = _week_ago()
    with store.edit_transaction() as conn:
        reviewed = store.recent_reviews_on_nodes(conn, node_ids, since=week_ago, repertoire_id=repertoire_id)
        store.release_session_cursors(conn, node_ids)
        store.remove_opening_nodes(conn, repertoire_id, node_ids)
        if receipt is not None:
            store.write_user_setting(conn, *receipt)
        store.archive_reviews(conn, reviewed, week_ago)


def delete_repertoire_and_archive_training(store: BuildStore, repertoire_id: str) -> None:
    """Delete a repertoire after moving the sessions and this week's reviews the
    dashboard counts through it into each trainer's archives, in one transaction."""
    week_ago = _week_ago()
    with store.engine.begin() as conn:
        store.archive_repertoire_training(conn, repertoire_id, week_ago)
        store.remove_repertoire(conn, repertoire_id)


def revert_repertoire_edit(store: RevertStore, repertoire_id: str, revision: int) -> None:
    """Apply the inverse of one logged edit under the repertoire's write lock.

    Nodes the inverse removes give up their training state first, exactly like a
    Build delete. Raises the store's ``EditNotFound`` / ``RevertConflict``."""
    week_ago = _week_ago()
    reviewed: List[Any] = []

    def release_training(conn, chunk: List[str]) -> None:
        reviewed.extend(store.recent_reviews_on_nodes(conn, chunk, since=week_ago))
        store.release_session_cursors(conn, chunk)

    with store.repertoire_edit(repertoire_id) as conn:
        if store.revert_op(conn, repertoire_id, revision, before_delete=release_training):
            store.archive_reviews(conn, reviewed, week_ago)


# ---------------------------------------------------------- Recall misses (Train)


def _due_now_miss(progress: TrainingProgress) -> TrainingProgress:
    # An in-session miss retries after 10 minutes; a miss from a REAL game (or one
    # spotted in Analyze) should land in the very next session, so it is due now.
    updated = review(progress, Rating.Again)
    return replace(updated, due_at=updated.last_reviewed_at)


def record_forgotten_move_as_training_miss(
    store: MissStore, repertoire_id: str, node_id: str, owner_user_id: str
) -> None:
    """One explicit "you left your prep here" miss on a node, due immediately."""
    with store.engine.begin() as conn:
        progress = store.lock_training_progress(
            conn, repertoire_id=repertoire_id, node_id=node_id, owner_user_id=owner_user_id
        )
        updated = _due_now_miss(progress)
        store.write_training_progress(
            conn, repertoire_id=repertoire_id, progress=updated, owner_user_id=owner_user_id
        )
        store.write_review(conn, owner_user_id=owner_user_id, node_id=node_id,
                           rating=Rating.Again, reviewed_at=updated.last_reviewed_at)


# Per-owner list of lichess game ids whose departure already became a training miss,
# so re-running compare on the same games never double-counts. Capped: 50 games is the
# compare fetch maximum, so 300 remembered ids is several full pages of history.
DEPARTURE_INGESTED_KEY = "lichess.departure_misses_ingested"
_DEPARTURE_INGESTED_CAP = 300


def record_game_departure_as_training_miss(
    store: MissStore,
    summaries: List[GameMatchSummary],
    *,
    owner_user_id: Optional[str] = None,
    verified_usernames: frozenset[str] = frozenset(),
) -> int:
    """Close the play→train loop: each game where the USER left their own prep is
    recorded as a recall miss on the expected repertoire node, so the smart queue
    schedules exactly the move they forgot (due within minutes; weak if repeated).

    Opponent novelties are NOT misses — there was nothing to recall. Idempotent per
    game via a per-owner ingested-ids list; marks each summary it recorded through
    ``training_recorded`` so the UI can say "added to training". Returns the count.

    Only identities verified for this authenticated owner may supply automatic
    evidence. Callers must obtain verified_usernames server-side, never from the
    request selection. Missing provenance fails closed. Filter before locking
    the ledger, since the lock helper can insert its initial row.

    Atomic: the progress write and the ingested-id ledger commit in ONE
    transaction with the ledger row locked (``lock_user_setting``). A failure
    mid-batch rolls back everything and a retry applies each game exactly once —
    the old write-then-ledger order could leave a progress miss committed while
    its ledger id was lost, so the retried compare deducted the same game again.
    """
    if owner_user_id is None:
        return 0
    verified = {name.strip().lower() for name in verified_usernames}
    summaries = [
        summary for summary in summaries
        if summary.source_account
        and summary.source_account.strip().lower() in verified
        and determine_user_color(summary.white, summary.black, summary.source_account)
        == Color(summary.user_color)
    ]
    if not summaries:
        return 0
    recorded = 0
    with store.engine.begin() as conn:
        stored = store.lock_user_setting(
            conn, owner_user_id, DEPARTURE_INGESTED_KEY, []
        )
        ingested = [str(item) for item in stored] if isinstance(stored, list) else []
        seen = set(ingested)
        updates = {}
        for summary in summaries:
            if summary.departure_reason != "user_left_preparation":
                continue
            if not (summary.lichess_id and summary.repertoire_id and summary.expected_node_id):
                continue
            if summary.lichess_id in seen:
                continue
            target = (summary.repertoire_id, summary.expected_node_id)
            if target not in updates:
                updates[target] = store.lock_training_progress(
                    conn,
                    repertoire_id=summary.repertoire_id,
                    node_id=summary.expected_node_id,
                    owner_user_id=owner_user_id,
                )
            updated = _due_now_miss(updates[target])
            updates[target] = updated
            store.write_review(conn, owner_user_id=owner_user_id, node_id=summary.expected_node_id,
                               rating=Rating.Again, reviewed_at=updated.last_reviewed_at)
            seen.add(summary.lichess_id)
            ingested.append(summary.lichess_id)
            summary.training_recorded = True
            recorded += 1
        # The locked ledger serializes this owner's ingest. Repeated misses on
        # one target need one locked read and one final write, not SQL per game.
        for (repertoire_id, _), progress in updates.items():
            store.write_training_progress(
                conn, repertoire_id=repertoire_id, progress=progress, owner_user_id=owner_user_id
            )
        if recorded:
            store.write_user_setting(
                conn,
                owner_user_id,
                DEPARTURE_INGESTED_KEY,
                ingested[-_DEPARTURE_INGESTED_CAP:],
            )
    return recorded
