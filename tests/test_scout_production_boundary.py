"""Product code must not import research Module B runners."""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PRODUCT_DIRS = (ROOT / "src", ROOT / "web-src")
# Import statements only: comments that mention a research path are not imports.
IMPORTS = {
    ".py": re.compile(r"^\s*(?:from|import)\s+(?:research|scripts)\b", re.M),
    ".js": re.compile(
        r"""(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'][^"']*(?:research[/\\]|scripts[/\\]run_)"""
    ),
}


def test_product_sources_do_not_import_research_module_b():
    hits = []
    for base in PRODUCT_DIRS:
        for path in base.rglob("*"):
            pattern = IMPORTS.get(path.suffix)
            if pattern is None or "node_modules" in path.parts or "__pycache__" in path.parts:
                continue
            if path.name.endswith(".test.js"):
                continue  # unit tests may compare against research baselines
            for match in pattern.finditer(path.read_text(encoding="utf-8")):
                hits.append(f"{path.relative_to(ROOT)}: {match.group(0).strip()}")
    assert hits == []


def test_boundary_patterns_tell_imports_from_comments():
    assert IMPORTS[".py"].search("from research.module_b import run\n")
    assert IMPORTS[".js"].search('import { x } from "../../research/sft/run.mjs";')
    assert IMPORTS[".js"].search('await import("../research/a.js")')
    assert not IMPORTS[".js"].search("// reads from research/sft/experiment/coach-v5")
    assert not IMPORTS[".py"].search("# from research notes")
