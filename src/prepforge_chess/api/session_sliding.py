"""Refresh the browser session cookie while the server session is active.

Idle expiry remains the server's ``last_seen_at`` check; this middleware only
extends the cookie so an active user's browser does not drop it on day 30.
"""
from __future__ import annotations

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

from prepforge_chess.api.config import get_settings
from prepforge_chess.api.session_cookie import set_session_cookie


class SlidingSessionMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        settings = get_settings()
        token = request.cookies.get(settings.session_cookie_name)
        if (
            token
            and getattr(request.state, "user", None) is not None
            and response.status_code < 400
            # the route set or cleared the cookie itself (login, account deletion): leave it
            and not any(c.startswith(f"{settings.session_cookie_name}=") for c in response.headers.getlist("set-cookie"))
        ):
            set_session_cookie(response, settings, token)
        return response
