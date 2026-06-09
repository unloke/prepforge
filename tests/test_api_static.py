"""Static SPA serving: app shell, engine assets, isolation headers, injection.

These cover the cutover piece that lets the *same* web-src/app.js run against the
FastAPI app — the document must be cross-origin isolated (COOP/COEP) so the
in-browser threaded WASM engines can use SharedArrayBuffer, assets must carry CORP
+ the right MIME/cache-control, traversal must be rejected, and the runtime Maia3
asset base must be injectable.
"""
from __future__ import annotations

from prepforge_chess.api import static as static_mod


def _an_asset() -> str:
    """A real hashed asset under static/assets, as a /static-relative path."""
    assets = static_mod.STATIC_DIR / "assets"
    js = next(p for p in assets.iterdir() if p.suffix == ".js" and p.name != ".map")
    return f"assets/{js.name}"


def test_index_served_with_isolation_headers(client):
    resp = client.get("/")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/html")
    assert "PrepForge" in resp.text
    # Cross-origin isolation: SharedArrayBuffer for the threaded WASM engines.
    assert resp.headers["cross-origin-opener-policy"] == "same-origin"
    assert resp.headers["cross-origin-embedder-policy"] == "require-corp"
    assert resp.headers["cross-origin-resource-policy"] == "same-origin"
    # App shell must always revalidate so deploys are picked up.
    assert resp.headers["cache-control"] == "no-cache"


def test_hashed_asset_served_immutable_with_corp(client):
    resp = client.get(f"/static/{_an_asset()}")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/javascript")
    # Content-hashed bundle → cache forever.
    assert resp.headers["cache-control"] == "public, max-age=31536000, immutable"
    # Subresource must carry CORP to load under the document's require-corp policy.
    assert resp.headers["cross-origin-resource-policy"] == "same-origin"


def test_missing_asset_is_404(client):
    resp = client.get("/static/assets/does-not-exist.js")
    assert resp.status_code == 404


def test_traversal_outside_static_is_rejected():
    # httpx/starlette normalize ".." in the URL, so exercise the guard directly.
    resp = static_mod._serve_asset("../../pyproject.toml")
    assert resp.status_code == 404


def test_asset_base_injection_when_env_set(monkeypatch):
    monkeypatch.setenv(static_mod.MAIA3_ASSET_BASE_ENV, "https://cdn.example.com/maia3/")
    html = static_mod._inject_asset_base(b"<head><title>x</title></head>")
    text = html.decode("utf-8")
    assert "window.__MAIA3_ASSET_BASE=" in text
    assert "https://cdn.example.com/maia3/" in text
    # Injected right after <head> so it runs before the module scripts.
    assert text.index("__MAIA3_ASSET_BASE") < text.index("<title>")


def test_asset_base_injection_noop_when_env_unset(monkeypatch):
    monkeypatch.delenv(static_mod.MAIA3_ASSET_BASE_ENV, raising=False)
    original = b"<head></head>"
    assert static_mod._inject_asset_base(original) == original


def test_asset_base_injection_escapes_script_breakout(monkeypatch):
    monkeypatch.setenv(static_mod.MAIA3_ASSET_BASE_ENV, "https://x/</script><b>")
    html = static_mod._inject_asset_base(b"<head></head>").decode("utf-8")
    assert "</script><b>" not in html
    assert "<\\/script>" in html
