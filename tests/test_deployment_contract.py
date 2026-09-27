"""Deployment + legal page contract checks.

Pins the config/docs/code triples that silently drift apart:

- ``render.yaml`` + ``docs/DEPLOYMENT.md`` must list every production-required
  secret that ``config.require_production_secret()`` enforces — a missing key
  means a blueprint deploy crashes on boot instead of configuring it.
- ``Dockerfile`` must run uvicorn with the forwarded-header flags the rate
  limiter's correctness depends on (see api/ratelimit.py).
- The Terms page must state the license actually declared by ``pyproject.toml``
  and shipped in ``LICENSE``.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def _required_production_secrets() -> set[str]:
    """Secret names config.require_production_secret() refuses the dev default for."""
    config = _read("src/prepforge_chess/api/config.py")
    keys = set(re.findall(r'"(PREPFORGE_[A-Z0-9_]+) must be set', config))
    assert keys, "require_production_secret() contract not found in config.py"
    return keys


def test_render_yaml_lists_every_required_production_secret() -> None:
    render = _read("render.yaml")
    for key in sorted(_required_production_secrets()):
        assert f"- key: {key}" in render, (
            f"{key} is enforced in production but missing from render.yaml envVars "
            "— a blueprint deploy would crash on boot"
        )
        # Secrets must be dashboard-set, never committed values.
        assert re.search(
            rf"- key: {key}\s*\n\s*sync: false", render
        ), f"{key} must use sync: false (value set in the dashboard)"


def test_deployment_docs_list_every_required_production_secret() -> None:
    docs = _read("docs/DEPLOYMENT.md")
    for key in sorted(_required_production_secrets()):
        assert f"`{key}`" in docs, (
            f"{key} is enforced in production but missing from the DEPLOYMENT.md "
            "environment-variable table"
        )


def test_uvicorn_trusts_forwarded_headers_for_rate_limiting() -> None:
    # --proxy-headers without --forwarded-allow-ips keeps request.client.host at
    # the proxy IP (uvicorn trusts only localhost sources by default), so every
    # visitor would share one rate-limit bucket behind Render's proxy.
    dockerfile = _read("Dockerfile")
    cmd = next(
        line for line in dockerfile.splitlines() if line.startswith("CMD ")
    )
    assert "--proxy-headers" in cmd
    assert "--forwarded-allow-ips" in cmd


def test_terms_state_the_actual_project_license() -> None:
    declared = re.search(
        r'license\s*=\s*\{\s*text\s*=\s*"([^"]+)"', _read("pyproject.toml")
    )
    assert declared, "pyproject.toml license not found"
    license_id = declared.group(1)

    license_head = _read("LICENSE").splitlines()[0]
    assert "GNU AFFERO GENERAL PUBLIC LICENSE" in license_head
    assert license_id.startswith("AGPL")

    terms = _read("src/prepforge_chess/api/routers/legal.py")
    stated = re.search(
        r"open source under ([A-Za-z0-9.\-+]+)", terms
    )
    assert stated, "Terms page does not state a license"
    assert stated.group(1) == license_id, (
        f"Terms state {stated.group(1)} but pyproject/LICENSE declare {license_id}"
    )
