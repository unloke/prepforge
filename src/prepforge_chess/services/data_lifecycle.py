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
* old train attempt receipts — inventoried but retained until the server
  enforces a replay horizon. A client can still replay an arbitrarily old UUID;
  deleting its receipt would allow it to score twice;
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

# Proposed windows, not currently enforced by the server or SPA. Do not enable
# receipt pruning until an authenticated replay epoch/horizon fences old clients.
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
            "receipt_days": None,
            "offline_retry_days": None,
            "receipt_cleanup_enabled": False,
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
    report: Dict[str, Any] = {
        "dry_run": dry_run,
        "deleted": {},
        "before": lifecycle_report(repository, now=now),
    }
    deleted = report["deleted"]
    if dry_run:
        deleted["evaluations"] = repository.count_orphan_evaluations()
        deleted["positions"] = repository.count_orphan_positions()
        deleted["receipts"] = 0
        if trim_analyses:
            deleted["analyses"] = repository.count_trimable_analyses(ANALYSIS_KEEP_PER_GAME)
        else:
            deleted["analyses"] = 0
    else:
        deleted["analyses"] = (
            repository.delete_trimable_analyses(ANALYSIS_KEEP_PER_GAME)
            if trim_analyses
            else 0
        )
        deleted["evaluations"] = repository.delete_orphan_evaluations()
        deleted["positions"] = repository.delete_orphan_positions()
        deleted["receipts"] = 0
    report["after"] = lifecycle_report(repository, now=now)
    return report


def main(argv: list[str] | None = None) -> int:
    """``python -m prepforge_chess.services.data_lifecycle [--apply] [--trim-analyses]``."""
    import argparse
    import json

    from prepforge_chess.api.db import make_engine
    parser = argparse.ArgumentParser(description="Inventory or reclaim unreferenced production data.")
    parser.add_argument("--apply", action="store_true", help="Apply cleanup; default is dry-run.")
    parser.add_argument("--trim-analyses", action="store_true", help="Keep the newest 10 analyses per game.")
    args = parser.parse_args(argv)
    engine = make_engine()
    try:
        report = reclaim_orphans(
            PrepForgeRepository(engine), dry_run=not args.apply, trim_analyses=args.trim_analyses
        )
        print(json.dumps(report, sort_keys=True))
    finally:
        engine.dispose()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
