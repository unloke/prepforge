"""``record_departure_misses``: the play→train recall-miss recording is atomic.

Regression coverage for the non-atomic progress-write + ingested-ledger pair: a
failure between the two used to leave the miss committed while its ledger id was
lost, so the retried compare deducted the same game again. The batch must commit
all-or-nothing and count each game exactly once across failures and retries.
"""
from __future__ import annotations

import unittest.mock

import pytest

from prepforge_chess.core.models import Color
from prepforge_chess.services.engine import MockEngine
from prepforge_chess.services.lichess_fetch import (
    DEPARTURE_INGESTED_KEY,
    GameMatchSummary,
    record_departure_misses,
)
from prepforge_chess.services.opening_builder import (
    CreateRepertoireRequest,
    OpeningBuilderService,
)
from prepforge_chess.storage.database import apply_schema, connect_database
from prepforge_chess.storage.repositories import PrepForgeRepository

from stub_maia import StubMaia


def _repository():
    connection = connect_database()
    apply_schema(connection)
    return PrepForgeRepository(connection)


def _repertoire_with_target(repository):
    builder = OpeningBuilderService(repository, engine=MockEngine(), maia=StubMaia())
    repertoire = builder.create_repertoire(
        CreateRepertoireRequest(name="Prep", color=Color.WHITE)
    )
    e4 = builder.add_move(
        repertoire.id, repertoire.root_node.id, "e2e4", is_user_prepared_move=True
    )
    loaded = repository.load_repertoire(repertoire.id)
    assert loaded is not None
    return loaded, e4.id


def _summary(lichess_id, repertoire_id, node_id, reason="user_left_preparation"):
    return GameMatchSummary(
        lichess_id=lichess_id,
        white="Alice",
        black="Bob",
        result="0-1",
        user_color="white",
        in_repertoire=True,
        matched_plies=1,
        departure_ply=1,
        departure_move_uci="d7d5",
        departure_reason=reason,
        repertoire_id=repertoire_id,
        repertoire_name="Prep",
        move_san_history=["e4", "d5"],
        expected_move_uci="e2e4",
        expected_move_san="e4",
        expected_node_id=node_id,
    )


def test_record_departure_misses_counts_each_game_exactly_once():
    repository = _repository()
    repertoire, node_id = _repertoire_with_target(repository)
    owner = "miss-owner"
    summaries = [
        _summary("gameA", repertoire.id, node_id),
        _summary("gameB", repertoire.id, node_id),
    ]

    recorded = record_departure_misses(repository, summaries, owner_user_id=owner)

    assert recorded == 2
    assert [s.training_recorded for s in summaries] == [True, True]
    progress = repository.load_training_progress(repertoire.id, node_id, owner_user_id=owner)
    assert progress is not None
    assert progress.attempts == 2
    assert progress.correct_attempts == 0
    # A miss from a real game lands in the very next session (due immediately).
    assert progress.due_at == progress.last_reviewed_at
    assert repository.get_user_setting(owner, DEPARTURE_INGESTED_KEY, []) == [
        "gameA",
        "gameB",
    ]

    # Re-running compare over the same games is a no-op — no double deduction.
    again = [
        _summary("gameA", repertoire.id, node_id),
        _summary("gameB", repertoire.id, node_id),
    ]
    assert record_departure_misses(repository, again, owner_user_id=owner) == 0
    assert all(not s.training_recorded for s in again)
    assert (
        repository.load_training_progress(repertoire.id, node_id, owner_user_id=owner).attempts
        == 2
    )


