"""Data lifecycle: inventory + conservative reclaim of derived rows (D-06).

Snapshot storage grows with every analysis: ``positions`` is a FEN catalog,
``engine_evaluations`` holds immutable fingerprinted snapshots, and
``train_attempt_receipts`` keep exactly-once history. This module answers
"what is referenced by what" and offers a **dry-run-first** reclaim for rows
nothing points at any more:

* orphan ``engine_evaluations`` — not referenced by any move or opening node
  (they become orphaned when games/repertoires are deleted; the shared engine
  data is deliberately NOT cascade-deleted with a user's content, because two
  owners' identical analyses can share one snapshot row);
* orphan ``positions`` — no evaluation references them (safe: a later save
  re-inserts the FEN);
* old train attempt receipts — older than ``RECEIPT_RETENTION_DAYS``, which is
  deliberately LONGER than the offline-retry window (``OFFLINE_RETRY_DAYS``):
  cleaning up must never let a replayed offline attempt score again after its
  receipt is gone;
* analysis history — optionally trimmed to the newest
  ``ANALYSIS_KEEP_PER_GAME`` per game (off unless a caller opts in).

Everything is report-first: ``lifecycle_report`` counts only,
``reclaim_orphans(dry_run=True)`` reports what WOULD go, and only
``dry_run=False`` deletes. Deleting a user's own content (games, repertoires,
progress) is a different cascade from reclaiming shared engine data — account
deletion calls :func:`prepforge_chess.storage.repositories.PrepForgeRepository.delete_owner_data`
and leaves shared snapshots for this module.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional

from prepforge_chess.storage.repositories import PrepForgeRepository

# Receipts must outlive the longest offline retry we allow (the SPA keeps its
# outbox for at most OFFLINE_RETRY_DAYS before giving up on replay), so an old
# attempt can never be re-scored after its receipt is reclaimed.
OFFLINE_RETRY_DAYS = 30
RECEIPT_RETENTION_DAYS = 90
# Analysis rows are immutable snapshots; trimming is opt-in per call site.
ANALYSIS_KEEP_PER_GAME = 10

assert RECEIPT_RETENTION_DAYS > OFFLINE_RETRY_DAYS  # noqa: S101 - contract guard


def lifecycle_report(
    repository: PrepForgeRepository,
    *,
    now: Optional[datetime] = None,
) -> Dict[str, Any]:
    """Count reclaimable rows without touching anything (the dry-run view)."""
    now = now or datetime.now(timezone.utc)
    receipt_cutoff = (now - timedelta(days=RECEIPT_RETENTION_DAYS)).isoformat()
    return {
        "orphan_evaluations": repository.count_orphan_evaluations(),
        "orphan_positions": repository.count_orphan_positions(),
        "expired_receipts": repository.count_receipts_before(receipt_cutoff),
        "analysis_snapshots": repository.count_analysis_snapshots(),
        "retention": {
            "receipt_days": RECEIPT_RETENTION_DAYS,
            "offline_retry_days": OFFLINE_RETRY_DAYS,
            "analysis_keep_per_game": ANALYSIS_KEEP_PER_GAME,
        },
        "generated_at": now.isoformat(),
    }


def reclaim_orphans(
    repository: PrepForgeRepository,
    *,
    dry_run: bool = True,
    trim_analyses: bool = False,
    now: Optional[datetime] = None,
) -> Dict[str, Any]:
    """Conservative reclaim. Dry-run (default) only reports counts.

    ``trim_analyses`` additionally drops all but the newest
    ``ANALYSIS_KEEP_PER_GAME`` analysis rows per game — an explicit opt-in,
    because analysis history is user-visible record, not just cache.
    """
    now = now or datetime.now(timezone.utc)
    receipt_cutoff = (now - timedelta(days=RECEIPT_RETENTION_DAYS)).isoformat()
    report: Dict[str, Any] = {
        "dry_run": dry_run,
        "deleted": {},
        "before": lifecycle_report(repository, now=now),
    }
    deleted = report["deleted"]
    if dry_run:
        deleted["evaluations"] = repository.count_orphan_evaluations()
        deleted["positions"] = repository.count_orphan_positions()
        deleted["receipts"] = repository.count_receipts_before(receipt_cutoff)
        if trim_analyses:
            deleted["analyses"] = repository.count_trimable_analyses(ANALYSIS_KEEP_PER_GAME)
        else:
            deleted["analyses"] = 0
    else:
        deleted["evaluations"] = repository.delete_orphan_evaluations()
        deleted["positions"] = repository.delete_orphan_positions()
        deleted["receipts"] = repository.delete_receipts_before(receipt_cutoff)
        deleted["analyses"] = (
            repository.delete_trimable_analyses(ANALYSIS_KEEP_PER_GAME)
            if trim_analyses
            else 0
        )
    report["after"] = lifecycle_report(repository, now=now)
    return report
