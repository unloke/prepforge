from __future__ import annotations

import io
from dataclasses import dataclass, field
from typing import List, Optional

import chess.pgn

from prepforge_chess.core.chess_core import ChessCore
from prepforge_chess.core.models import MoveSource
from prepforge_chess.storage import codec
from prepforge_chess.storage.repositories.games import GameRepository


@dataclass(frozen=True)
class PgnImportOptions:
    source: MoveSource = MoveSource.IMPORTED_PGN
    skip_duplicate_lichess_games: bool = True


@dataclass
class ParsedGame:
    """One game parsed out of a multi-game PGN, with its own parse status.

    Parse failures are isolated per game (F-04): one broken game must not make
    the whole paste look like a total failure.
    """

    index: int  # 0-based position in the text
    text: str = ""
    white: Optional[str] = None
    black: Optional[str] = None
    error: Optional[str] = None


@dataclass
class GameImportStatus:
    """What actually happened to one game (F-04): imported fresh, already
    present (existing id), or failed with a reason."""

    index: int
    status: str  # "imported" | "existing" | "failed"
    game_id: Optional[str] = None
    white: Optional[str] = None
    black: Optional[str] = None
    error: Optional[str] = None



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
        repository: GameRepository,
        chess_core: Optional[ChessCore] = None,
    ):
        self.repository = repository
        self.chess_core = chess_core or ChessCore()

    def import_text(
        self,
        pgn_text: str,
        options: PgnImportOptions = PgnImportOptions(),
        owner_user_id: Optional[str] = None,
    ) -> PgnImportResult:
        """Import games, owner-scoped when ``owner_user_id`` is given: dedup looks
        only at that owner's existing games and saved games are stamped with the
        owner, so two users importing the same game keep independent copies."""
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
        # duplicated. Lichess games are also deduped by id below. A signature is
        # initial position + UCI sequence (``codec.move_signature``), so the same
        # moves from a different starting position are different games.
        signature_to_id = self.repository.existing_move_signature_ids(owner_user_id)

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
                existing_id = self.repository.find_game_id_by_lichess_id(
                    game.lichess_id, owner_user_id
                )
                if existing_id is not None:
                    result.skipped_game_ids.append(existing_id)
                    continue

            signature = codec.move_signature(
                game.initial_fen, (move.uci for move in game.moves)
            )
            existing_signature_id = signature_to_id.get(signature)
            if existing_signature_id is not None:
                # Duplicate of an already-stored game: report the EXISTING id so
                # callers (re-analysis) can load it, not the fresh unsaved one.
                result.skipped_game_ids.append(existing_signature_id)
                continue

            try:
                self.repository.save_game(game, owner_user_id=owner_user_id)
            except Exception as exc:
                label = game.lichess_id or game.id
                result.errors.append("{0}: {1}".format(label, exc))
                continue

            signature_to_id[signature] = game.id
            result.imported_game_ids.append(game.id)

        return result

    # ---- F-04: multi-game semantics -------------------------------------

    def parse_text(self, pgn_text: str) -> List[ParsedGame]:
        """Split a (possibly multi-game) PGN into per-game texts WITHOUT storing
        anything, isolating parse errors per game. This is the "validate before
        you store" phase: single-game callers can reject a multi-game paste
        before any game lands."""
        stream = io.StringIO(pgn_text or "")
        out: List[ParsedGame] = []
        index = 0
        # Read one game at a time so a parse error in game 2 can't void
        # game 1 (import_pgn_games raises for the whole text).
        while True:
            try:
                game = chess.pgn.read_game(stream)
            except Exception as exc:  # python-chess parse errors vary by version
                out.append(ParsedGame(index=index, error=str(exc)))
                index += 1
                continue
            if game is None:
                break
            if game.errors:
                first = game.errors[0]
                message = getattr(first, "args", [None])[0] or str(first)
                out.append(
                    ParsedGame(index=index, error="parse error: {0}".format(message))
                )
            else:
                out.append(
                    ParsedGame(
                        index=index,
                        text=str(game),
                        white=game.headers.get("White"),
                        black=game.headers.get("Black"),
                    )
                )
            index += 1
        return out

    def import_parsed(
        self,
        parsed_games: List[ParsedGame],
        options: PgnImportOptions = PgnImportOptions(),
        owner_user_id: Optional[str] = None,
    ) -> List[GameImportStatus]:
        """Import each parsed game independently (F-04): per-game
        imported/existing/failed status, never a fake all-or-nothing result."""
        out: List[GameImportStatus] = []
        for parsed in parsed_games:
            if parsed.error is not None or not parsed.text:
                out.append(
                    GameImportStatus(
                        index=parsed.index,
                        status="failed",
                        white=parsed.white,
                        black=parsed.black,
                        error=parsed.error or "parse error",
                    )
                )
                continue
            result = self.import_text(parsed.text, options, owner_user_id=owner_user_id)
            if result.imported_game_ids:
                out.append(
                    GameImportStatus(
                        index=parsed.index,
                        status="imported",
                        game_id=result.imported_game_ids[0],
                        white=parsed.white,
                        black=parsed.black,
                    )
                )
            elif result.skipped_game_ids:
                out.append(
                    GameImportStatus(
                        index=parsed.index,
                        status="existing",
                        game_id=result.skipped_game_ids[0],
                        white=parsed.white,
                        black=parsed.black,
                    )
                )
            else:
                out.append(
                    GameImportStatus(
                        index=parsed.index,
                        status="failed",
                        white=parsed.white,
                        black=parsed.black,
                        error="; ".join(result.errors) or "import failed",
                    )
                )
        return out
