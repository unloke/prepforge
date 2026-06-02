from typing import List

from prepforge_chess.core.models import (
    Color,
    MoveRecord,
    MoveSource,
    OpeningNode,
    Repertoire,
)
from prepforge_chess.services.repertoire_matching import match_game_against_repertoires


def _move(uci: str, ply: int, side: Color) -> MoveRecord:
    return MoveRecord(
        uci=uci,
        san=uci,
        fen_before=f"before-{ply}",
        fen_after=f"after-{ply}",
        move_number=(ply + 1) // 2,
        ply=ply,
        side_to_move=side,
        source=MoveSource.HUMAN_GAME,
    )


def _rep(rep_id: str, name: str, moves: List[str]) -> Repertoire:
    root = OpeningNode(
        id=f"{rep_id}-root",
        repertoire_id=rep_id,
        fen="startpos",
        side_to_move=Color.WHITE,
    )
    current = root
    side = Color.WHITE
    for index, uci in enumerate(moves, start=1):
        record = _move(uci, index, side)
        child = OpeningNode(
            id=f"{rep_id}-{index}",
            repertoire_id=rep_id,
            fen=f"fen-{index}",
            side_to_move=side.opponent,
            move=record,
            parent_id=current.id,
        )
        current.children.append(child)
        current = child
        side = side.opponent
    return Repertoire(
        id=rep_id,
        name=name,
        color=Color.WHITE,
        root_fen="startpos",
        root_node=root,
    )


def test_matching_selects_deepest_repertoire():
    game = [
        _move("e2e4", 1, Color.WHITE),
        _move("c7c5", 2, Color.BLACK),
        _move("g1f3", 3, Color.WHITE),
    ]
    shallow = _rep("a", "Short", ["e2e4"])
    deep = _rep("b", "Sicilian", ["e2e4", "c7c5", "g1f3"])

    result = match_game_against_repertoires(game, [shallow, deep], Color.WHITE)

    assert result is not None
    assert result.repertoire_id == "b"
    assert result.matched_plies == 3
    assert result.departure_reason == "game_stayed_in_preparation"
