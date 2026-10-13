"""After account deletion no owner-scoped row may remain. The owner FKs on
games/repertoires/user_settings are not enforced in the schema (see the
lifecycle repository), so this checks the rows directly."""
from sqlalchemy import func, select

from prepforge_chess.storage import sa_tables as t
from tests.api_helpers import csrf_headers
from tests.test_api_train import _register, _smart_move, _smart_start, _white_repertoire_with_e4


def test_account_delete_leaves_no_owner_rows(client):
    user_id = _register(client, "residue@example.com")
    rep = _white_repertoire_with_e4(client)
    sid = _smart_start(client, rep, seed=5).json()["session_id"]
    _smart_move(client, sid, "e2e4")
    client.get("/api/dashboard")  # writes the recap snapshot setting

    deleted = client.request(
        "DELETE", "/api/account", json={"confirm": "DELETE"}, headers=csrf_headers(client)
    )
    assert deleted.status_code == 200, deleted.text

    from prepforge_chess.api import db

    engine = db.get_engine()
    with engine.connect() as conn:
        residue = {
            "repertoires": conn.scalar(select(func.count()).select_from(t.repertoires).where(t.repertoires.c.owner_user_id == user_id)),
            "training_progress": conn.scalar(select(func.count()).select_from(t.training_progress).where(t.training_progress.c.owner_user_id == user_id)),
            "training_sessions": conn.scalar(select(func.count()).select_from(t.training_sessions).where(t.training_sessions.c.repertoire_id == rep)),
            "user_settings": conn.scalar(select(func.count()).select_from(t.user_settings).where(t.user_settings.c.user_id == user_id)),
            "users": conn.scalar(select(func.count()).select_from(t.users).where(t.users.c.id == user_id)),
        }
    assert residue == {k: 0 for k in residue}, residue
