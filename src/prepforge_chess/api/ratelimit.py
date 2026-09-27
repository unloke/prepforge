"""Shared rate limiter (slowapi).

Defined in its own module so routers can apply ``@limiter.limit(...)`` without a
circular import on main. Keyed by client IP. In-memory storage is fine for a
single instance; move to a shared store (Redis) only if we scale horizontally.

NOTE: behind Render's proxy the real client IP arrives in X-Forwarded-For.
``--proxy-headers`` alone is NOT enough: uvicorn only trusts forwarded headers
from ``forwarded_allow_ips`` sources (default ``127.0.0.1,::1``), so the proxy's
X-Forwarded-For would be ignored and every visitor would share one bucket. The
Dockerfile CMD runs uvicorn with ``--proxy-headers --forwarded-allow-ips '*'``
(Render's proxy is the only ingress); see docs/DEPLOYMENT.md and keep the two in
sync if the deployment topology changes.
"""
from __future__ import annotations

from slowapi import Limiter
from slowapi.util import get_remote_address

limiter = Limiter(key_func=get_remote_address, storage_uri="memory://")
