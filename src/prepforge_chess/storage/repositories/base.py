"""Base persistence."""
from __future__ import annotations

from typing import Dict, Optional
from sqlalchemy.engine import Engine


class Repository:
    def __init__(self, engine: Engine):
        self.engine = engine
        self._expected_revisions: Dict[str, int] = {}
        # Who is writing, for the repertoire_ops row each write appends.
        self.op_actor: Optional[str] = None
        self.op_client: Optional[str] = None
        self.op_kind: str = "edit"
