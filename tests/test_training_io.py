"""Bounded SQL work for the queue and its batched saves."""
from contextlib import contextmanager

from sqlalchemy import event

from api_helpers import insert_users
from test_training_smart import _build, _repository
from prepforge_chess.api.routers.train import SmartStartBody, smart_start, smart_summary
from prepforge_chess.services.training_smart import SmartTrainingService


@contextmanager
def statements(repo):
    captured = []

    def collect(_conn, _cursor, statement, _parameters, _context, _many):
        captured.append(statement.lower())

    event.listen(repo.engine, "before_cursor_execute", collect)
    try:
        yield captured
    finally:
        event.remove(repo.engine, "before_cursor_execute", collect)


def test_mixed_start_and_preview_batch_tree_and_progress_reads():
    repo = _repository()
    insert_users(repo.engine, "t-owner")
    for _ in range(6):
        rep, _ = _build(repo)
        repo.save_repertoire(rep, owner_user_id="t-owner")
    with statements(repo) as queries:
        payload = smart_start(SmartStartBody(mixed=True), "t-owner", repo)
    assert payload["cards"]
    assert sum("from opening_nodes" in query for query in queries) == 1
    assert sum("from training_progress" in query for query in queries) == 1
    with statements(repo) as queries:
        preview = smart_summary(mixed=True, preview=True, owner="t-owner", repo=repo)
    assert preview["next_session"]["resumed"]
    assert sum("from opening_nodes" in query for query in queries) == 1
    assert sum("from training_progress" in query for query in queries) == 1
    assert not any(query.startswith(("update ", "insert ", "delete ")) for query in queries)


def test_sync_uses_node_identities_and_writes_session_once(monkeypatch):
    repo = _repository()
    rep, ids = _build(repo)
    service = SmartTrainingService(repo, "t-owner")
    session = service.start_or_resume(rep.id)

    def fail_tree_load(*_args, **_kwargs):
        raise AssertionError("a progress sync must not hydrate a repertoire tree")

    monkeypatch.setattr(repo, "load_repertoire", fail_tree_load)
    attempts = [{"node_id": ids[key], "correct": True, "attempt_uuid": f"batch-{key}"}
                for key in ("e4", "nf3", "bb5", "d4", "c4")]
    with statements(repo) as queries:
        written = SmartTrainingService(repo, "t-owner").sync_progress(
            session.id, attempts, owner_user_id="t-owner", card_index=len(session.line_order),
            queue=session.line_order, state_version=session.state_version,
            session_generation=session.created_at.isoformat(),
        )
    assert written == 5
    assert sum(query.startswith("insert into training_sessions") for query in queries) == 1
    assert sum("from train_attempt_receipts" in query for query in queries) == 1
    assert all(repo.load_training_progress(rep.id, item["node_id"], owner_user_id="t-owner").attempts == 1
               for item in attempts)
