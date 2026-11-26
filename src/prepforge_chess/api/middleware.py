"""Security middleware: response headers + CSRF double-submit.

* SecurityHeadersMiddleware adds the baseline headers a public site needs and the
  headers: CSP, HSTS (prod only), nosniff, frame-deny,
  referrer policy. The CSP is strict but allows the WASM the in-browser engines
  need ('wasm-unsafe-eval') and blob workers (Stockfish + onnxruntime spin up Web
  Workers from blob URLs).
* CSRFMiddleware implements stateless double-submit: a non-HttpOnly ``pf_csrf``
  cookie is issued on safe requests, and unsafe methods must echo it in the
  ``X-CSRF-Token`` header. SameSite=Lax on the session cookie already blocks
  cross-site credentialed POSTs; this is defense-in-depth and also covers
  login-CSRF. The SPA reads the cookie and sets the header.
"""
from __future__ import annotations

import secrets
from collections.abc import Iterable

from starlette.datastructures import MutableHeaders
from starlette.requests import HTTPConnection
from starlette.responses import JSONResponse, Response
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from prepforge_chess.api.config import get_settings

CSRF_COOKIE = "pf_csrf"
CSRF_HEADER = "X-CSRF-Token"
_SAFE_METHODS = {"GET", "HEAD", "OPTIONS", "TRACE"}

# Hosts the Maia3 ONNX weights are fetched from at runtime (the worker downloads
# them cross-origin from the configured CDN). Hugging Face serves resolve/ URLs
# that 302 to its LFS/Xet CDN (e.g. cas-bridge.xethub.hf.co under hf.co), and CSP
# re-checks every redirect hop against connect-src — so both the apex and the
# wildcard subdomains must be allowed or the weight fetch is blocked.
_WEIGHT_CDN_HOSTS = (
    "https://huggingface.co",
    "https://*.huggingface.co",
    "https://*.hf.co",
)

# Browser-side features that talk to Lichess's public, CORS-open API directly
# (no token, so no proxy needed): opponent scouting fetches recent games
# (web-src/scout.js) and the AUTO Maia strength reads the linked player's
# public profile rating (web-src/app.js refreshAutoMaiaRating). Without this
# host in connect-src both fetches die as a generic "Failed to fetch" and
# AUTO silently falls back to the model default.
_LICHESS_API_HOSTS = ("https://lichess.org",)


# Engines run client-side via WASM + Web Workers, so the CSP must permit them
# while still blocking arbitrary remote script. 'wasm-unsafe-eval' enables WASM
# compilation without enabling JS eval(); worker-src blob: covers the workers
# Stockfish/onnxruntime create; connect-src lists the weight CDN. ``script_hashes``
# lets a specific response (the app shell, which carries one tiny inline bootstrap
# <script> setting window.__MAIA3_ASSET_BASE) opt that exact script in by sha256 —
# so we never have to relax the policy to 'unsafe-inline'.
def build_csp(*, script_hashes: tuple[str, ...] = ()) -> str:
    script_src = "'self' 'wasm-unsafe-eval'" + "".join(f" '{h}'" for h in script_hashes)
    connect_src = " ".join(("'self'", *_WEIGHT_CDN_HOSTS, *_LICHESS_API_HOSTS))
    return (
        "default-src 'self'; "
        f"script-src {script_src}; "
        "worker-src 'self' blob:; "
        "style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data:; "
        f"connect-src {connect_src}; "
        "object-src 'none'; "
        "base-uri 'self'; "
        "frame-ancestors 'none'"
    )


_CSP = build_csp()


_SECURITY_HEADERS = (
    ("Content-Security-Policy", _CSP),
    ("X-Content-Type-Options", "nosniff"),
    ("X-Frame-Options", "DENY"),
    ("Referrer-Policy", "strict-origin-when-cross-origin"),
    ("Permissions-Policy", "geolocation=(), microphone=(), camera=()"),
)
_HSTS = ("Strict-Transport-Security", "max-age=31536000; includeSubDomains")

# Both middlewares below are plain ASGI: they only touch the response's start
# message, so the body streams straight through instead of being re-wrapped in
# a second response the way Starlette's BaseHTTPMiddleware does.


class SecurityHeadersMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        production = get_settings().is_production

        async def send_with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                for name, value in _SECURITY_HEADERS:
                    headers.setdefault(name, value)
                if production:
                    headers.setdefault(*_HSTS)
            await send(message)

        await self.app(scope, receive, send_with_headers)


def set_cookie_header(message: Message, set_cookie) -> None:
    """Append to a response start message the ``Set-Cookie`` header that
    ``set_cookie(response)`` would put on a Starlette response, so a plain ASGI
    middleware sets a cookie exactly as a route does."""
    shaped = Response()
    set_cookie(shaped)
    headers = MutableHeaders(scope=message)
    for value in shaped.headers.getlist("set-cookie"):
        headers.append("set-cookie", value)


class CSRFMiddleware:
    """Stateless double-submit CSRF. Exempt paths (machine-to-machine, verified
    by their own signature — e.g. the Stripe webhook) are injected at
    ``create_app()`` time rather than mutated on a module-level global."""

    def __init__(self, app: ASGIApp, exempt_paths: Iterable[str] | None = None) -> None:
        self.app = app
        self._exempt_paths = frozenset(exempt_paths or ())

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        connection = HTTPConnection(scope)
        # Immutable assets must be shareable by HTTP/CDN caches, including on a
        # fresh browser's first request. Bootstrap CSRF on app/API pages instead.
        if connection.url.path.startswith("/static/"):

            async def send_without_cookies(message: Message) -> None:
                if message["type"] == "http.response.start":
                    headers = MutableHeaders(scope=message)
                    if "set-cookie" in headers:
                        del headers["set-cookie"]
                await send(message)

            await self.app(scope, receive, send_without_cookies)
            return

        cookie_token = connection.cookies.get(CSRF_COOKIE)
        # Mint a token up front when none exists, so a bootstrap endpoint
        # (/api/csrf) can return it via request.state in the same round-trip.
        minted = None if cookie_token else secrets.token_urlsafe(32)
        connection.state.csrf_token = cookie_token or minted

        if (
            scope["method"] not in _SAFE_METHODS
            and connection.url.path not in self._exempt_paths
        ):
            header_token = connection.headers.get(CSRF_HEADER)
            # Validate against the SUBMITTED cookie only — a freshly minted token
            # the client never received must not satisfy the check.
            if (
                not cookie_token
                or not header_token
                or not secrets.compare_digest(cookie_token, header_token)
            ):
                response = JSONResponse({"detail": "CSRF token missing or invalid"}, status_code=403)
                await response(scope, receive, send)
                return

        if not minted:
            await self.app(scope, receive, send)
            return

        # Set the cookie on first contact so the SPA has a token to echo. Not
        # HttpOnly (JS must read it); SameSite=Lax; Secure in prod.
        secure = get_settings().is_production

        async def send_with_cookie(message: Message) -> None:
            if message["type"] == "http.response.start":
                set_cookie_header(message, lambda response: response.set_cookie(
                    key=CSRF_COOKIE,
                    value=minted,
                    httponly=False,
                    secure=secure,
                    samesite="lax",
                    path="/",
                ))
            await send(message)

        await self.app(scope, receive, send_with_cookie)