def test_record_departure_misses_failure_rolls_back_and_retry_counts_once():
    """The regression: a crash between the progress write and the ledger write
    must leave NOTHING committed. The retry then applies each game exactly once
    (the old write-then-ledger order deducted the same game twice)."""
    repository = _repository()
    repertoire, node_id = _repertoire_with_target(repository)
    owner = "miss-retry-owner"

    def boom(self, conn, user_id, key, value):
        raise RuntimeError("simulated crash before the ledger write")

    with pytest.raises(RuntimeError, match="simulated crash"):
        with unittest.mock.patch.object(PrepForgeRepository, "write_user_setting", boom):
            record_departure_misses(
                repository,
                [_summary("gameC", repertoire.id, node_id)],
                owner_user_id=owner,
            )

    # Atomic: the miss did NOT survive without its ledger entry.
    assert (
        repository.load_training_progress(repertoire.id, node_id, owner_user_id=owner) is None
    )
    assert repository.get_user_setting(owner, DEPARTURE_INGESTED_KEY) is None

    retried = [_summary("gameC", repertoire.id, node_id)]
    assert record_departure_misses(repository, retried, owner_user_id=owner) == 1
    assert retried[0].training_recorded is True
    progress = repository.load_training_progress(repertoire.id, node_id, owner_user_id=owner)
    assert progress is not None
    assert progress.attempts == 1  # deducted exactly once across the retry

    assert record_departure_misses(repository, retried, owner_user_id=owner) == 0
    assert (
        repository.load_training_progress(repertoire.id, node_id, owner_user_id=owner).attempts
        == 1
    )


def test_record_departure_misses_ignores_opponent_novelties_and_unmatched():
    repository = _repository()
    repertoire, node_id = _repertoire_with_target(repository)
    owner = "miss-skip-owner"
    summaries = [
        # Opponent left prep: nothing to recall — never a miss.
        _summary("opp1", repertoire.id, node_id, reason="opponent_unprepared_branch"),
        _summary("stayed", repertoire.id, node_id, reason="game_stayed_in_preparation"),
        # User left prep but the game never matched a node — nothing to record.
        GameMatchSummary(
            lichess_id="noNode",
            white="Alice",
            black="Bob",
            result="1-0",
            user_color="white",
            in_repertoire=False,
            matched_plies=0,
            departure_ply=None,
            departure_move_uci=None,
            departure_reason="user_left_preparation",
            repertoire_id=repertoire.id,
            repertoire_name="Prep",
            move_san_history=[],
            expected_move_uci=None,
            expected_move_san=None,
            expected_node_id=None,
        ),
    ]

    assert record_departure_misses(repository, summaries, owner_user_id=owner) == 0
    assert all(not s.training_recorded for s in summaries)
    assert (
        repository.load_training_progress(repertoire.id, node_id, owner_user_id=owner) is None
    )
    assert repository.get_user_setting(owner, DEPARTURE_INGESTED_KEY, []) == []


