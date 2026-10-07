"""Regression cases for analysis snapshots and transactional training state."""
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import os
import uuid

import pytest
from sqlalchemy import create_engine, update

from prepforge_chess.core.chess_core import ChessCore
from prepforge_chess.core.models import AnalysisResult, MoveClassification
from prepforge_chess.services.progress import compute_health
from prepforge_chess.services.training import TrainingService
from prepforge_chess.services.training_smart import SmartTrainingService
from prepforge_chess.storage.database import apply_schema, connect_database
from prepforge_chess.storage.repositories.workspace import WorkspaceRepository
from prepforge_chess.storage import sa_tables as t
from test_training_smart import _build, _mastered, _seed_progress


@pytest.fixture(params=["sqlite", "postgres"])
def repo(request, tmp_path):
    if request.param == "sqlite":
        engine = connect_database(tmp_path / "regression.sqlite3")
        apply_schema(engine)
        try:
            yield WorkspaceRepository(engine)
        finally:
            engine.dispose()
        return
    url = os.getenv("TEST_POSTGRES_URL")
    if not url:
        pytest.skip("TEST_POSTGRES_URL requires a real PostgreSQL server")
    url = url.replace("postgresql://", "postgresql+psycopg://", 1)
    schema = "consistency_" + uuid.uuid4().hex[:16]
    admin = create_engine(url, isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        conn.exec_driver_sql(f'CREATE SCHEMA "{schema}"')
    engine = create_engine(url, connect_args={"options": "-c search_path=" + schema})
    try:
        t.metadata.create_all(engine)
        yield WorkspaceRepository(engine)
    finally:
        engine.dispose()
        with admin.connect() as conn:
            conn.exec_driver_sql(f'DROP SCHEMA "{schema}" CASCADE')
        admin.dispose()


@pytest.mark.parametrize("batched", [True, False])
def test_analysis_late_old_save_keeps_latest_summary_and_moves_together(repo, batched):
    game = ChessCore().import_single_pgn('[Result "*"]\n\n1. e4 *')
    old = deepcopy(game)
    game.moves[0].classification = MoveClassification.BEST
    old.moves[0].classification = MoveClassification.BLUNDER
    now = datetime.now(timezone.utc)
    latest = AnalysisResult(game.id, now, "engine", 12, game.moves, {"best": 1})
    earlier = AnalysisResult(game.id, now - timedelta(minutes=1), "engine", 12,
                             old.moves, {"blunder": 1})
    for saved_game, result in [(game, latest), (old, earlier)]:
        if batched:
            repo.save_game_batched(saved_game, result, owner_user_id="owner")
        else:
            repo.save_game(saved_game, owner_user_id="owner")
            repo.save_analysis_result(result)
    loaded = repo.load_latest_analysis_result(game.id, owner_user_id="owner")
    assert loaded.summary == {"best": 1}
    assert loaded.move_results[0].classification is MoveClassification.BEST


def test_health_cache_rejects_stale_revision_and_older_computation(repo):
    rep, _ = _build(repo)
    current = repo.repertoire_revision(rep.id)
    latest = {"revision": current, "computed_at": "2026-10-04T12:00:00+00:00", "trainable": 5}
    repo.set_repertoire_health(rep.id, latest)
    repo.set_repertoire_health(rep.id, {**latest, "revision": current - 1, "trainable": 1})
    repo.set_repertoire_health(rep.id, {**latest, "computed_at": "2026-10-04T11:00:00+00:00", "trainable": 2})
    with repo.engine.connect() as conn:
        import json
        stored = conn.scalar(t.repertoires.select().with_only_columns(
            t.repertoires.c.health_json).where(t.repertoires.c.id == rep.id))
        assert json.loads(stored) == latest


def test_maximum_batch_receipt_round_trips_beyond_4000_characters(repo):
    mapping = {"tmp-" + str(i) + "-" + "a" * 32: uuid.uuid4().hex for i in range(500)}
    value = {"id_map": mapping}
    repo.set_user_setting("owner", "build-receipt:boundary", value)
    assert repo.get_user_setting("owner", "build-receipt:boundary") == value


def test_real_maximum_move_batch_commits_full_receipt(repo):
    import json
    from collections import deque
    from prepforge_chess.services.opening_builder import OpeningBuilderService
    from prepforge_chess.core.limits import MAX_ADD_MOVES_BATCH

    rep, _ = _build(repo)
    core = ChessCore()
    parents = deque([(rep.root_node.id, rep.root_fen)])
    changes = []
    while len(changes) < MAX_ADD_MOVES_BATCH:
        parent, fen = parents.popleft()
        for uci in core.legal_moves(fen):
            temp = "tmp-batch-" + str(len(changes)) + "-" + "a" * 32
            move = core.apply_uci(fen, uci)
            changes.append({"tempId": temp, "parentRef": parent, "uci": uci})
            parents.append((temp, move.fen_after))
            if len(changes) == MAX_ADD_MOVES_BATCH:
                break
    key = "build-receipt:max-batch-real"
    _, _, mapping = OpeningBuilderService(repo).add_moves_batch(
        rep.id, changes, receipt_target=("owner", key))
    assert len(mapping) == MAX_ADD_MOVES_BATCH
    receipt = repo.get_user_setting("owner", key)
    assert len(json.dumps(receipt)) > 4000
    assert receipt["id_map"] == mapping
    loaded = repo.load_repertoire(rep.id)
    assert loaded is not None
    with repo.engine.connect() as conn:
        stored_ids = set(conn.scalars(sa_select_node_ids(rep.id)))
    assert set(mapping.values()).issubset(stored_ids)


def sa_select_node_ids(rep_id):
    from sqlalchemy import select
    return select(t.opening_nodes.c.id).where(t.opening_nodes.c.repertoire_id == rep_id)


def test_concurrent_primary_changes_keep_one_account(repo):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier
    from sqlalchemy import select
    from sqlalchemy.orm import Session
    from prepforge_chess.api.models import LinkedAccount, User
    from prepforge_chess.storage.sa_tables import metadata
    from prepforge_chess.api.routers.lichess import SetPrimaryBody, set_primary

    metadata.create_all(repo.engine)
    owner = uuid.uuid4().hex
    account_ids = [uuid.uuid4().hex for _ in range(2)]
    with Session(repo.engine) as db:
        db.add(User(id=owner, email=owner + "@example.test"))
        db.flush()
        for i, account_id in enumerate(account_ids):
            db.add(LinkedAccount(id=account_id, user_id=owner, provider="lichess",
                                 provider_user_id=owner + str(i), is_primary=i == 0))
        db.commit()
    barrier = Barrier(2)

    def change(account_id):
        with Session(repo.engine) as db:
            user = db.get(User, owner)
            barrier.wait(timeout=10)
            set_primary(SetPrimaryBody(account_id=account_id), user, db)

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(change, account_id) for account_id in account_ids]
        for future in futures:
            future.result(timeout=30)
    with Session(repo.engine) as db:
        links = list(db.scalars(select(LinkedAccount).where(LinkedAccount.user_id == owner)))
        assert len(links) == 2
        assert sum(link.is_primary for link in links) == 1


