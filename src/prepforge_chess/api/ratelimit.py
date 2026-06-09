"""Shared rate limiter (slowapi).

Defined in its own module so routers can apply ``@limiter.limit(...)`` without a
circular import on main. Keyed by client IP. In-memory storage is fine for a
single instance; move to a shared store (Redis) only if we scale horizontally.

NOTE: behind Render's proxy the real client IP arrives in X-Forwarded-For. Run
uvicorn with --proxy-headers (Phase 3) so request.client.host reflects it;
otherwise every request keys off the proxy IP and shares one bucket.
"""
from __future__ import annotations

from slowapi import Limiter
from slowapi.util import get_remote_address

limiter = Limiter(key_func=get_remote_address, storage_uri="memory://")
