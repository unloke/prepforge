"""Serve the built single-page app (SPA) and its engine assets from FastAPI.

The legacy stdlib ``web/server.py`` served ``/`` (the app shell) and ``/static/*``
(the Vite bundle + the in-browser engine artifacts). The SaaS API has to do the
same so the *same* ``web-src/app.js`` runs against it — this is the last piece the
real-browser cutover needs before ``web/server.py`` can be deleted.

Three things make this more than a bare ``StaticFiles`` mount:

* **Cross-origin isolation.** The in-browser engines (multi-threaded Stockfish
  WASM, onnxruntime-web Maia3) need ``SharedArrayBuffer``, which the browser only
  grants to a *cross-origin isolated* document: the app shell must carry
  ``COOP: same-origin`` + ``COEP: require-corp``, and every subresource it pulls
  must carry ``CORP: same-origin`` (or be CORS). We set those here rather than in
  the global security middleware so the dev ``/docs`` page and the JSON API (which
  would otherwise break under ``require-corp``) stay unaffected.
* **Runtime Maia3 asset base.** The ~45 MB ONNX weights are CDN/object-store
  hosted and stripped from the deploy image, so the shell resolves their base URL
  at runtime from ``window.__MAIA3_ASSET_BASE`` — injected into the HTML from
  ``PREPFORGE_MAIA3_ASSET_BASE`` (empty → in-image ``/static/maia3/`` dev fallback).
* **Dev weights fallback.** A locally built tree has only the manifest under
  ``static/maia3/``; the real weights live (git-ignored) in
  ``web-src/public/maia3/``. We fall back to that source copy so local Maia3 "just
  works" with no env var and no manual copying.
"""
from __future__ import annotations

import json
import mimetypes
import os
import re
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse, HTMLResponse, Response

STATIC_DIR = Path(__file__).resolve().parents[1] / "web" / "static"

# The developer's git-ignored ONNX weights live here. A production build strips
# the weights from static/maia3/ (they're CDN-hosted), so in a pip-installed
# deploy there is no web-src/ and this directory simply doesn't exist (the
# fallback becomes a no-op and production uses the CDN).
DEV_MAIA3_DIR = Path(__file__).resolve().parents[3] / "web-src" / "public" / "maia3"

MAIA3_ASSET_BASE_ENV = "PREPFORGE_MAIA3_ASSET_BASE"

# Cross-origin isolation headers. The document carries COOP+COEP (so it becomes
# cross-origin isolated and can use SharedArrayBuffer); subresources carry CORP so
# they load under the document's require-corp policy.
_DOCUMENT_ISOLATION = {
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Resource-Policy": "same-origin",
}
# Assets carry CORP so they load under the document's require-corp policy. They ALSO
# carry COEP: a worker script (Stockfish / onnxruntime) loaded via new Worker() only
# becomes cross-origin isolated — and can therefore create the SharedArrayBuffer that
# threaded WASM / pthreads need — when ITS OWN response sets COEP. Without it the
# worker's crossOriginIsolated is false and pthread startup fails in-browser with
# "Specify a Cross-Origin Embedder Policy to prevent this frame from being blocked".
# COEP on non-worker assets (css/img/wasm) is harmless.
_ASSET_ISOLATION = {
    "Cross-Origin-Resource-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
}

# Explicit MIME types for the engine artifacts (wasm/onnx/workers). mimetypes
# alone is unreliable for these on Windows, and a wrong type (e.g. text/plain for
# .wasm) breaks instantiation.
_STATIC_MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".wasm": "application/wasm",
    ".onnx": "application/octet-stream",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".woff2": "font/woff2",
}

# Content-stable engine/model artifacts can be cached forever.
_IMMUTABLE_EXT = {".wasm", ".onnx", ".nnue"}
# Vite content-hashed bundle names, e.g. "index-D4f8aB12.js". Only these (not
# every file under assets/) are safe to mark immutable — the hash changes whenever
# the content does.
_HASHED_NAME = re.compile(r"-[A-Za-z0-9_]{8,}\.[A-Za-z0-9]+$")


def _static_mime(path: Path) -> str:
    ext = path.suffix.lower()
    if ext in _STATIC_MIME:
        return _STATIC_MIME[ext]
    guessed, _ = mimetypes.guess_type(str(path))
    return guessed or "application/octet-stream"


