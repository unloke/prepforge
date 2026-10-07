from prepforge_chess.core.models import EngineEvaluation
from prepforge_chess.services.classification import evaluation_to_white_win_chance
from prepforge_chess.core.limits import MAX_SYNC_QUEUE
from prepforge_chess.services.training_smart import SmartTrainingService
from prepforge_chess.services.scheduler import decode_card, own_move_nodes_on, path_to_node
from test_training_smart import _build, _claim, _due, _repository, _seed_progress
from test_api_analyze import _register, _prepare, _classify_save
import pytest


def test_terminal_mate_zero_uses_signed_white_score():
    for cp in (-100000, 100000):
        evaluation = EngineEvaluation(engine="test", depth=0, score_cp=cp, mate_in=0)
        chance = evaluation_to_white_win_chance(evaluation)
        assert chance < 0.03 if cp < 0 else chance > 0.97


def test_mixed_budget_caps_targets_and_new_moves_globally():
    repository = _repository()
    reps = [_build(repository)[0] for _ in range(7)]
    _claim(repository, "budget-owner", *reps)
    service = SmartTrainingService(repository, "budget-owner")
    def targets(session):
        total = 0
        for raw in session.line_order:
            card = decode_card(raw)
            rep = repository.load_repertoire(card.repertoire_id)
            nodes = own_move_nodes_on(path_to_node(rep.root_node, card.last_target_id), rep.color)
            first = next(i for i, node in enumerate(nodes) if node.id == card.first_target_id)
            total += len(nodes[first:])
        return total
    session = service.start_or_resume_mixed(
        "budget-owner", fresh=True, session_size=12, new_cap=12, seed=5
    )
    assert targets(session) <= 12
    assert service.counts(session)["new"] <= 12
    for rep in reps:
        _seed_progress(repository, rep.id,
                       [_due(n.id) for n in repository._walk_nodes(rep.root_node)
                        if n.is_user_prepared_move], owner="budget-owner")
    session = service.start_or_resume_mixed(
        "budget-owner", fresh=True, session_size=3, new_cap=0, seed=5
    )
    assert targets(session) <= 3
    assert service.counts(session)["new"] == 0


def test_sync_oversized_queue_is_rejected_before_any_attempt_is_written():
    repository = _repository()
    rep, ids = _build(repository)
    service = SmartTrainingService(repository, "queue-owner")
    session = service.start_or_resume(rep.id, seed=1)
    with pytest.raises(ValueError, match="queue too long"):
        service.sync_progress(
            session.id,
            [{"node_id": ids["e4"], "correct": True, "attempt_uuid": "oversized"}],
            queue=[session.line_order[0]] * (MAX_SYNC_QUEUE + 1),
            owner_user_id="queue-owner",
        )
    assert repository.list_training_progress(rep.id, owner_user_id="queue-owner") == []
    assert repository.get_attempt_receipt(session.id, "oversized") is None


def test_duplicate_fen_with_conflicting_scores_is_rejected(client):
    _register(client, "duplicate@example.com")
    prepared = _prepare(client)
    positions = [{"depth": 10, "fen": f, "score_cp": 20} for f in prepared["positions"]]
    positions.append({"depth": 10, "fen": prepared["positions"][0], "score_cp": -900})
    response = _classify_save(client, prepared, positions=positions)
    assert response.status_code == 400, response.text
    assert client.get("/api/analyses").json()["analyses"] == []


def test_equivalent_fen_spellings_with_identical_scores_are_accepted(client):
    _register(client, "alias@example.com")
    prepared = _prepare(client)
    positions = [{"depth": 10, "fen": f, "score_cp": 20} for f in prepared["positions"]]
    fields = prepared["positions"][1].split()
    fields[3] = "e3"
    positions.append({"depth": 10, "fen": " ".join(fields), "score_cp": 20})
    response = _classify_save(client, prepared, positions=positions)
    assert response.status_code == 200, response.text


def test_parallel_build_writers_cannot_both_commit_the_same_revision(client, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier
    from fastapi.testclient import TestClient
    from api_helpers import csrf_headers
    from prepforge_chess.api.routers import workspace

    _register(client, "race@example.com")
    headers = csrf_headers(client)
    created = client.post("/api/repertoires/create", headers=headers,
                          json={"name": "Before", "color": "white"}).json()
    barrier = Barrier(2)
    check = workspace._check_base_revision
    def simultaneous_check(*args):
        check(*args)
        barrier.wait(timeout=5)
    monkeypatch.setattr(workspace, "_check_base_revision", simultaneous_check)
    def rename(name):
        with TestClient(client.app) as tab:
            tab.cookies.update(client.cookies)
            return tab.post("/api/build/rename", headers=headers, json={
                "repertoire_id": created["repertoire_id"], "name": name,
                "base_revision": created["revision"],
            })
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(rename, ["Tab A", "Tab B"]))
    assert sorted(r.status_code for r in results) == [200, 409]
    loaded = client.get("/api/build/load", params={"repertoire_id": created["repertoire_id"]}).json()
    assert loaded["revision"] == created["revision"] + 1