def test_sync_replayed_old_state_does_not_regress_position_or_queue(repo):
    rep, ids = _build(repo)
    service = SmartTrainingService(repo, "t-owner")
    session = service.start_or_resume(rep.id, seed=5)
    first = [{"node_id": ids["e4"], "correct": True, "attempt_uuid": "first"}]
    second = [{"node_id": ids["d4"], "correct": True, "attempt_uuid": "second"}]
    assert service.sync_progress(session.id, first, card_index=1,
                                 state_version=session.state_version,
                                 owner_user_id="t-owner") == 1
    queue = session.line_order + [session.line_order[0]]
    assert service.sync_progress(session.id, second, card_index=2, queue=queue,
                                 state_version=repo.load_training_session(session.id).state_version,
                                 owner_user_id="t-owner") == 1
    assert service.sync_progress(session.id, first, card_index=1,
                                 state_version=session.state_version,
                                 queue=session.line_order, owner_user_id="t-owner") == 0
    stored = repo.load_training_session(session.id)
    assert stored.current_index == 2
    assert stored.line_order == queue


@pytest.mark.parametrize("smart", [True, False])
@pytest.mark.parametrize("target", ["write_training_session", "write_training_progress"])
def test_move_failure_rolls_back_progress_and_session(repo, monkeypatch, smart, target):
    rep, _ = _build(repo)
    service = SmartTrainingService(repo, "t-owner") if smart else TrainingService(repo, "t-owner")
    session = (service.start_or_resume(rep.id, seed=5) if smart
               else service.start_or_resume_session(rep.id, seed=5))
    prompt = service.current_prompt(session.id)
    before = repo.load_training_session(session.id)

    def fail(*args, **kwargs):
        raise RuntimeError("injected second write failure")

    # Fail either write: progress and session must both remain unchanged.
    with monkeypatch.context() as patch:
        patch.setattr(repo, target, fail)
        with pytest.raises(RuntimeError, match="injected"):
            service.submit_move(session.id, prompt.expected_move_uci)
    progress = repo.load_training_progress(rep.id, prompt.expected_node_id, owner_user_id="t-owner")
    assert progress is None or progress.attempts == 0
    assert repo.load_training_session(session.id) == before
    service.submit_move(session.id, prompt.expected_move_uci)
    assert repo.load_training_progress(rep.id, prompt.expected_node_id,
                                       owner_user_id="t-owner").attempts == 1


def test_expired_mastery_listing_recomputes_all_categories(repo):
    rep, ids = _build(repo)
    repo.claim_repertoire(rep.id, "t-owner")
    progress = _mastered(ids["e4"])
    _seed_progress(repo, rep.id, [progress])
    cached = compute_health(rep.root_node, rep.color, {progress.node_id: progress})
    assert cached.mastery_pct == 20
    repo.set_repertoire_health(rep.id, cached.to_dict())
    progress.due_at = datetime.now(timezone.utc) - timedelta(seconds=1)
    _seed_progress(repo, rep.id, [progress])
    live = compute_health(rep.root_node, rep.color, {progress.node_id: progress}).to_dict()
    listed = repo.list_owner_repertoire_listings("t-owner")[0]["health"]
    assert sum(listed[k] for k in ["mastered", "learning", "due", "weak", "untrained"]) == 5
    assert listed["mastery_pct"] == live["mastery_pct"] == 0
    for key in live:
        assert listed[key] == live[key]


