from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, List, Optional

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


def _find_child(node: OpeningNode, move_uci: str) -> Optional[OpeningNode]:
    for child in node.children:
        if child.is_enabled and child.move and child.move.uci == move_uci:
            return child
    return None


def match_game_to_repertoire(
    moves: List[MoveRecord],
    repertoire: Repertoire,
    user_color: Color,
) -> RepertoireMatchResult:
    node = repertoire.root_node
    matched_plies = 0

    for move in moves:
        child = _find_child(node, move.uci)
        if child is None:
            reason = (
                "user_left_preparation"
                if move.side_to_move is user_color
                else "opponent_unprepared_branch"
            )
            expected = _pick_expected_child(node)
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
