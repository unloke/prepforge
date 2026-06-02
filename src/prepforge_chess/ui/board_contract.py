from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, List, Optional


class BoardMode(str, Enum):
    ANALYZE = "analyze"
    BUILD = "build"
    TRAIN = "train"


class HighlightKind(str, Enum):
    LEGAL_MOVE = "legal_move"
    LAST_MOVE = "last_move"
    ENGINE_BEST = "engine_best"
    USER_MISTAKE = "user_mistake"
    PREPARED_MOVE = "prepared_move"
    EXPECTED_OPPONENT = "expected_opponent"
    CRITICAL = "critical"


@dataclass(frozen=True)
class MoveIntent:
    from_square: str
    to_square: str
    promotion: Optional[str] = None

    @property
    def uci(self) -> str:
        return f"{self.from_square}{self.to_square}{self.promotion or ''}"


@dataclass(frozen=True)
class BoardArrow:
    from_square: str
    to_square: str
    kind: HighlightKind
    label: Optional[str] = None


@dataclass(frozen=True)
class SquareHighlight:
    square: str
    kind: HighlightKind
    label: Optional[str] = None


@dataclass(frozen=True)
class ExpectedMove:
    uci: str
    kind: HighlightKind
    label: Optional[str] = None
    probability: Optional[float] = None


@dataclass
class BoardState:
    fen: str
    mode: BoardMode
    legal_moves: List[str] = field(default_factory=list)
    selected_square: Optional[str] = None
    last_move_uci: Optional[str] = None
    arrows: List[BoardArrow] = field(default_factory=list)
    highlighted_squares: List[SquareHighlight] = field(default_factory=list)
    expected_moves: List[ExpectedMove] = field(default_factory=list)
    metadata: Dict[str, str] = field(default_factory=dict)

    def legal_targets_from(self, square: str) -> List[str]:
        return [move[2:4] for move in self.legal_moves if move[:2] == square]
