"""Training a repertoire someone shared with you.

Any role (view / copy / edit) may drill a shared repertoire. The trainee's
sessions and progress are their own: the owner's progress is never read, written
or shown to them, and their training never touches the owner's. Revoking the
share ends the trainee's sessions on it.
"""
from __future__ import annotations

import uuid

import pytest

import test_repertoire_access as access
from test_repertoire_access import _load, _post

world = access.world  # the sharing fixture: an owner and one account per role


def _smart_start(client, rep, **extra):
    return _post(client, "/api/train/smart/start", {"repertoire_id": rep, "seed": 5, **extra})


def _sync_correct(client, start):
    target = start["cards"][0]["targets"][0]
    return _post(client, "/api/train/smart/sync", {
        "session_id": start["session_id"],
        "session_generation": start["session_generation"],
        "attempts": [{"node_id": target["node_id"], "correct": True, "attempt_uuid": uuid.uuid4().hex}],
        "card_index": 1,
    })


@pytest.mark.parametrize("who", ["view", "copy", "edit"])
def test_every_role_can_train_a_shared_repertoire(world, who):
    rep, c = world["rep"], world["c"]
    start = _smart_start(c[who], rep)
    assert start.status_code == 200, start.text
    body = start.json()
    assert body["repertoire_id"] == rep
    assert body["cards"][0]["targets"][0]["uci"] == "e2e4"
    # Line rehearsal too.
    assert _post(c[who], "/api/train/start", {"repertoire_id": rep}).status_code == 200


def test_outsiders_cannot_train_it(world):
    rep, c = world["rep"], world["c"]
    assert _smart_start(c["outsider"], rep).status_code == 404
    assert _post(c["outsider"], "/api/train/start", {"repertoire_id": rep}).status_code == 404
    assert c["outsider"].get(f"/api/train/smart/summary?repertoire_id={rep}").status_code == 404


def test_a_trainees_progress_is_their_own(world):
    rep, c = world["rep"], world["c"]
    owner_before = _load(c["owner"], rep).json()["health"]
    owner_badge = next(r for r in c["owner"].get("/api/repertoires").json()["repertoires"] if r["id"] == rep)["health"]

    trainee = _smart_start(c["view"], rep).json()
    # A fresh trainee starts from nothing, whatever the owner has done.
    assert trainee["health"]["untrained"] == trainee["health"]["trainable"] == 1
    assert _sync_correct(c["view"], trainee).json()["synced"] == 1

    mine = c["view"].get(f"/api/train/smart/summary?repertoire_id={rep}").json()
    assert mine["health"]["untrained"] == 0
    # The owner's tree payload, Library badge and summary are untouched.
    assert _load(c["owner"], rep).json()["health"] == owner_before
    badge = next(r for r in c["owner"].get("/api/repertoires").json()["repertoires"] if r["id"] == rep)["health"]
    assert badge == owner_badge
    assert c["owner"].get(f"/api/train/smart/summary?repertoire_id={rep}").json()["health"]["untrained"] == 1
    # And the trainee still never sees the owner's training state in Build.
    assert "health" not in _load(c["view"], rep).json()


def test_owner_progress_never_reaches_the_trainee(world):
    rep, c = world["rep"], world["c"]
    owner = _smart_start(c["owner"], rep).json()
    assert _sync_correct(c["owner"], owner).json()["synced"] == 1
    trainee = _smart_start(c["copy"], rep).json()
    assert trainee["health"]["untrained"] == 1
    assert trainee["cards"][0]["kind"] == "new"


def test_sessions_are_per_user(world):
    rep, c = world["rep"], world["c"]
    owner = _smart_start(c["owner"], rep).json()
    trainee = _smart_start(c["edit"], rep).json()
    assert owner["session_id"] != trainee["session_id"]
    # Neither may drive the other's session.
    assert _sync_correct(c["edit"], owner).status_code == 404
    assert _sync_correct(c["owner"], trainee).status_code == 404
    assert _post(c["edit"], "/api/train/smart/skip", {"session_id": owner["session_id"]}).status_code == 404


def test_revoking_the_share_ends_training(world):
    rep, c, ids = world["rep"], world["c"], world["ids"]
    trainee = _smart_start(c["view"], rep).json()
    r = _post(c["owner"], "/api/repertoires/access/revoke", {"repertoire_id": rep, "user_id": ids["view"]})
    assert r.status_code == 200
    assert _sync_correct(c["view"], trainee).status_code == 404
    assert _smart_start(c["view"], rep).status_code == 404


def test_the_mixed_queue_draws_only_on_your_own_repertoires(world):
    c = world["c"]
    # The viewer owns nothing; a shared repertoire is trained on its own.
    mixed = _post(c["view"], "/api/train/smart/start", {"mixed": True})
    assert mixed.status_code == 400
    assert "no active repertoires" in mixed.json()["detail"]


def test_deleting_the_shared_repertoire_counts_the_trainees_sessions_for_them(world):
    rep, c = world["rep"], world["c"]
    _smart_start(c["view"], rep)
    before = c["view"].get("/api/dashboard").json()["training_sessions"]
    assert before == 1
    assert _post(c["owner"], "/api/repertoires/delete", {"repertoire_id": rep}).status_code == 200
    assert c["view"].get("/api/dashboard").json()["training_sessions"] == 1
    assert c["owner"].get("/api/dashboard").json()["training_sessions"] == 0
