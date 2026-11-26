"""Refresh the browser session cookie while the server session is active.

Idle expiry remains the server's ``last_seen_at`` check; this middleware only
extends the cookie so an active user's browser does not drop it on day 30.
"""
from __future__ import annotations

from starlette.datastructures import MutableHeaders
from starlette.requests import HTTPConnection
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from prepforge_chess.api.config import get_settings
from prepforge_chess.api.middleware import set_cookie_header
from prepforge_chess.api.session_cookie import set_session_cookie


class SlidingSessionMiddleware:
    """Plain ASGI, like the security middlewares: it only edits the response's
    start message and leaves the body streaming through untouched."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        settings = get_settings()
        connection = HTTPConnection(scope)
        token = connection.cookies.get(settings.session_cookie_name)
        if not token:
            await self.app(scope, receive, send)
            return
        prefix = f"{settings.session_cookie_name}="

        async def send_with_session(message: Message) -> None:
            if (
                message["type"] == "http.response.start"
                # The auth dependency stores the user while the route runs,
                # before the response starts.
                and getattr(connection.state, "user", None) is not None
                and message["status"] < 400
                # the route set or cleared the cookie itself (login, account deletion): leave it
                and not any(
                    c.startswith(prefix) for c in MutableHeaders(scope=message).getlist("set-cookie")
                )
            ):
                set_cookie_header(message, lambda response: set_session_cookie(response, settings, token))
            await send(message)

        await self.app(scope, receive, send_with_session)
