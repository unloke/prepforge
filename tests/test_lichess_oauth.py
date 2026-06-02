import prepforge_chess.web.server as server_mod
from prepforge_chess.services import lichess_oauth
from prepforge_chess.web.server import PrepForgeWebApp


def test_pkce_challenge_is_deterministic_and_url_safe():
    verifier = lichess_oauth.generate_code_verifier()
    assert "=" not in verifier and "+" not in verifier and "/" not in verifier
    challenge = lichess_oauth.code_challenge_for(verifier)
    assert challenge == lichess_oauth.code_challenge_for(verifier)
    assert challenge != verifier


def test_authorize_url_has_pkce_params():
    url = lichess_oauth.build_authorize_url(
        redirect_uri="http://127.0.0.1:8765/oauth/callback",
        state="st",
        code_challenge="ch",
    )
    assert url.startswith("https://lichess.org/oauth?")
    for fragment in (
        "response_type=code",
        "code_challenge_method=S256",
        "code_challenge=ch",
        "state=st",
        "client_id=prepforge-chess",
    ):
        assert fragment in url


def test_login_then_callback_stores_username(tmp_path, monkeypatch):
    app = PrepForgeWebApp(db_path=tmp_path / "ui.sqlite3", prefer_real_engines=False)
    app.lichess_login_url("http://127.0.0.1:8765/oauth/callback")
    pending = app.__dict__["_oauth_pending"]
    assert len(pending) == 1
    state = next(iter(pending))

    monkeypatch.setattr(server_mod, "exchange_code", lambda **kwargs: {"access_token": "tok"})
    monkeypatch.setattr(server_mod, "fetch_username", lambda token, **kwargs: "MyName")

    username = app.lichess_handle_callback(code="code123", state=state)
    assert username == "MyName"
    assert app.lichess_status_payload() == {"connected": True, "username": "MyName"}
    assert state not in app.__dict__["_oauth_pending"]

    disconnected = app.lichess_disconnect_payload()
    assert disconnected["connected"] is False
    assert app.lichess_status_payload()["connected"] is False


def test_callback_rejects_unknown_state(tmp_path):
    app = PrepForgeWebApp(db_path=tmp_path / "ui.sqlite3", prefer_real_engines=False)
    try:
        app.lichess_handle_callback(code="x", state="never-issued")
        assert False, "expected ValueError"
    except ValueError as exc:
        assert "state" in str(exc)