def test_stale_sync_merges_new_attempts_without_overwriting_state(repo):
    rep, ids = _build(repo)
    service = SmartTrainingService(repo, "t-owner")
    session = service.start_or_resume(rep.id, seed=5)
    service.sync_progress(session.id, [], card_index=2, state_version=session.state_version)
    before = repo.load_training_session(session.id)
    assert service.sync_progress(session.id, [{"node_id": ids["e4"], "correct": False,
                                               "attempt_uuid": "delayed"}], card_index=0,
                                 queue=[], state_version=session.state_version,
                                 owner_user_id="t-owner") == 1
    stored = repo.load_training_session(session.id)
    assert stored.current_index == before.current_index
    assert stored.line_order == before.line_order
    assert ids["e4"] in stored.mistakes
    assert service.sync_state_applied is False


def test_unversioned_sync_cannot_overwrite_state(repo):
    rep, _ = _build(repo)
    service = SmartTrainingService(repo, "t-owner")
    session = service.start_or_resume(rep.id, seed=5)
    service.sync_progress(session.id, [], card_index=1, queue=[])
    assert repo.load_training_session(session.id) == session
    assert service.sync_state_applied is False


@pytest.mark.parametrize("smart", [True, False])
def test_concurrent_move_attempts_keep_every_score(repo, smart):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    rep, _ = _build(repo)
    cls = SmartTrainingService if smart else TrainingService
    service = cls(repo, "t-owner")
    session = (service.start_or_resume(rep.id, seed=5) if smart
               else service.start_or_resume_session(rep.id, seed=5))
    prompt = service.current_prompt(session.id)
    barrier = Barrier(4)

    def submit():
        barrier.wait(timeout=10)
        cls(WorkspaceRepository(repo.engine), "t-owner").submit_move(session.id, "a1a2")

    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = [pool.submit(submit) for _ in range(4)]
        for future in futures:
            future.result(timeout=30)
    progress = repo.load_training_progress(rep.id, prompt.expected_node_id, owner_user_id="t-owner")
    assert progress.attempts == 4
    assert progress.correct_attempts == 0
    assert prompt.expected_node_id in repo.load_training_session(session.id).mistakes


def test_concurrent_sync_accepts_only_one_state_version(repo):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    rep, ids = _build(repo)
    service = SmartTrainingService(repo, "t-owner")
    session = service.start_or_resume(rep.id, seed=5)
    barrier = Barrier(2)

    def sync(index):
        local = SmartTrainingService(WorkspaceRepository(repo.engine), "t-owner")
        barrier.wait(timeout=10)
        written = local.sync_progress(session.id, [{"node_id": ids["e4"], "correct": True,
                                                  "attempt_uuid": f"racer-{index}"}],
                                      card_index=index, state_version=session.state_version,
                                      owner_user_id="t-owner")
        return index, written, local.sync_state_applied

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(sync, i) for i in (1, 2)]
        results = [future.result(timeout=30) for future in futures]
    accepted = [index for index, _, applied in results if applied]
    assert len(accepted) == 1
    assert repo.load_training_session(session.id).current_index == accepted[0]
    assert all(written == 1 for _, written, _ in results)
    assert repo.load_training_progress(rep.id, ids["e4"], owner_user_id="t-owner").attempts == 2


def test_legacy_analysis_does_not_borrow_shared_annotations(repo):
    game = ChessCore().import_single_pgn('[Result "*"]\n\n1. e4 *')
    game.moves[0].classification = MoveClassification.BLUNDER
    result = AnalysisResult(game.id, datetime.now(timezone.utc), "engine", 12,
                            game.moves, {"best": 1})
    repo.save_game_batched(game, result)
    with repo.engine.begin() as conn:
        conn.execute(update(t.analysis_results).values(move_results_json=None))
    loaded = repo.load_latest_analysis_result(game.id)
    assert loaded.move_results == []
    assert loaded.quality["move_snapshot_missing"] is True


def test_sync_lost_response_retry_acknowledges_identical_state_without_rewriting(repo):
    rep, ids = _build(repo)
    service = SmartTrainingService(repo, "t-owner")
    session = service.start_or_resume(rep.id, seed=5)
    args = dict(card_index=1, queue=session.line_order, state_version=session.state_version,
                owner_user_id="t-owner")
    attempts = [{"node_id": ids["e4"], "correct": True, "attempt_uuid": "lost-response"}]
    assert service.sync_progress(session.id, attempts, **args) == 1
    stored = repo.load_training_session(session.id)
    assert service.sync_progress(session.id, attempts, **args) == 0
    assert service.sync_state_applied is True
    assert service.sync_state_version == stored.state_version
    assert repo.load_training_session(session.id) == stored
