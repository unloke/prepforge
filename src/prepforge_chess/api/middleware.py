"""Security middleware: response headers + CSRF double-submit.

* SecurityHeadersMiddleware adds the baseline headers a public site needs and the
  legacy stdlib server never sent: CSP, HSTS (prod only), nosniff, frame-deny,
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

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from prepforge_chess.api.config import get_settings

CSRF_COOKIE = "pf_csrf"
CSRF_HEADER = "X-CSRF-Token"
_SAFE_METHODS = {"GET", "HEAD", "OPTIONS", "TRACE"}
# Paths that must bypass CSRF (machine-to-machine, signature-verified elsewhere).
# Stripe's webhook lands here in Phase 4.
CSRF_EXEMPT_PATHS: set[str] = set()

# Engines run client-side via WASM + Web Workers, so the CSP must permit them
# while still blocking arbitrary remote script. 'wasm-unsafe-eval' enables WASM
# compilation without enabling JS eval(); worker-src blob: covers the workers
# Stockfish/onnxruntime create.
_CSP = (
    "default-src 'self'; "
    "script-src 'self' 'wasm-unsafe-eval'; "
    "worker-src 'self' blob:; "
    "style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data:; "
    "connect-src 'self'; "
    "object-src 'none'; "
    "base-uri 'self'; "
    "frame-ancestors 'none'"
)


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response: Response = await call_next(request)
        headers = response.headers
        headers.setdefault("Content-Security-Policy", _CSP)
        headers.setdefault("X-Content-Type-Options", "nosniff")
        headers.setdefault("X-Frame-Options", "DENY")
        headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
        headers.setdefault("Permissions-Policy", "geolocation=(), microphone=(), camera=()")
        if get_settings().is_production:
            headers.setdefault(
                "Strict-Transport-Security", "max-age=31536000; includeSubDomains"
            )
        return response


class CSRFMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        cookie_token = request.cookies.get(CSRF_COOKIE)
        # Mint a token up front when none exists, so a bootstrap endpoint
        # (/api/csrf) can return it via request.state in the same round-trip.
        minted = None if cookie_token else secrets.token_urlsafe(32)
        request.state.csrf_token = cookie_token or minted

        if (
            request.method not in _SAFE_METHODS
            and request.url.path not in CSRF_EXEMPT_PATHS
        ):
            header_token = request.headers.get(CSRF_HEADER)
            # Validate against the SUBMITTED cookie only — a freshly minted token
            # the client never received must not satisfy the check.
            if (
                not cookie_token
                or not header_token
                or not secrets.compare_digest(cookie_token, header_token)
            ):
                return JSONResponse(
                    {"detail": "CSRF token missing or invalid"}, status_code=403
                )

        response: Response = await call_next(request)

        # Set the cookie on first contact so the SPA has a token to echo. Not
        # HttpOnly (JS must read it); SameSite=Lax; Secure in prod.
        if minted:
            response.set_cookie(
                key=CSRF_COOKIE,
                value=minted,
                httponly=False,
                secure=get_settings().is_production,
                samesite="lax",
                path="/",
            )
        return response
