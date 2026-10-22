"""Deployment + legal page contract checks.

Pins the config/docs/code triples that silently drift apart:

- ``render.yaml`` + ``docs/DEPLOYMENT.md`` must list every production-required
  secret that ``config.require_production_secret()`` enforces — a missing key
  means a blueprint deploy crashes on boot instead of configuring it.
- ``Dockerfile`` must run uvicorn with the forwarded-header flags the rate
  limiter's correctness depends on (see api/ratelimit.py).
- ``Dockerfile`` must build the SPA itself (its output is no longer committed) and
  ship the built tree in the Python image; the engine manifest it fetches the wasm
  against must be a tracked source file.
- ``pyproject.toml`` package-data must cover every file of the served static tree
  (bar the CDN-hosted Maia weights and source maps): the wheel drops anything else.
- The Terms page must state the license actually declared by ``pyproject.toml``
  and shipped in ``LICENSE``.
"""

from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path

import pytest

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


def test_dockerfile_builds_the_spa_and_serves_it() -> None:
    # The static tree is build output (git-ignored), so the image must produce it:
    # a Node stage runs the same build, and the Python image copies that output,
    # not the (absent) source tree.
    dockerfile = _read("Dockerfile")
    assert re.search(r"^FROM node:22\S* AS spa$", dockerfile, re.M), (
        "Dockerfile has no Node stage named spa — the SPA is no longer committed"
    )
    node_stage, python_stage = dockerfile.split("FROM python:3.11-slim", 1)
    assert "npm run build" in node_stage
    assert "COPY --from=spa /app/src/prepforge_chess/web/static" in python_stage, (
        "the Python stage must copy the SPA built in the Node stage"
    )
    # The wasm still comes from the verified fetch, keyed on the manifest.
    assert "fetch_stockfish_wasm.py" in python_stage
    assert "web-src/public/engine/stockfish.manifest.json" in python_stage


def test_engine_manifest_is_a_tracked_source_file() -> None:
    # Docker fetches the wasm against this manifest and the packaging/browser
    # tests read it without running Node, so it must stay in git even though the
    # rest of web-src/public/engine is generated.
    tracked = subprocess.run(
        ["git", "ls-files", "--error-unmatch", "web-src/public/engine/stockfish.manifest.json"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert tracked.returncode == 0, "the Stockfish manifest must be committed"


def test_built_spa_is_not_tracked() -> None:
    # No mode may commit the bundle again: Docker and CI both build it.
    tracked = subprocess.run(
        ["git", "ls-files", "src/prepforge_chess/web/static"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert tracked.stdout.strip() == "", (
        "the built SPA tree is in git again:\n" + tracked.stdout
    )


def test_package_data_ships_the_whole_static_tree() -> None:
    # setuptools package-data globs match one directory level each; a new folder
    # (the hashed engine/<sha8>/ build) is silently left out of the wheel and the
    # engine worker 404s in production.
    pyproject = _read("pyproject.toml")
    block = re.search(r'"prepforge_chess\.web" = \[(.*?)\]', pyproject, re.S)
    assert block, "package-data for prepforge_chess.web not found"
    package = ROOT / "src/prepforge_chess/web"
    shipped = {
        path
        for pattern in re.findall(r'"([^"]+)"', block.group(1))
        for path in package.glob(pattern)
    }
    static = package / "static"
    if not (static / "index.html").is_file() and not os.environ.get(
        "PREPFORGE_REQUIRE_BUILT_SPA"
    ):
        pytest.skip("SPA not built; run `npm run build`")
    wanted = {
        path
        for path in static.rglob("*")
        if path.is_file()
        and path.suffix != ".map"
        and (path.parent.name != "maia3" or path.name in {"maia3.manifest.json", "maia3.manifest.json.br"})
    }
    missing = sorted(str(p.relative_to(static)) for p in wanted - shipped)
    assert not missing, f"left out of the wheel: {missing}"
