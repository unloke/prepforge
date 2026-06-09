"""Shared helpers for the SaaS API tests.

Kept out of conftest.py so it imports as a plain top-level module (like
stub_maia) — pytest's default prepend import mode puts tests/ on sys.path.
Importing from conftest directly, or making tests/ a package, breaks the legacy
suites that do `from stub_maia import ...`.
"""
from __future__ import annotations

from fastapi.testclient import TestClient


def csrf_headers(client: TestClient) -> dict[str, str]:
    """Bootstrap a CSRF token and return the header the SPA would send."""
    client.get("/api/csrf")
    return {"X-CSRF-Token": client.cookies["pf_csrf"]}
