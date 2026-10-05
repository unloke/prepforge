import json

from sqlalchemy import event, insert, select, update

from prepforge_chess.services.data_lifecycle import main
from prepforge_chess.services.data_lifecycle import reclaim_orphans
from prepforge_chess.services.training_smart import SmartTrainingService
from prepforge_chess.storage import sa_tables as t
from test_training_smart import _build, _claim, _repository


def test_cleanup_retains_old_receipts_and_replays_stay_exactly_once():
    repo = _repository()
    rep, _ = _build(repo)
    _claim(repo, "owner", rep)
    service = SmartTrainingService(repo, "owner")
    session = service.start_or_resume(rep.id, seed=5)
    node = service.session_card_bundle(session, rep)[0]["targets"][0]["node_id"]
    attempt = {"node_id": node, "correct": True, "attempt_uuid": "old-replay"}
    assert service.sync_progress(session.id, [attempt], owner_user_id="owner") == 1
    with repo.engine.begin() as conn:
        conn.execute(update(t.train_attempt_receipts).values(created_at="2025-01-01T00:00:00+00:00"))
    report = reclaim_orphans(repo, dry_run=False)
    assert report["before"]["expired_receipts"] == 1
    assert report["before"]["retention"]["receipt_cleanup_enabled"] is False
    assert report["deleted"]["receipts"] == 0
    assert service.sync_progress(session.id, [attempt], owner_user_id="owner") == 0
    assert repo.load_training_progress(rep.id, node, owner_user_id="owner").attempts == 1


def test_operational_cli_defaults_to_dry_run(monkeypatch, capsys):
    repo = _repository()
    with repo.engine.begin() as conn:
        conn.execute(insert(t.positions).values(fen="orphan-fen"))
    monkeypatch.setattr("prepforge_chess.api.db.make_engine", lambda: repo.engine)
    # The in-memory engine must remain alive for the two invocations.
    monkeypatch.setattr(repo.engine, "dispose", lambda: None)
    assert main([]) == 0
    dry = json.loads(capsys.readouterr().out)
    assert dry["dry_run"] is True
    assert dry["after"]["orphan_positions"] == 1
    assert main(["--apply"]) == 0
    applied = json.loads(capsys.readouterr().out)
    assert applied["deleted"]["positions"] == 1
    assert applied["after"]["orphan_positions"] == 0


def test_cleanup_deletes_are_set_based_and_keep_latest_ties():
    repo = _repository()
    with repo.engine.begin() as conn:
        conn.execute(insert(t.positions), [{"fen": f"unused-{i}"} for i in range(2000)])
        conn.execute(insert(t.analysis_results), [
            {"id": f"analysis-{i:04}", "game_id": "game", "analyzed_at": "2026-01-01",
             "engine": "mock", "summary_json": "{}", "critical_ply": ""} for i in range(20)
        ])
    statements = []

    def collect(*args):
        statements.append(args[2])

    event.listen(repo.engine, "before_cursor_execute", collect)
    try:
        assert repo.delete_orphan_positions() == 2000
        assert repo.count_trimable_analyses(10) == 10
        assert repo.delete_trimable_analyses(10) == 10
    finally:
        event.remove(repo.engine, "before_cursor_execute", collect)
    assert len(statements) == 3
    with repo.engine.connect() as conn:
        assert set(conn.scalars(select(t.analysis_results.c.id))) == {f"analysis-{i:04}" for i in range(10, 20)}
