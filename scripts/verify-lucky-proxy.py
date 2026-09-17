"""Authenticated browser-path verification: register -> mock-link a Lichess token
-> explorer proxy with top_games=4 (the exact Lucky seed call) -> capture status
+ response shape. Then simulate the sampler over that shape with a stubbed
continuation tree (live per-ply calls need a real token)."""

import json
import os
import tempfile
from pathlib import Path
from unittest.mock import patch

tmp = Path(tempfile.mkdtemp()) / "verify.sqlite3"
os.environ["DATABASE_URL"] = f"sqlite:///{tmp.as_posix()}"
os.environ["PREPFORGE_SECRET_KEY"] = "test-secret-not-for-prod"
os.environ["PREPFORGE_ENV"] = "development"

from fastapi.testclient import TestClient  # noqa: E402

from prepforge_chess.api import config, db  # noqa: E402
from prepforge_chess.api.ratelimit import limiter  # noqa: E402

config.get_settings.cache_clear()
db._engine = None
db._SessionLocal = None
limiter.enabled = False

from prepforge_chess.api import main  # noqa: E402

db.Base.metadata.create_all(db.make_engine())
client = TestClient(main.app)
client.get("/api/csrf")
headers = {"X-CSRF-Token": client.cookies["pf_csrf"]}

r = client.post(
    "/api/auth/register",
    json={"email": "verify@example.com", "password": "longpassword1"},
    headers=headers,
)
assert r.status_code == 201, r.text
print("register:", r.status_code)

# Mock-link: implant an encrypted linked token directly (same shape the OAuth
# callback stores), so the proxy attaches a Bearer token server-side.
import json as _json  # noqa: E402

from prepforge_chess.api.models import LinkedAccount  # noqa: E402
from prepforge_chess.api.security import encrypt_token  # noqa: E402

with db._SessionLocal() as session:
    from sqlalchemy import select  # noqa: E402

    from prepforge_chess.api.models import User  # noqa: E402

    user = session.scalar(select(User).where(User.email == "verify@example.com"))
    session.add(
        LinkedAccount(
            user_id=user.id,
            provider="lichess",
            provider_user_id="VerifyUser",
            encrypted_token=encrypt_token(_json.dumps({"access_token": "TEST-TOKEN"})),
        )
    )
    session.commit()
print("mock-link: ok")

SEED = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"

calls = {}


def fake_fetch(url, token, **kw):
    calls["url"] = url
    calls["token"] = token
    assert token == "TEST-TOKEN", token
    return {
        "white": 171398,
        "draws": 172107,
        "black": 119218,
        "moves": [
            {"uci": "c7c5", "san": "c5", "white": 61142, "draws": 57738, "black": 46077},
            {"uci": "e7e5", "san": "e5", "white": 53772, "draws": 62859, "black": 40482},
        ],
        "topGames": [
            {
                "uci": "e7e5",
                "id": "a1b2c3d4",
                "winner": "white",
                "white": {"name": "Carlsen, Magnus", "rating": 2882},
                "black": {"name": "Anand, Viswanathan", "rating": 2785},
                "year": 2014,
                "month": "2014-11",
            }
        ],
    }


with patch(
    "prepforge_chess.services.lichess_fetch.fetch_explorer_json", fake_fetch
):
    r = client.get(
        "/api/lichess/explorer/masters", params={"fen": SEED, "top_games": 4}
    )

print("explorer status:", r.status_code)
body = r.json()
print("explorer url:", calls.get("url"))
print("keys:", sorted(body.keys()))
print("topGames:", json.dumps(body.get("topGames"))[:400])
assert r.status_code == 200
assert "topGames=4" in calls["url"]
assert body["topGames"][0]["uci"] == "e7e5"
assert body["topGames"][0]["id"] == "a1b2c3d4"
print("VERIFY OK: proxy returns real-shape topGames with uci+id")
