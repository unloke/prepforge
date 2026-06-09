"""Logging + error monitoring wiring for the SaaS API (Phase 6 ops).

Both are safe no-ops in dev: logging just sets a level/format, and Sentry stays
dark unless ``PREPFORGE_SENTRY_DSN`` is set *and* ``sentry-sdk`` is installed — so a
plain ``pip install .[server]`` (which does not pull Sentry) runs unchanged.
"""
from __future__ import annotations

import logging

from prepforge_chess.api.config import Settings

_LOG_FORMAT = "%(asctime)s %(levelname)s %(name)s %(message)s"


def configure_logging(settings: Settings) -> None:
    """Set a consistent root log level/format once at app startup."""
    level = getattr(logging, settings.log_level.upper(), logging.INFO)
    logging.basicConfig(level=level, format=_LOG_FORMAT)


def init_sentry(settings: Settings) -> bool:
    """Initialize Sentry error monitoring if configured. Returns True if enabled.

    Dark by default: no DSN, or ``sentry-sdk`` not installed, → no-op. To turn it on,
    ``pip install sentry-sdk`` and set ``PREPFORGE_SENTRY_DSN``."""
    if not settings.sentry_dsn:
        return False
    try:
        import sentry_sdk
    except ImportError:
        logging.getLogger(__name__).warning(
            "PREPFORGE_SENTRY_DSN is set but sentry-sdk is not installed; skipping."
        )
        return False
    sentry_sdk.init(
        dsn=settings.sentry_dsn,
        environment=settings.env,
        traces_sample_rate=0.0,  # errors only by default; tune for performance tracing
    )
    return True
