"""Static SPA serving: app shell, engine assets, isolation headers, injection.

These cover the cutover piece that lets the *same* web-src/app.js run against the
FastAPI app — the document must be cross-origin isolated (COOP/COEP) so the
in-browser threaded WASM engines can use SharedArrayBuffer, assets must carry CORP
+ the right MIME/cache-control, traversal must be rejected, and the runtime Maia3
asset base must be injectable.
"""
from __future__ import annotations

import os

import pytest

from prepforge_chess.api import static as static_mod

# The served tree is Vite build output (git-ignored), so a bare clone has none.
# CI builds it before pytest and sets PREPFORGE_REQUIRE_BUILT_SPA=1, where a
# missing tree is a failure rather than a skip; a developer runs `npm run build`.
BUILT = (static_mod.STATIC_DIR / "index.html").is_file()
requires_built_spa = pytest.mark.skipif(
    not BUILT and not os.environ.get("PREPFORGE_REQUIRE_BUILT_SPA"),
    reason="SPA not built; run `npm run build`",
)


def _an_asset() -> str:
    """A real hashed asset under static/assets, as a /static-relative path."""
    assets = static_mod.STATIC_DIR / "assets"
    js = next(p for p in assets.iterdir() if p.suffix == ".js" and p.name != ".map")
    return f"assets/{js.name}"


@requires_built_spa
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


@requires_built_spa
def test_hashed_asset_served_immutable_with_corp(client):
    resp = client.get(f"/static/{_an_asset()}")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/javascript")
    # Content-hashed bundle → cache forever.
    assert resp.headers["cache-control"] == "public, max-age=31536000, immutable"
    # Subresource must carry CORP to load under the document's require-corp policy.
    assert resp.headers["cross-origin-resource-policy"] == "same-origin"
    # And COEP, so a worker script (Stockfish/onnxruntime) loaded from it becomes
    # cross-origin isolated and can use SharedArrayBuffer (threaded WASM / pthreads).
    assert resp.headers["cross-origin-embedder-policy"] == "require-corp"


def test_missing_asset_is_404(client):
    resp = client.get("/static/assets/does-not-exist.js")
    assert resp.status_code == 404


@pytest.mark.parametrize("has_cookie", [False, True])
def test_static_responses_never_set_cookies(client, tmp_path, monkeypatch, has_cookie):
    monkeypatch.setattr(static_mod, "STATIC_DIR", tmp_path)
    engine = tmp_path / "engine" / "1234abcd"
    engine.mkdir(parents=True)
    (engine / "stockfish.wasm").write_bytes(b"\x00asm\x01\x00\x00\x00")
    (engine / "stockfish.js").write_text("// worker", encoding="utf-8")
    (tmp_path / "index.html").write_text("<head></head>", encoding="utf-8")
    if has_cookie:
        client.get("/api/csrf")
    else:
        client.cookies.clear()
    for path in ("engine/1234abcd/stockfish.wasm", "engine/1234abcd/stockfish.js", "index.html", "missing.js"):
        response = client.get(f"/static/{path}")
        assert response.status_code == (404 if path == "missing.js" else 200)
        assert response.headers.get_list("set-cookie") == []
        if path.endswith((".wasm", "stockfish.js")):
            assert response.headers["cache-control"] == "public, max-age=31536000, immutable"
            assert response.headers["cross-origin-embedder-policy"] == "require-corp"
    if not has_cookie:
        assert "pf_csrf" not in client.cookies
        assert client.get("/").headers.get_list("set-cookie")
        client.cookies.clear()
        assert client.get("/api/csrf").headers.get_list("set-cookie")


def test_static_middleware_removes_all_set_cookie_headers():
    from fastapi import FastAPI
    from fastapi.responses import Response
    from fastapi.testclient import TestClient

    from prepforge_chess.api.middleware import CSRFMiddleware

    app = FastAPI()
    app.add_middleware(CSRFMiddleware)

    @app.get("/static/asset.js")
    def asset():
        response = Response("// asset")
        response.set_cookie("one", "1")
        response.set_cookie("two", "2")
        return response

    assert TestClient(app).get("/static/asset.js").headers.get_list("set-cookie") == []


def test_traversal_outside_static_is_rejected():
    # httpx/starlette normalize ".." in the URL, so exercise the guard directly.
    from starlette.requests import Request

    request = Request({"type": "http", "method": "GET", "headers": [], "path": "/static/x"})
    resp = static_mod._serve_asset(request, "../../pyproject.toml")
    assert resp.status_code == 404