def _cache_control(path: Path) -> str:
    if path.suffix.lower() in _IMMUTABLE_EXT or _HASHED_NAME.search(path.name):
        return "public, max-age=31536000, immutable"
    # App shell + unhashed assets (index.html, styles, icons): always revalidate so
    # deploys/edits are picked up immediately.
    return "no-cache"


def _maia3_asset_base() -> str:
    return os.environ.get(MAIA3_ASSET_BASE_ENV, "").strip()


def _inject_asset_base(html_bytes: bytes) -> bytes:
    """Inject ``window.__MAIA3_ASSET_BASE`` (from the env) into an HTML document.

    No-op when the env var is unset, so local dev keeps the in-image
    ``/static/maia3/`` fallback. The tag is placed right after ``<head>`` so it runs
    before the module scripts that read the global. The value is JSON-encoded and
    its ``</`` sequences are escaped to prevent a ``</script>`` breakout.
    """
    base = _maia3_asset_base()
    if not base:
        return html_bytes
    literal = json.dumps(base).replace("</", "<\\/")
    tag = "<script>window.__MAIA3_ASSET_BASE={0};</script>".format(literal).encode("utf-8")
    marker = b"<head>"
    idx = html_bytes.find(marker)
    if idx == -1:
        return tag + html_bytes
    insert_at = idx + len(marker)
    return html_bytes[:insert_at] + tag + html_bytes[insert_at:]


def _dev_maia3_fallback(rel_path: str) -> Path | None:
    """Resolve a ``maia3/<file>`` request against the dev source weights dir, or None.

    Only ``maia3/*`` paths are eligible, the dir must exist, and the resolved file
    must stay inside it (traversal guard) and be a real file."""
    prefix = "maia3/"
    if not rel_path.startswith(prefix):
        return None
    if not DEV_MAIA3_DIR.is_dir():
        return None
    base = DEV_MAIA3_DIR.resolve()
    target = (base / rel_path[len(prefix):]).resolve()
    if target != base and base not in target.parents:
        return None
    return target if target.is_file() else None


def _render_index() -> Response:
    index = STATIC_DIR / "index.html"
    try:
        body = _inject_asset_base(index.read_bytes())
    except OSError:
        return Response("app shell not found", status_code=404)
    return HTMLResponse(
        content=body,
        headers={"Cache-Control": _cache_control(index), **_DOCUMENT_ISOLATION},
    )


def _serve_asset(rel_path: str) -> Response:
    base = STATIC_DIR.resolve()
    target = (base / rel_path).resolve()
    # Reject path traversal outside STATIC_DIR.
    if target != base and base not in target.parents:
        return Response("not found", status_code=404)
    if not target.is_file():
        # Dev fallback: a locally-built tree has no ONNX weights in static/maia3
        # (the build strips them — they're CDN-hosted). Serve them from the
        # developer's source copy so local Maia3 "just works".
        dev = _dev_maia3_fallback(rel_path)
        if dev is None:
            return Response("not found", status_code=404)
        target = dev
    # HTML documents (the app shell, served via /static too) get the runtime
    # asset-base injection and the document isolation headers; everything else
    # streams via FileResponse (range requests, sendfile) with CORP.
    if target.suffix.lower() == ".html":
        body = _inject_asset_base(target.read_bytes())
        return HTMLResponse(
            content=body,
            headers={"Cache-Control": _cache_control(target), **_DOCUMENT_ISOLATION},
        )
    return FileResponse(
        target,
        media_type=_static_mime(target),
        headers={"Cache-Control": _cache_control(target), **_ASSET_ISOLATION},
    )


def register_static(app: FastAPI) -> None:
    """Mount the SPA shell at ``/`` and its assets at ``/static/*``.

    Registered last so the API routers, ``/healthz``, ``/oauth/login`` etc. take
    precedence; these two routes never overlap the ``/api`` / ``/oauth`` surface.
    """

    @app.get("/", include_in_schema=False)
    def index() -> Response:
        return _render_index()

    @app.get("/static/{rel_path:path}", include_in_schema=False)
    def static_asset(rel_path: str) -> Response:
        return _serve_asset(rel_path)
