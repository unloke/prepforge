"""Product Scout must not import research Module B runners."""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PRODUCT_DIRS = (ROOT / "src", ROOT / "web-src")
IMPORT_MARKERS = (
    "from research",
    "import research",
    "research/module_b",
    "research\\\\module_b",
    "scripts/run_",
)


def test_product_sources_do_not_import_research_module_b():
    hits = []
    for base in PRODUCT_DIRS:
        for path in base.rglob("*"):
            if path.suffix not in {".py", ".js"}:
                continue
            if "node_modules" in path.parts or "__pycache__" in path.parts:
                continue
            text = path.read_text(encoding="utf-8")
            for token in IMPORT_MARKERS:
                if token in text:
                    hits.append(f"{path.relative_to(ROOT)}: {token}")
    assert hits == []