@requires_built_spa
def test_index_answers_conditional_request_with_304(client):
    first = client.get("/")
    etag = first.headers["etag"]
    assert etag
    # no-cache means "revalidate", not "re-download": the second load must be a
    # header-only round trip (the shell is ~71 KB of markup).
    again = client.get("/", headers={"If-None-Match": etag})
    assert again.status_code == 304
    assert again.content == b""
    assert again.headers["etag"] == etag
    # A shared cache reading Vary only from the 304 must still know it varies.
    assert again.headers["vary"] == "Accept-Encoding"
    assert again.headers["cache-control"] == "no-cache"
    # The isolation headers the document needs ride along.
    assert again.headers["cross-origin-opener-policy"] == "same-origin"
    assert again.headers["cross-origin-embedder-policy"] == "require-corp"


@requires_built_spa
def test_index_304_honours_if_modified_since(client):
    first = client.get("/")
    again = client.get("/", headers={"If-Modified-Since": first.headers["last-modified"]})
    assert again.status_code == 304
    # A date older than the file is a stale copy: send the body.
    stale = client.get("/", headers={"If-Modified-Since": "Wed, 21 Oct 2015 07:28:00 GMT"})
    assert stale.status_code == 200


@requires_built_spa
def test_index_etag_changes_with_the_injected_asset_base(client, monkeypatch):
    # The injected globals are env-derived: a restart with a different base serves
    # different markup for an unchanged file, so the ETag must move with it.
    monkeypatch.delenv(static_mod.MAIA3_ASSET_BASE_ENV, raising=False)
    plain = client.get("/").headers["etag"]
    monkeypatch.setenv(static_mod.MAIA3_ASSET_BASE_ENV, "https://cdn.example.com/maia3/")
    assert client.get("/").headers["etag"] != plain
    # ...and the old validator no longer matches, so the client gets the new body.
    assert client.get("/", headers={"If-None-Match": plain}).status_code == 200


@requires_built_spa
def test_revalidating_static_file_answers_304(client):
    # The Maia3 manifest loads on every page load (the engine reads it to resolve
    # the weight base) and is not content-hashed, so it revalidates every time.
    resp = client.get("/static/maia3/maia3.manifest.json")
    if resp.status_code == 404:
        pytest.skip("built tree has no maia3 manifest")
    etag = resp.headers["etag"]
    again = client.get("/static/maia3/maia3.manifest.json", headers={"If-None-Match": etag})
    assert again.status_code == 304
    assert again.content == b""
    assert again.headers["cache-control"] == "no-cache"
    assert again.headers["cross-origin-resource-policy"] == "same-origin"


@requires_built_spa
def test_range_request_still_streams_a_ranged_body(client):
    # A Range read is not a cache revalidation: it must keep returning bytes.
    asset = static_mod.STATIC_DIR / _an_asset()
    etag = static_mod._file_etag(asset.stat())
    resp = client.get(
        f"/static/{_an_asset()}",
        headers={"If-None-Match": etag, "Range": "bytes=0-99"},
    )
    assert resp.status_code == 206
    assert len(resp.content) == 100


@requires_built_spa
def test_hashed_asset_still_answers_304(client):
    # Immutable assets rarely re-ask, but a forced revalidation must not resend them.
    resp = client.get(f"/static/{_an_asset()}")
    again = client.get(f"/static/{_an_asset()}", headers={"If-None-Match": resp.headers["etag"]})
    assert again.status_code == 304


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
    monkeypatch.delenv(static_mod.ENGINE_ASSET_BASE_ENV, raising=False)
    original = b"<head></head>"
    assert static_mod._inject_asset_base(original) == original


def test_engine_asset_base_injection_when_env_set(monkeypatch):
    monkeypatch.delenv(static_mod.MAIA3_ASSET_BASE_ENV, raising=False)
    monkeypatch.setenv(
        static_mod.ENGINE_ASSET_BASE_ENV, "https://cdn.example.com/engine-repo/"
    )
    html = static_mod._inject_asset_base(b"<head><title>x</title></head>")
    text = html.decode("utf-8")
    assert "window.__ENGINE_ASSET_BASE=" in text
    assert "https://cdn.example.com/engine-repo/" in text
    assert "__MAIA3_ASSET_BASE" not in text
    assert text.index("__ENGINE_ASSET_BASE") < text.index("<title>")


