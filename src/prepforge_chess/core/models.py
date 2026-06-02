from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Dict, List, Optional


class Color(str, Enum):
    WHITE = "white"
    BLACK = "black"

    @property
    def opponent(self) -> "Color":
        return Color.BLACK if self is Color.WHITE else Color.WHITE


class MoveSource(str, Enum):
    HUMAN_GAME = "human_game"
    STOCKFISH = "stockfish"
    LC0 = "lc0"
    MAIA3 = "maia3"
    MANUAL = "manual"
    IMPORTED_PGN = "imported_pgn"
    LICHESS_GAME = "lichess_game"
    GENERATED_STOCKFISH = "generated_stockfish"
    GENERATED_MAIA3 = "generated_maia3"


class MoveClassification(str, Enum):
    BOOK = "book"
    BEST = "best"
    BRILLIANT = "brilliant"
    EXCELLENT = "excellent"
    GOOD = "good"
    INACCURACY = "inaccuracy"
    MISTAKE = "mistake"
    BLUNDER = "blunder"
    MISSED_WIN = "missed_win"
    MISSED_TACTIC = "missed_tactic"
    UNKNOWN = "unknown"


class GameResult(str, Enum):
    WHITE_WIN = "1-0"
    BLACK_WIN = "0-1"
    DRAW = "1/2-1/2"
    UNKNOWN = "*"


class TrainingMode(str, Enum):
    ALL_LINES = "all_lines"
    MISTAKES_ONLY = "mistakes_only"
    HIGH_PRIORITY = "high_priority"
    RECENT_PRACTICAL = "recent_practical"
    OPENING_ONLY = "opening_only"


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


@dataclass
class EngineEvaluation:
    """Engine score from White's perspective.

    `score_cp` is positive when White is better. `mate_in` is positive when
    White has mate and negative when Black has mate.
    """

    engine: str
    depth: Optional[int] = None
    nodes: Optional[int] = None
    time_ms: Optional[int] = None
    score_cp: Optional[int] = None
    mate_in: Optional[int] = None
    best_move_uci: Optional[str] = None
    pv: List[str] = field(default_factory=list)
    wdl: Optional[Dict[str, float]] = None


@dataclass
class MaiaMovePrediction:
    fen: str
    move_uci: str
    probability: float
    model: str = "maia3"
    rating_bucket: Optional[str] = None
    rank: Optional[int] = None
    sample_size: Optional[int] = None


@dataclass
class Position:
    fen: str
    side_to_move: Color
    move_number: int
    halfmove_clock: int = 0
    fullmove_number: int = 1
    legal_moves: List[str] = field(default_factory=list)
    tags: List[str] = field(default_factory=list)


@dataclass
class MoveRecord:
    uci: str
    san: str
    fen_before: str
    fen_after: str
    move_number: int
    ply: int
    side_to_move: Color
    source: MoveSource
    engine_eval_before: Optional[EngineEvaluation] = None
    engine_eval_after: Optional[EngineEvaluation] = None
    best_move_uci: Optional[str] = None
    best_move_eval: Optional[EngineEvaluation] = None
    classification: MoveClassification = MoveClassification.UNKNOWN
    comment: Optional[str] = None
    tags: List[str] = field(default_factory=list)


@dataclass
class Game:
    id: str
    source: MoveSource
    initial_fen: str
    moves: List[MoveRecord] = field(default_factory=list)
    white: Optional[str] = None
    black: Optional[str] = None
    result: GameResult = GameResult.UNKNOWN
    event: Optional[str] = None
    site: Optional[str] = None
    played_at: Optional[datetime] = None
    pgn: Optional[str] = None
    lichess_id: Optional[str] = None
    tags: Dict[str, str] = field(default_factory=dict)


@dataclass
class AnalysisResult:
    game_id: str
    analyzed_at: datetime
    engine: str
    depth: Optional[int]
    move_results: List[MoveRecord]
    summary: Dict[str, int] = field(default_factory=dict)
    critical_ply: List[int] = field(default_factory=list)


@dataclass
class OpeningNode:
    id: str
    repertoire_id: str
    fen: str
    side_to_move: Color
    move: Optional[MoveRecord] = None
    parent_id: Optional[str] = None
    children: List["OpeningNode"] = field(default_factory=list)
    engine_evaluation: Optional[EngineEvaluation] = None
    maia_probability: Optional[float] = None
    is_mainline: bool = False
    is_user_prepared_move: bool = False
    is_enabled: bool = True
    priority: float = 0.0
    comment: Optional[str] = None
    tags: List[str] = field(default_factory=list)
    # Board annotations drawn by the user. Arrows are "<from><to>" square pairs
    # (e.g. "e2e4"); circles are single squares (e.g. "d5").
    arrows: List[str] = field(default_factory=list)
    circles: List[str] = field(default_factory=list)
    tactical_warning: Optional[str] = None
    strategic_idea: Optional[str] = None
    typical_plan: Optional[str] = None
    source: MoveSource = MoveSource.MANUAL


@dataclass
class OpeningLine:
    id: str
    repertoire_id: str
    node_ids: List[str]
    name: Optional[str] = None
    priority: float = 0.0
    tags: List[str] = field(default_factory=list)


@dataclass
class Repertoire:
    id: str
    name: str
    color: Color
    root_fen: str
    root_node: OpeningNode
    main_engine: str = "stockfish"
    human_model: str = "maia3"
    branch_depth: int = 12
    opponent_branch_threshold: float = 0.10
    sub_branch_threshold: float = 0.30
    max_total_nodes: int = 1000
    max_line_length: int = 24
    notes: Optional[str] = None
    tags: List[str] = field(default_factory=list)
    is_active: bool = True


@dataclass
class TrainingProgress:
    node_id: str
    attempts: int = 0
    correct_attempts: int = 0
    last_reviewed_at: Optional[datetime] = None
    spaced_repetition_score: float = 0.0
    due_at: Optional[datetime] = None
    is_mastered: bool = False


@dataclass
class TrainingSession:
    id: str
    repertoire_id: str
    mode: TrainingMode
    line_order: List[str]
    current_index: int = 0
    current_node_id: Optional[str] = None
    mistakes: List[str] = field(default_factory=list)
    mastered_nodes: List[str] = field(default_factory=list)
    created_at: datetime = field(default_factory=utc_now)
    updated_at: datetime = field(default_factory=utc_now)
    seed: Optional[int] = None


@dataclass
class UserProfile:
    id: str
    display_name: str
    lichess_username: Optional[str] = None
    preferred_engine: str = "stockfish"
    default_analysis_depth: int = 16
    settings: Dict[str, str] = field(default_factory=dict)


@dataclass
class LichessGameImportResult:
    username: str
    requested_count: int
    imported_game_ids: List[str]
    skipped_game_ids: List[str]
    errors: List[str] = field(default_factory=list)
