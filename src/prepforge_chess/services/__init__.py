"""Application services for analysis, repertoire building, import, and training."""

from prepforge_chess.services.analysis import (
    AnalysisCancelled,
    AnalysisConfig,
    AnalysisProgress,
    AnalysisService,
    CancellationToken,
)
from prepforge_chess.services.analysis_report import AnalysisReportBuilder
from prepforge_chess.services.engine import (
    EngineAnalysisConfig,
    MockEngine,
    StockfishEngine,
)
from prepforge_chess.services.game_navigation import GameNavigationService, GameNavigationState
from prepforge_chess.services.maia import Maia3Adapter, Maia3Config, create_maia3_adapter
from prepforge_chess.services.opening_builder import CreateRepertoireRequest, OpeningBuilderService
from prepforge_chess.services.pgn_import import PgnImportOptions, PgnImportResult, PgnImportService
from prepforge_chess.services.repertoire_export import RepertoireExportService
from prepforge_chess.services.stockfish_download import install_stockfish, find_stockfish_executable
from prepforge_chess.services.training import (
    TrainingAttemptResult,
    TrainingLine,
    TrainingPrompt,
    TrainingService,
)

__all__ = [
    "AnalysisConfig",
    "AnalysisCancelled",
    "AnalysisProgress",
    "AnalysisReportBuilder",
    "AnalysisService",
    "CancellationToken",
    "EngineAnalysisConfig",
    "GameNavigationService",
    "GameNavigationState",
    "Maia3Adapter",
    "Maia3Config",
    "MockEngine",
    "CreateRepertoireRequest",
    "OpeningBuilderService",
    "PgnImportOptions",
    "PgnImportResult",
    "PgnImportService",
    "RepertoireExportService",
    "StockfishEngine",
    "TrainingAttemptResult",
    "TrainingLine",
    "TrainingPrompt",
    "TrainingService",
    "create_maia3_adapter",
    "find_stockfish_executable",
    "install_stockfish",
]