def test_asset_base_injection_emits_both_globals_in_one_script(monkeypatch):
    monkeypatch.setenv(static_mod.MAIA3_ASSET_BASE_ENV, "https://cdn.example.com/maia3/")
    monkeypatch.setenv(static_mod.ENGINE_ASSET_BASE_ENV, "https://cdn.example.com/engine/")
    body = static_mod._asset_base_script()
    assert body is not None
    assert "window.__MAIA3_ASSET_BASE=" in body
    assert "window.__ENGINE_ASSET_BASE=" in body
    html = static_mod._inject_asset_base(b"<head></head>").decode("utf-8")
    assert html.count("<script>") == 1


def test_asset_base_injection_escapes_script_breakout(monkeypatch):
    monkeypatch.setenv(static_mod.MAIA3_ASSET_BASE_ENV, "https://x/</script><b>")
    html = static_mod._inject_asset_base(b"<head></head>").decode("utf-8")
    assert "</script><b>" not in html
    assert "<\\/script>" in html


def test_document_csp_allows_the_injected_inline_script_by_hash(monkeypatch):
    # The strict CSP blocks inline script, so the shell's bootstrap <script> must be
    # opted in by the sha256 of its EXACT body — recompute it and confirm the match,
    # otherwise the browser silently drops the script and the asset base is never set.
    monkeypatch.setenv(static_mod.MAIA3_ASSET_BASE_ENV, "https://cdn.example.com/maia3/")
    body = static_mod._asset_base_script()
    assert body is not None
    expected = static_mod._csp_script_hash(body)
    csp = static_mod._document_csp()
    assert f"'{expected}'" in csp
    assert "script-src 'self' 'wasm-unsafe-eval'" in csp


def test_document_csp_has_no_script_hash_when_env_unset(monkeypatch):
    monkeypatch.delenv(static_mod.MAIA3_ASSET_BASE_ENV, raising=False)
    monkeypatch.delenv(static_mod.ENGINE_ASSET_BASE_ENV, raising=False)
    csp = static_mod._document_csp()
    assert "sha256-" not in csp


@requires_built_spa
def test_index_csp_allows_weight_cdn_and_inline_bootstrap(client, monkeypatch):
    # End-to-end on the served shell: connect-src must reach the HF weight CDN (the
    # worker fetches the ONNX cross-origin) and the inline bootstrap must be hashed in.
    monkeypatch.setenv(static_mod.MAIA3_ASSET_BASE_ENV, "https://cdn.example.com/maia3/")
    resp = client.get("/")
    csp = resp.headers["content-security-policy"]
    assert "connect-src 'self' https://huggingface.co" in csp
    assert "https://*.hf.co" in csp
    assert "sha256-" in csp


@requires_built_spa
def test_worker_script_csp_allows_weight_cdn(client):
    # The ONNX fetch happens INSIDE the Maia worker, governed by the CSP on the
    # worker script's OWN response (the middleware default) — it must reach the CDN.
    assets = static_mod.STATIC_DIR / "assets"
    worker = next(
        (p for p in assets.iterdir() if "maia3-worker" in p.name and p.suffix == ".js"),
        None,
    )
    if worker is None:  # built tree may name it differently; fall back to any asset
        worker = next(p for p in assets.iterdir() if p.suffix == ".js" and ".map" not in p.name)
    resp = client.get(f"/static/assets/{worker.name}")
    assert "https://*.hf.co" in resp.headers["content-security-policy"]


def test_engine_build_folder_served_immutable():
    folder = static_mod.STATIC_DIR / "engine"
    assert static_mod._cache_control(folder / "76ff1a9b" / "stockfish-lite.js") == "public, max-age=31536000, immutable"
    # The manifest and unhashed folders revalidate.
    assert static_mod._cache_control(folder / "stockfish.manifest.json") == "no-cache"
    assert static_mod._cache_control(folder / "ort" / "ort.min.js") == "no-cache"



def test_gzip_skips_engine_binaries():
    from fastapi import FastAPI
    from fastapi.responses import Response
    from fastapi.testclient import TestClient

    from prepforge_chess.api.main import _TextGZipMiddleware

    app = FastAPI()
    app.add_middleware(_TextGZipMiddleware, minimum_size=10)

    @app.get("/{name}")
    def asset(name: str):
        return Response(b"x" * 4096, media_type="application/octet-stream")

    client = TestClient(app)
    headers = {"Accept-Encoding": "gzip"}
    assert "content-encoding" not in client.get("/stockfish.wasm", headers=headers).headers
    assert "content-encoding" not in client.get("/model.onnx", headers=headers).headers
    assert client.get("/index.js", headers=headers).headers["content-encoding"] == "gzip"
