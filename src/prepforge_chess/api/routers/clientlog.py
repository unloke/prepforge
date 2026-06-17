"""Front-end error beacon sink (stability/observability, plan #1).

The SPA has no server-side window into browser crashes: a white screen on an
unsupported device is invisible to us. This endpoint receives best-effort
``navigator.sendBeacon`` POSTs from a global ``error``/``unhandledrejection``
handler and writes them to the structured log, where Sentry (dark by default)
picks them up.

Design notes:

* ``sendBeacon`` cannot set the ``X-CSRF-Token`` header, so this path is added
  to ``CSRFMiddleware``'s exempt set in ``create_app()``. That is safe because
  the endpoint only *writes a log line* — it changes no state and reads no
  cross-origin-sensitive data. The exempt match is exact, so the route path and
  ``CLIENTLOG_PATH`` must stay byte-identical.
* No auth required (anonymous visitors crash too), but if a session cookie is
  present we attach the user id for triage.
* The body is size-capped and field-truncated so a hostile client can't flood
  the log; a per-IP rate limit caps volume.
* Always returns ``204`` — a beacon ignores the response, and we never want the
  reporting path itself to surface errors to the user.
"""
from __future__ import annotations

import json
import logging

from fastapi import APIRouter, Depends, Request, Response

from prepforge_chess.api.deps import current_user_optional
from prepforge_chess.api.models import User
from prepforge_chess.api.ratelimit import limiter

router = APIRouter(tags=["ops"])

CLIENTLOG_PATH = "/api/clientlog"

_log = logging.getLogger("prepforge.clientlog")

# Reject anything larger than this before parsing — a stack trace plus metadata
# fits comfortably; beyond it is abuse, not a real report.
_MAX_BODY_BYTES = 8 * 1024
# Per-field cap so one giant string can't bloat the log line even under the size cap.
_MAX_FIELD_CHARS = 2000
# Only these keys are logged; everything else in the payload is dropped.
_ALLOWED_KEYS = (
    "kind",
    "message",
    "src",
    "line",
    "col",
    "stack",
    "ua",
    "coi",
    "t",
)


def _truncate(value: object) -> object:
    if isinstance(value, str) and len(value) > _MAX_FIELD_CHARS:
        return value[:_MAX_FIELD_CHARS] + "…(truncated)"
    return value


@router.post(CLIENTLOG_PATH, include_in_schema=False)
@limiter.limit("60/minute")
async def client_log(
    request: Request,
    user: User | None = Depends(current_user_optional),
) -> Response:
    raw = await request.body()
    if len(raw) > _MAX_BODY_BYTES:
        # Drop oversized beacons silently; a real report never reaches this size.
        return Response(status_code=204)

    try:
        payload = json.loads(raw) if raw else {}
    except (ValueError, UnicodeDecodeError):
        payload = {}

    record: dict[str, object] = {}
    if isinstance(payload, dict):
        for key in _ALLOWED_KEYS:
            if key in payload:
                record[key] = _truncate(payload[key])

    _log.warning(
        "client error: %s",
        json.dumps(
            {
                "user_id": user.id if user else None,
                "ip": request.client.host if request.client else None,
                **record,
            },
            ensure_ascii=False,
            default=str,
        ),
    )
    return Response(status_code=204)
