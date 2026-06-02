from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional

from prepforge_chess.core.chess_core import ChessCore
from prepforge_chess.core.models import MoveSource
from prepforge_chess.storage.repositories import PrepForgeRepository


@dataclass(frozen=True)
class PgnImportOptions:
    source: MoveSource = MoveSource.IMPORTED_PGN
    skip_duplicate_lichess_games: bool = True


@dataclass
class PgnImportResult:
    total_games: int = 0
    imported_game_ids: List[str] = field(default_factory=list)
    skipped_game_ids: List[str] = field(default_factory=list)
    errors: List[str] = field(default_factory=list)
    # Non-fatal notices: a game that parsed but looks off (e.g. truncated), so
    # the UI can warn without treating the whole import as a failure.
    warnings: List[str] = field(default_factory=list)

    @property
    def imported_count(self) -> int:
        return len(self.imported_game_ids)

    @property
    def skipped_count(self) -> int:
        return len(self.skipped_game_ids)


class PgnImportService:
    """Normalize PGN text and persist imported games.

    This is the application-level entry point for "paste PGN" and a useful
    building block for Lichess imports after raw PGNs have been fetched.
    """

    def __init__(
        self,
        repository: PrepForgeRepository,
        chess_core: Optional[ChessCore] = None,
    ):
        self.repository = repository
        self.chess_core = chess_core or ChessCore()

    def import_text(
        self,
        pgn_text: str,
        options: PgnImportOptions = PgnImportOptions(),
    ) -> PgnImportResult:
        result = PgnImportResult()

        try:
            games = self.chess_core.import_pgn_games(pgn_text, source=options.source)
        except Exception as exc:  # python-chess raises several parse/illegal move exceptions.
            result.errors.append(str(exc))
            return result

        result.total_games = len(games)
        if not games:
            result.errors.append("No PGN games found.")
            return result

        # Signatures of games already stored, plus ones seen earlier in this same
        # batch, so the same game pasted/dropped twice is skipped rather than
        # duplicated. Lichess games are also deduped by id below.
        seen_signatures = self.repository.existing_move_signatures()

        for index, game in enumerate(games):
            # python-chess happily returns a Game for non-PGN junk or a header
            # block with no movetext — it just has zero moves. Catch that here so
            # a pasted-garbage import reports a clear error instead of silently
            # claiming success with an empty game.
            if not game.moves:
                label = "game {0}".format(index + 1) if len(games) > 1 else "this PGN"
                result.errors.append(
                    "No moves found in {0} — it doesn't look like a valid PGN.".format(label)
                )
                continue

            if options.skip_duplicate_lichess_games and game.lichess_id:
                existing_id = self.repository.find_game_id_by_lichess_id(game.lichess_id)
                if existing_id is not None:
                    result.skipped_game_ids.append(existing_id)
                    continue

            signature = " ".join(move.uci for move in game.moves)
            if signature in seen_signatures:
                result.skipped_game_ids.append(game.id)
                continue
            seen_signatures.add(signature)

            try:
                self.repository.save_game(game)
            except Exception as exc:
                label = game.lichess_id or game.id
                result.errors.append("{0}: {1}".format(label, exc))
                continue

            result.imported_game_ids.append(game.id)

        return result
