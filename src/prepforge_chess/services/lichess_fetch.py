"""Fetch games from Lichess and feed them through the repertoire matcher."""
from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, replace
from typing import List, Optional

from prepforge_chess.core.chess_core import ChessCore
from prepforge_chess.core.models import Color, MoveSource, Game, TrainingProgress
from prepforge_chess.services.repertoire_matching import (
    RepertoireMatchResult,
    match_game_against_repertoires,
)
from prepforge_chess.services.training import update_spaced_repetition
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
    # ISO-8601 UTC *finish* time, from Lichess's `lastMoveAt` (None if unknown).
    # The "you just finished a game" watcher gates on this so it only surfaces a
    # genuinely-recent game — correct for correspondence/classical too, not just
    # bullet/blitz where start≈finish. Only the lightweight NDJSON probe populates
    # it; the PGN import path leaves it None (no consumer there needs it).
    finished_at: Optional[str] = None


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
    # The repertoire node of the move the user should have played (departures only).
    expected_node_id: Optional[str] = None
    # True once this game's departure has been recorded as a training miss.
    training_recorded: bool = False


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


def fetch_latest_games_meta(
    username: str,
    count: int,
    *,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
) -> List[FetchedGame]:
    """Lightweight metadata probe for the "you just finished a game" watcher.

    Unlike fetch_recent_pgns (which pulls PGN move text for the importer), this asks
    Lichess for NDJSON so we get `lastMoveAt` — the game's true *finish* time — which
    the recency gate needs. Move text is skipped; `pgn` is left empty and the full
    PGN is fetched separately only if the user acts on the nudge."""
    if not username or not username.strip():
        raise ValueError("lichess username is empty")
    safe_count = max(1, min(int(count), MAX_FETCH))
    safe_user = urllib.parse.quote(username.strip(), safe="")
    url = LICHESS_USER_PGN_URL.format(username=safe_user) + "?" + urllib.parse.urlencode({
        "max": safe_count,
        "moves": "false",
        "clocks": "false",
        "evals": "false",
        "opening": "false",
        "literate": "false",
    })
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/x-ndjson",
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
    return _parse_ndjson_games(raw)


def _parse_ndjson_games(text: str) -> List[FetchedGame]:
    games: List[FetchedGame] = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        games.append(_build_fetched_game_from_json(obj))
    return games


def _build_fetched_game_from_json(obj: dict) -> FetchedGame:
    players = obj.get("players") or {}
    return FetchedGame(
        pgn="",
        white=_player_name(players.get("white")),
        black=_player_name(players.get("black")),
        result=_result_from_json(obj),
        lichess_id=obj.get("id"),
        event=obj.get("perf"),
        finished_at=_iso_from_epoch_ms(obj.get("lastMoveAt")),
    )


def _player_name(side: Optional[dict]) -> Optional[str]:
    """Lichess nests the account under players.<color>.user.name; AI/anonymous
    opponents have no user object."""
    if not isinstance(side, dict):
        return None
    user = side.get("user")
    if isinstance(user, dict):
        return user.get("name") or user.get("id")
    if side.get("aiLevel"):
        return "Stockfish level {0}".format(side["aiLevel"])
    return None


def _result_from_json(obj: dict) -> str:
    winner = obj.get("winner")
    if winner == "white":
        return "1-0"
    if winner == "black":
        return "0-1"
    # Finished games without a winner are draws; anything still running is unknown.
    if obj.get("status") in (None, "started", "created"):
        return "*"
    return "1/2-1/2"


def _iso_from_epoch_ms(value) -> Optional[str]:
    """Convert Lichess's millisecond epoch (`lastMoveAt`) to ISO-8601 UTC."""
    from datetime import datetime, timezone

    if not isinstance(value, (int, float)):
        return None
    try:
        return datetime.fromtimestamp(value / 1000, tz=timezone.utc).isoformat()
    except (ValueError, OSError, OverflowError):
        return None


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
    owner_user_id: Optional[str] = None,
) -> List[GameMatchSummary]:
    fetched = fetch_recent_pgns(username, count, timeout=timeout)
    core = chess_core or ChessCore()
    # Owner-scoped: only compare against this user's own repertoires, never everyone's.
    all_repertoires = repository.list_repertoires(owner_user_id=owner_user_id)
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


# Per-owner list of lichess game ids whose departure already became a training miss,
# so re-running compare on the same games never double-counts. Capped: 50 games is the
# compare fetch maximum, so 300 remembered ids is several full pages of history.
DEPARTURE_INGESTED_KEY = "lichess.departure_misses_ingested"
_DEPARTURE_INGESTED_CAP = 300


def record_departure_misses(
    repository: PrepForgeRepository,
    summaries: List[GameMatchSummary],
    *,
    owner_user_id: Optional[str] = None,
) -> int:
    """Close the play→train loop: each game where the USER left their own prep is
    recorded as a recall miss on the expected repertoire node, so the smart queue
    schedules exactly the move they forgot (due within minutes; weak if repeated).

    Opponent novelties are NOT misses — there was nothing to recall. Idempotent per
    game via a per-owner ingested-ids list; marks each summary it recorded through
    ``training_recorded`` so the UI can say "added to training". Returns the count.
    """
    if owner_user_id is None:
        return 0
    stored = repository.get_profile_setting(owner_user_id, DEPARTURE_INGESTED_KEY, [])
    ingested = [str(item) for item in stored] if isinstance(stored, list) else []
    seen = set(ingested)
    recorded = 0
    for summary in summaries:
        if summary.departure_reason != "user_left_preparation":
            continue
        if not (summary.lichess_id and summary.repertoire_id and summary.expected_node_id):
            continue
        if summary.lichess_id in seen:
            continue
        # NB: progress rows are keyed on the repertoire alone (the trainer reads and
        # writes them with no user_profile_id — isolation rides on repertoire
        # ownership), so the miss is stored the same way or Train would never see it.
        progress = repository.load_training_progress(
            summary.repertoire_id, summary.expected_node_id
        ) or TrainingProgress(node_id=summary.expected_node_id)
        updated = update_spaced_repetition(progress, correct=False)
        # An in-session miss retries after 10 minutes; a miss from a REAL game should
        # land in the very next session, so it is due immediately.
        updated = replace(updated, due_at=updated.last_reviewed_at)
        repository.save_training_progress(summary.repertoire_id, updated)
        seen.add(summary.lichess_id)
        ingested.append(summary.lichess_id)
        summary.training_recorded = True
        recorded += 1
    if recorded:
        repository.set_profile_setting(
            owner_user_id, DEPARTURE_INGESTED_KEY, ingested[-_DEPARTURE_INGESTED_CAP:]
        )
    return recorded


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
        expected_node_id=match.expected_node_id,
    )
