"""OAuth helpers turn every upstream failure into their own error type, so the
callbacks redirect with an oauth_error instead of answering a raw 500."""
from __future__ import annotations

from io import BytesIO

import pytest

from prepforge_chess.services import google_oauth, lichess_oauth


class _FailingRead:
    def __init__(self, error):
        self.error = error

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self, *args):
        raise self.error


_CALLS = [
    (lichess_oauth, lichess_oauth.LichessOAuthError,
     lambda: lichess_oauth.exchange_code(code="c", code_verifier="v", redirect_uri="https://x/cb")),
    (lichess_oauth, lichess_oauth.LichessOAuthError, lambda: lichess_oauth.fetch_account("tok")),
    (google_oauth, google_oauth.GoogleOAuthError,
     lambda: google_oauth.exchange_code(code="c", code_verifier="v", redirect_uri="https://x/cb",
                                        client_id="id", client_secret="secret")),
    (google_oauth, google_oauth.GoogleOAuthError, lambda: google_oauth.fetch_userinfo("tok")),
]


@pytest.mark.parametrize("module,error_type,call", _CALLS)
@pytest.mark.parametrize("failure", [TimeoutError("timed out"), ConnectionResetError("reset")])
def test_mid_body_failures_raise_the_oauth_error(monkeypatch, module, error_type, call, failure):
    monkeypatch.setattr(module.urllib.request, "urlopen", lambda *a, **k: _FailingRead(failure))
    with pytest.raises(error_type):
        call()


@pytest.mark.parametrize("module,error_type,call", _CALLS)
def test_non_json_bodies_raise_the_oauth_error(monkeypatch, module, error_type, call):
    monkeypatch.setattr(module.urllib.request, "urlopen", lambda *a, **k: BytesIO(b"<html>502</html>"))
    with pytest.raises(error_type):
        call()
