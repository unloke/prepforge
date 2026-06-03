"""Fetch games from Lichess and feed them through the repertoire matcher."""
from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Iterable, List, Optional, Tuple

from prepforge_chess.core.chess_core import ChessCore
from prepforge_chess.core.models import Color, MoveSource, Game
from prepforge_chess.services.repertoire_matching import (
    RepertoireMatchResult,
    match_game_against_repertoires,
)
from prepforge_chess.storage.repositories import PrepForgeRepository


LICHESS_USER_PGN_URL = "https://lichess.org/api/games/user/{username}"
DEFAULT_TIMEOUT_SECONDS = 15
MAX_FETCH = 50


class LichessFetchError(RuntimeError):
    pass


@dataclass
class FetchedGame:
    pgn: str
    white: Optional[str]
    black: Optional[str]
    result: str
    lichess_id: Optional[str]
    event: Optional[str]


@dataclass
class GameMatchSummary:
    lichess_id: Optional[str]
    white: Optional[str]
    black: Optional[str]
    result: str
    user_color: str
    in_repertoire: bool
    matched_plies: int
    departure_ply: Optional[int]
    departure_move_uci: Optional[str]
    departure_reason: str
    repertoire_id: Optional[str]
    repertoire_name: Optional[str]
    move_san_history: List[str]
    expected_move_uci: Optional[str]
    expected_move_san: Optional[str]


def fetch_recent_pgns(
    username: str,
    count: int,
    *,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
    include_moves: bool = True,
) -> List[FetchedGame]:
    if not username or not username.strip():
        raise ValueError("lichess username is empty")
    safe_count = max(1, min(int(count), MAX_FETCH))
    safe_user = urllib.parse.quote(username.strip(), safe="")
    # When the caller only needs to know *whether* a new game exists (the
    # background "you just finished a game" watcher), skip the move text so
    # Lichess returns just the tag pairs — a much smaller, faster response.
    url = LICHESS_USER_PGN_URL.format(username=safe_user) + "?" + urllib.parse.urlencode({
        "max": safe_count,
        "moves": "true" if include_moves else "false",
        "clocks": "false",
        "evals": "false",
        "opening": "false",
        "literate": "false",
        "pgnInJson": "false",
    })
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/x-chess-pgn",
            "User-Agent": "PrepForge/0.1 (local-tool)",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        raise LichessFetchError(
            "Lichess responded with HTTP {0} for user {1}".format(exc.code, username)
        ) from exc
    except urllib.error.URLError as exc:
        raise LichessFetchError(
            "Could not reach Lichess: {0}".format(exc.reason)
        ) from exc

    return _split_multi_pgn(raw)


def _split_multi_pgn(text: str) -> List[FetchedGame]:
    games: List[FetchedGame] = []
    buffer: List[str] = []
    in_moves = False
    for raw_line in text.splitlines():
        line = raw_line.rstrip()
        if line.startswith("[") and in_moves and buffer:
            block = "\n".join(buffer).strip()
            if block:
                games.append(_build_fetched_game(block))
            buffer = []
            in_moves = False
        if not line.startswith("[") and line.strip():
            in_moves = True
        if line or buffer:
            buffer.append(raw_line)
    block = "\n".join(buffer).strip()
    if block:
        games.append(_build_fetched_game(block))
    return games


def _build_fetched_game(pgn_block: str) -> FetchedGame:
    headers = _parse_pgn_headers(pgn_block)
    return FetchedGame(
        pgn=pgn_block + "\n",
        white=headers.get("White"),
        black=headers.get("Black"),
        result=headers.get("Result", "*"),
        lichess_id=_extract_lichess_id(headers.get("Site")),
        event=headers.get("Event"),
    )


def _parse_pgn_headers(pgn_block: str) -> dict:
    headers: dict = {}
    for line in pgn_block.splitlines():
        line = line.strip()
        if not line.startswith("["):
            break
        if not line.endswith("]"):
            continue
        inside = line[1:-1].strip()
        if " " not in inside:
            continue
        key, rest = inside.split(" ", 1)
        rest = rest.strip()
        if rest.startswith('"') and rest.endswith('"') and len(rest) >= 2:
            headers[key] = rest[1:-1]
    return headers


def _extract_lichess_id(site: Optional[str]) -> Optional[str]:
    if not site:
        return None
    cleaned = site.rstrip("/")
    if "lichess.org" not in cleaned:
        return None
    tail = cleaned.rsplit("/", 1)[-1]
    return tail or None


def determine_user_color(white: Optional[str], black: Optional[str], username: str) -> Optional[Color]:
    needle = username.strip().lower()
    if white and white.strip().lower() == needle:
        return Color.WHITE
    if black and black.strip().lower() == needle:
        return Color.BLACK
    return None


def compare_recent_games(
    repository: PrepForgeRepository,
    username: str,
    count: int,
    *,
    chess_core: Optional[ChessCore] = None,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
) -> List[GameMatchSummary]:
    fetched = fetch_recent_pgns(username, count, timeout=timeout)
    core = chess_core or ChessCore()
    all_repertoires = repository.list_repertoires()
    active_repertoires = [rep for rep in all_repertoires if getattr(rep, "is_active", True)]

    summaries: List[GameMatchSummary] = []
    for entry in fetched:
        try:
            games = core.import_pgn_games(entry.pgn, source=MoveSource.IMPORTED_PGN)
        except ValueError:
            continue
        if not games:
            continue
        game = games[0]
        user_color = determine_user_color(entry.white, entry.black, username)
        if user_color is None:
            continue

        match = match_game_against_repertoires(
            game.moves,
            active_repertoires,
            user_color,
        )
        san_history = [move.san for move in game.moves]
        summary = _build_summary(entry, user_color, match, san_history, game)
        summaries.append(summary)
    return summaries


def _build_summary(
    entry: FetchedGame,
    user_color: Color,
    match: Optional[RepertoireMatchResult],
    san_history: List[str],
    game: Game,
) -> GameMatchSummary:
    if match is None:
        return GameMatchSummary(
            lichess_id=entry.lichess_id,
            white=entry.white,
            black=entry.black,
            result=entry.result,
            user_color=user_color.value,
            in_repertoire=False,
            matched_plies=0,
            departure_ply=None,
            departure_move_uci=None,
            departure_reason="no_repertoire_for_color",
            repertoire_id=None,
            repertoire_name=None,
            move_san_history=san_history,
            expected_move_uci=None,
            expected_move_san=None,
        )

    return GameMatchSummary(
        lichess_id=entry.lichess_id,
        white=entry.white,
        black=entry.black,
        result=entry.result,
        user_color=user_color.value,
        in_repertoire=match.matched_plies > 0,
        matched_plies=match.matched_plies,
        departure_ply=match.departure_ply,
        departure_move_uci=match.departure_move_uci,
        departure_reason=match.departure_reason,
        repertoire_id=match.repertoire_id,
        repertoire_name=match.repertoire_name,
        move_san_history=san_history,
        expected_move_uci=match.expected_move_uci,
        expected_move_san=match.expected_move_san,
    )
