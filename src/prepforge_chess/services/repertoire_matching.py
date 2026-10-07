from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Iterable, List, Optional

import chess

from prepforge_chess.core.models import Color, MoveRecord, OpeningNode, Repertoire


@dataclass(frozen=True)
class RepertoireMatchResult:
    repertoire_id: str
    repertoire_name: str
    matched_plies: int
    last_matched_node_id: str
    departure_ply: Optional[int]
    departure_move_uci: Optional[str]
    departure_reason: str
    expected_move_uci: Optional[str] = None
    expected_move_san: Optional[str] = None
    # The repertoire node holding the move the user SHOULD have played (the expected
    # child). Lets a departure feed straight back into training as a recall miss.
    expected_node_id: Optional[str] = None
    # Position membership is independent of the first path departure. Multiple
    # nodes may share a transposition; report all, never choose an arbitrary path.
    reentry_ply: Optional[int] = None
    reentry_node_ids: tuple[str, ...] = ()


def _find_child(node: OpeningNode, move_uci: str) -> Optional[OpeningNode]:
    for child in node.children:
        if child.is_enabled and child.move and child.move.uci == move_uci:
            return child
    return None


def _departure_result(
    repertoire: Repertoire,
    node: OpeningNode,
    expected: Optional[OpeningNode],
    move: MoveRecord,
    matched_plies: int,
    user_color: Color,
) -> RepertoireMatchResult:
    """Result for the first game move the repertoire does not cover.

    The departure is attributed to whoever MOVED that move (perspective), and
    ``departure_ply`` is the move's own game ply, so the review points at the
    exact point the game stepped out of preparation.
    """
    reason = (
        "user_left_preparation"
        if move.side_to_move is user_color
        else "opponent_unprepared_branch"
    )
    return RepertoireMatchResult(
        repertoire.id,
        repertoire.name,
        matched_plies,
        node.id,
        move.ply,
        move.uci,
        reason,
        expected_move_uci=expected.move.uci if expected and expected.move else None,
        expected_move_san=expected.move.san if expected and expected.move else None,
        expected_node_id=expected.id if expected else None,
    )


def _match_game_path(
    moves: List[MoveRecord],
    repertoire: Repertoire,
    user_color: Color,
) -> RepertoireMatchResult:
    node = repertoire.root_node
    matched_plies = 0
    pending = list(moves)

    # Repertoire root determination: a root node may ARRIVE with a move (a tree
    # rooted at its first move). That move is part of the prepared line and sits
    # at its own game ply — align the game to that ply and consume it before any
    # child can match. Comparing the children first would start one ply too deep
    # and report the user's very first move as "left preparation".
    root_move = node.move
    if root_move is not None:
        index = next((i for i, m in enumerate(pending) if m.ply == root_move.ply), None)
        if index is None and pending:
            # Ply numbering disagrees (e.g. a game imported from a custom
            # starting position): fall back to the game's first remaining move.
            index = 0
        if index is not None:
            head = pending[index]
            if head.uci != root_move.uci:
                return _departure_result(
                    repertoire, node, node, head, matched_plies, user_color
                )
            matched_plies += 1
            pending = pending[index + 1 :]
        # else: the game ends before the root position — it never left prep.

    for move in pending:
        child = _find_child(node, move.uci)
        if child is None:
            expected = _pick_expected_child(node)
            return _departure_result(
                repertoire, node, expected, move, matched_plies, user_color
            )
        node = child
        matched_plies += 1

    return RepertoireMatchResult(
        repertoire.id,
        repertoire.name,
        matched_plies,
        node.id,
        None,
        None,
        "game_stayed_in_preparation",
    )


def _position_key(fen: str) -> Optional[str]:
    try:
        board = chess.Board(fen)
    except ValueError:
        return None
    if not board.is_valid():
        return None
    # Ignore move clocks but retain side, castling and legal en-passant rights.
    return " ".join(board.fen().split()[:4])


def match_game_to_repertoire(
    moves: List[MoveRecord], repertoire: Repertoire, user_color: Color
) -> RepertoireMatchResult:
    result = _match_game_path(moves, repertoire, user_color)
    if result.departure_ply is None:
        return result
    game_positions = [
        (move.ply, _position_key(move.fen_after))
        for move in moves if move.ply >= result.departure_ply
    ]
    # Hydrated FENs have canonical piece placement. A different placement cannot
    # reenter: avoid parsing, validating and serializing every unrelated node.
    placements = {key.split(" ", 1)[0] for _, key in game_positions if key is not None}
    positions: dict[str, list[str]] = {}
    pending = [repertoire.root_node]
    seen: set[str] = set()
    while pending:
        node = pending.pop()
        if node.id in seen or not node.is_enabled:
            continue
        seen.add(node.id)
        if node.fen.split(" ", 1)[0] in placements:
            key = _position_key(node.fen)
            if key is not None:
                positions.setdefault(key, []).append(node.id)
        pending.extend(node.children)
    for ply, key in game_positions:
        if key in positions:
            return replace(result, reentry_ply=ply,
                           reentry_node_ids=tuple(sorted(positions[key])))
    return result


def _pick_expected_child(node: OpeningNode) -> Optional[OpeningNode]:
    enabled = [child for child in node.children if child.is_enabled]
    if not enabled:
        return None
    mainline = next((child for child in enabled if child.is_mainline), None)
    return mainline or enabled[0]


def select_deepest_match(matches: Iterable[RepertoireMatchResult]) -> Optional[RepertoireMatchResult]:
    ordered = sorted(
        matches,
        key=lambda item: (item.matched_plies, item.departure_ply or 9999),
        reverse=True,
    )
    return ordered[0] if ordered else None


def match_game_against_repertoires(
    moves: List[MoveRecord],
    repertoires: Iterable[Repertoire],
    user_color: Color,
) -> Optional[RepertoireMatchResult]:
    relevant = [rep for rep in repertoires if rep.color is user_color]
    return select_deepest_match(match_game_to_repertoire(moves, rep, user_color) for rep in relevant)
