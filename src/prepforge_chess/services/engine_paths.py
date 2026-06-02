from __future__ import annotations

from pathlib import Path
from typing import Iterable


def project_root() -> Path:
    return Path(__file__).resolve().parents[3]


def engine_search_dirs(*parts: str) -> Iterable[Path]:
    seen = set()
    for root in (Path.cwd(), project_root()):
        path = root.joinpath(*parts)
        key = str(path.resolve()) if path.exists() else str(path.absolute())
        if key in seen:
            continue
        seen.add(key)
        yield path