def test_parallel_password_resets_consume_a_link_only_once(client, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier
    from fastapi.testclient import TestClient
    from api_helpers import csrf_headers
    from prepforge_chess.api.config import get_settings
    from prepforge_chess.api.routers import auth

    _register(client, "reset-race@example.com")
    monkeypatch.setattr(get_settings(), "password_reset_dev_link", True)
    headers = csrf_headers(client)
    token = client.post("/api/auth/password/forgot", headers=headers,
                        json={"email": "reset-race@example.com"}).json()["dev_reset_token"]
    barrier = Barrier(2)
    hash_password = auth.hash_password
    def simultaneous_hash(password):
        result = hash_password(password)
        barrier.wait(timeout=5)
        return result
    monkeypatch.setattr(auth, "hash_password", simultaneous_hash)
    def reset(password):
        with TestClient(client.app) as tab:
            tab.cookies.update(client.cookies)
            return tab.post("/api/auth/password/reset", headers=headers,
                            json={"token": token, "password": password}).status_code
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(reset, ["password-a", "password-b"])) == [204, 400]


def test_recovery_mail_uses_smtp_and_absolute_link_without_logging_token(client, monkeypatch, capsys):
    from unittest.mock import MagicMock
    from api_helpers import csrf_headers
    from prepforge_chess.api.config import get_settings
    from prepforge_chess.api.routers import auth

    _register(client, "mail@example.com")
    settings = get_settings()
    for key, value in {"smtp_host": "mail.invalid", "smtp_from": "prep@example.com",
                       "public_base_url": "https://prep.example.com", "smtp_username": "test",
                       "smtp_password": "test", "password_reset_dev_link": True}.items():
        monkeypatch.setattr(settings, key, value)
    transport = MagicMock()
    monkeypatch.setattr(auth.smtplib, "SMTP", transport)
    response = client.post("/api/auth/password/forgot", headers=csrf_headers(client),
                           json={"email": "mail@example.com"})
    smtp = transport.return_value.__enter__.return_value
    smtp.starttls.assert_called_once()
    smtp.login.assert_called_once_with("test", "test")
    message = smtp.send_message.call_args.args[0]
    token = response.json()["dev_reset_token"]
    assert f"https://prep.example.com/?reset_password={token}" in message.get_content()
    assert token not in capsys.readouterr().out


def test_unconfigured_production_recovery_fails_uniformly(client, monkeypatch):
    from api_helpers import csrf_headers
    from prepforge_chess.api.config import get_settings

    _register(client, "known@example.com")
    monkeypatch.setattr(get_settings(), "env", "production")
    monkeypatch.setattr(get_settings(), "smtp_host", "")
    for email in ["known@example.com", "unknown@example.com"]:
        response = client.post("/api/auth/password/forgot", headers=csrf_headers(client), json={"email": email})
        assert response.status_code == 503
        assert "dev_reset_token" not in response.json()


def test_build_reply_does_not_stamp_a_stale_tree_with_a_later_writer_revision(client, monkeypatch):
    from api_helpers import csrf_headers
    from prepforge_chess.api.db import get_engine
    from prepforge_chess.storage.repositories import PrepForgeRepository

    _register(client, "reply-race@example.com")
    headers = csrf_headers(client)
    created = client.post("/api/repertoires/create", headers=headers,
                          json={"name": "Before", "color": "white"}).json()
    save = PrepForgeRepository.save_changed_nodes
    def writer_interleaves(repo, rep_id, nodes):
        save(repo, rep_id, nodes)
        PrepForgeRepository(get_engine()).update_opening_nodes(rep_id, [{"id": nodes[0].id, "comment": "Other tab"}])
    monkeypatch.setattr(PrepForgeRepository, "save_changed_nodes", writer_interleaves)
    response = client.post("/api/build/add-move", headers=headers, json={
        "repertoire_id": created["repertoire_id"], "parent_node_id": created["selected_node_id"],
        "move_uci": "e2e4", "base_revision": created["revision"],
    })
    assert response.status_code == 200
    assert response.json()["revision"] == created["revision"] + 1
    assert PrepForgeRepository(get_engine()).repertoire_revision(created["repertoire_id"]) == created["revision"] + 2