def test_interleaved_compare_batches_never_double_count(tmp_path):
    """Deterministic interleaving: a second compare batch committing between the
    first batch's ledger read and its write must not be double-counted.

    The seam replays exactly the legacy race window — the racing batch records
    its games fully, then this batch proceeds on its stale ledger snapshot. The
    fixed flow reads the ingested-id ledger locked INSIDE its transaction (after
    the racing commit) and skips the already-recorded games; the legacy
    snapshot-then-write flow deducted them a second time."""
    engine = connect_database(tmp_path / "interleave.sqlite3")
    apply_schema(engine)
    repository = PrepForgeRepository(engine)
    repertoire, node_id = _repertoire_with_target(repository)
    owner = "miss-interleave-owner"

    raced = {"done": False}
    original_get = PrepForgeRepository.get_user_setting
    original_lock = PrepForgeRepository.lock_user_setting

    def racing_batch():
        raced["done"] = True
        return record_departure_misses(
            PrepForgeRepository(engine),
            [
                _summary("int1", repertoire.id, node_id),
                _summary("int2", repertoire.id, node_id),
            ],
            owner_user_id=owner,
        )

    def snapshot_then_race(self, user_id, key, default=None):
        # Legacy seam: ledger snapshot taken, racing batch commits, caller
        # proceeds on the stale snapshot and deducts the same games again.
        value = original_get(self, user_id, key, default)
        if key == DEPARTURE_INGESTED_KEY and not raced["done"]:
            racing_batch()
        return value

    def race_then_lock(self, conn, user_id, key, default=None):
        # Fixed seam: the racing batch commits before the ledger row is locked
        # and read inside the transaction, so its ids are seen and skipped.
        if key == DEPARTURE_INGESTED_KEY and not raced["done"]:
            racing_batch()
        return original_lock(self, conn, user_id, key, default)

    import unittest.mock

    with unittest.mock.patch.object(
        PrepForgeRepository, "get_user_setting", snapshot_then_race
    ), unittest.mock.patch.object(
        PrepForgeRepository, "lock_user_setting", race_then_lock
    ):
        main_recorded = record_departure_misses(
            repository,
            [
                _summary("int1", repertoire.id, node_id),
                _summary("int2", repertoire.id, node_id),
            ],
            owner_user_id=owner,
        )

    assert raced["done"]
    assert main_recorded == 0  # the racing batch already recorded both games
    progress = repository.load_training_progress(repertoire.id, node_id, owner_user_id=owner)
    assert progress is not None
    assert progress.attempts == 2  # exactly once per game across both batches
    assert sorted(repository.get_user_setting(owner, DEPARTURE_INGESTED_KEY, [])) == [
        "int1",
        "int2",
    ]


def test_postgres_concurrent_record_departure_misses_count_once():
    """Real PostgreSQL: racing compares must record each game exactly once — the
    locked ingested-ledger serialises the batches.

    Eight racers on purpose: the fixed code is deterministic-green (the ledger
    row lock serialises), while the unlocked read-modify-write double-counts
    under this much parallelism with near certainty."""
    import os
    import uuid
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    import sqlalchemy as sa
    from prepforge_chess.storage import sa_tables

    url = os.getenv("TEST_POSTGRES_URL")
    if not url:
        pytest.skip("TEST_POSTGRES_URL requires a real PostgreSQL server")
    if url.startswith("postgresql://"):
        url = "postgresql+psycopg://" + url[len("postgresql://"):]
    if url.startswith("postgres://"):
        url = "postgresql+psycopg://" + url[len("postgres://"):]
    schema = "miss_atomic_" + uuid.uuid4().hex[:16]
    admin = sa.create_engine(url, isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        conn.exec_driver_sql('CREATE SCHEMA "' + schema + '"')
    engine = sa.create_engine(url, connect_args={"options": "-c search_path=" + schema})
    try:
        sa_tables.metadata.create_all(engine)
        repo = PrepForgeRepository(engine)
        repertoire, node_id = _repertoire_with_target(repo)
        owner = "postgres-miss-owner"
        racers = 8
        barrier = Barrier(racers)

        def run():
            barrier.wait(timeout=10)
            return record_departure_misses(
                PrepForgeRepository(engine),
                [
                    _summary("pgA", repertoire.id, node_id),
                    _summary("pgB", repertoire.id, node_id),
                    _summary("pgC", repertoire.id, node_id),
                ],
                owner_user_id=owner,
            )

        with ThreadPoolExecutor(max_workers=racers) as pool:
            futures = [pool.submit(run) for _ in range(racers)]
            results = [future.result(timeout=60) for future in futures]
        assert sum(results) == 3, results
        progress = repo.load_training_progress(repertoire.id, node_id, owner_user_id=owner)
        assert progress is not None
        assert progress.attempts == 3  # each game deducted exactly once
        assert sorted(repo.get_user_setting(owner, DEPARTURE_INGESTED_KEY, [])) == [
            "pgA",
            "pgB",
            "pgC",
        ]
    finally:
        engine.dispose()
        with admin.connect() as conn:
            conn.exec_driver_sql('DROP SCHEMA "' + schema + '" CASCADE')
        admin.dispose()
