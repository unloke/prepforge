"""Base persistence."""
from __future__ import annotations

from typing import Dict
from sqlalchemy.engine import Engine


class Repository:
    def __init__(self, engine: Engine):
        self.engine = engine
        self._expected_revisions: Dict[str, int] = {}
