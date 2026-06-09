"""FastAPI application factory for the PrepForge SaaS API.

This is the new production entrypoint that will, phase by phase, take over from
``prepforge_chess.web.server``. Today it provides identity (email/password +
sessions), Lichess account linking, a health endpoint, and the security
middleware (headers, CSRF, rate limiting) a public deployment needs. Run locally
with::

    uvicorn prepforge_chess.api.main:app --reload
"""
from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded

from prepforge_chess.api.config import get_settings
from prepforge_chess.api.middleware import CSRFMiddleware, SecurityHeadersMiddleware
from prepforge_chess.api.ratelimit import limiter
from prepforge_chess.api.routers import analyze, auth, lichess, train, workspace
from prepforge_chess.api.routers import settings as settings_router
from prepforge_chess.api.static import register_static


def create_app() -> FastAPI:
    settings = get_settings()
    settings.require_production_secret()

    app = FastAPI(
        title="PrepForge Chess API",
        version="0.1.0",
        # Hide interactive docs in production; keep them in dev.
        docs_url=None if settings.is_production else "/docs",
        redoc_url=None,
    )

    # Rate limiting (slowapi): the limiter lives on app.state and raises
    # RateLimitExceeded, which this handler turns into a 429.
    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

    # Middleware order: last added is outermost. We want CORS outermost so even
    # CSRF/rate-limit rejections carry CORS headers (so the browser can read
    # them), then CSRF, then security headers innermost.
    app.add_middleware(SecurityHeadersMiddleware)
    app.add_middleware(CSRFMiddleware)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(auth.router)
    app.include_router(lichess.router)
    # Unprefixed legacy SPA seam (/oauth/login) until web-src/app.js migrates.
    app.include_router(lichess.legacy_router)
    app.include_router(workspace.router)
    app.include_router(analyze.router)
    app.include_router(train.router)
    app.include_router(settings_router.router)

    @app.get("/healthz", tags=["ops"])
    def healthz() -> dict[str, str]:
        """Liveness probe for the load balancer / Render health check."""
        return {"status": "ok"}

    @app.get("/api/csrf", tags=["auth"])
    def csrf(request: Request) -> dict[str, str]:
        """Bootstrap endpoint: ensures the pf_csrf cookie is set and returns the
        token so the SPA can send it back in the X-CSRF-Token header."""
        return {"csrf_token": request.state.csrf_token}

    # Serve the built SPA shell + engine assets. Registered last so the API
    # routers above take precedence over the catch-all /static path.
    register_static(app)

    return app


app = create_app()
