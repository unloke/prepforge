from typing import List

from prepforge_chess.core.models import (
    Color,
    MoveRecord,
    MoveSource,
    OpeningNode,
    Repertoire,
)
from prepforge_chess.services.repertoire_matching import (
    match_game_against_repertoires,
    match_game_to_repertoire,
)


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


def _rooted_rep(rep_id: str, name: str, root_uci: str, root_ply: int, rest: List[str]) -> Repertoire:
    """A repertoire ROOTED AT ITS FIRST MOVE: the root node itself arrives with
    ``root_uci`` (the shape package import / root_node_id data produces)."""
    mover = Color.WHITE if root_ply % 2 == 1 else Color.BLACK
    root = OpeningNode(
        id=f"{rep_id}-root",
        repertoire_id=rep_id,
        fen="fen-root",
        side_to_move=mover.opponent,
        move=_move(root_uci, root_ply, mover),
    )
    current = root
    side = mover.opponent
    for offset, uci in enumerate(rest, start=1):
        ply = root_ply + offset
        record = _move(uci, ply, side)
        child = OpeningNode(
            id=f"{rep_id}-{ply}",
            repertoire_id=rep_id,
            fen=f"fen-{ply}",
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
        root_fen="fen-root",
        root_node=root,
    )


def test_rooted_repertoire_matches_the_users_first_move():
    """Regression (Games prep 判定): a repertoire rooted at its first move must
    match that move as the user's own first move — never claim the user left
    preparation at the very first ply just because the root carries the move."""
    rep = _rooted_rep("r", "Rooted", "e2e4", 1, ["e7e5"])
    game = [
        _move("e2e4", 1, Color.WHITE),
        _move("e7e5", 2, Color.BLACK),
    ]
    result = match_game_to_repertoire(game, rep, Color.WHITE)
    assert result.matched_plies == 2
    assert result.departure_reason == "game_stayed_in_preparation"


def test_rooted_repertoire_departure_is_the_movers_with_the_root_move_expected():
    rep = _rooted_rep("r", "Rooted", "e2e4", 1, ["e7e5"])
    # The user (White) plays 1.d4 instead of the prepared root move 1.e4.
    result = match_game_to_repertoire([_move("d2d4", 1, Color.WHITE)], rep, Color.WHITE)
    assert result.departure_ply == 1
    assert result.departure_reason == "user_left_preparation"
    assert result.expected_move_uci == "e2e4"
    assert result.expected_node_id == "r-root"

    # An OPPONENT departure off the root move is never blamed on the user.
    black_rep = _rooted_rep("rb", "RootedBlack", "e2e4", 1, ["c7c5"])
    result = match_game_to_repertoire([_move("d2d4", 1, Color.WHITE)], black_rep, Color.BLACK)
    assert result.departure_ply == 1
    assert result.departure_reason == "opponent_unprepared_branch"


def test_rooted_repertoire_aligns_the_game_to_the_root_ply():
    """A root arriving at ply 3: the pre-root moves are outside the repertoire's
    scope, and matching starts at the root move's own ply."""
    rep = _rooted_rep("r", "MidRoot", "g1f3", 3, ["g8f6"])
    game = [
        _move("e2e4", 1, Color.WHITE),
        _move("e7e5", 2, Color.BLACK),
        _move("g1f3", 3, Color.WHITE),
        _move("g8f6", 4, Color.BLACK),
        _move("f1b5", 5, Color.WHITE),
    ]
    result = match_game_to_repertoire(game, rep, Color.WHITE)
    assert result.matched_plies == 2  # root move + prepared reply
    assert result.departure_ply == 5
    assert result.departure_reason == "user_left_preparation"  # White moved 5.Bb5


def test_hydrated_tree_keeps_the_root_arriving_move():
    """Regression (repertoire root 判定): loading a stored tree must not drop the
    root node's arriving move — the prep comparison anchors on it."""
    from prepforge_chess.storage import codec

    after_e4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"
    root = OpeningNode(
        id="root", repertoire_id="r", fen=after_e4, side_to_move=Color.BLACK
    )
    child = OpeningNode(
        id="c1", repertoire_id="r", parent_id="root", fen="x", side_to_move=Color.WHITE
    )
    tree = codec.hydrate_opening_tree(
        after_e4, {"root": root, "c1": child}, {"root": "e2e4", "c1": "e7e5"}
    )
    assert tree is not None
    assert tree.move is not None
    assert tree.move.uci == "e2e4"
    assert tree.move.ply == 1
    assert tree.move.side_to_move is Color.WHITE  # White made the root move
    assert [c.move.uci for c in tree.children] == ["e7e5"]

    # …and the hydrated tree matches the game from the root move on.
    rep = Repertoire(id="r", name="r", color=Color.WHITE, root_fen=after_e4, root_node=tree)
    game = [
        _move("e2e4", 1, Color.WHITE),
        _move("e7e5", 2, Color.BLACK),
    ]
    result = match_game_to_repertoire(game, rep, Color.WHITE)
    assert result.matched_plies == 2
    assert result.departure_reason == "game_stayed_in_preparation"


def test_hydrated_root_move_synthetic_fields_contract():
    """Contract pin (hydrate_opening_tree's synthetic root MoveRecord): only
    uci/ply/move_number/side_to_move/source are trustworthy; san mirrors the
    UCI and fens echo the root position (the pre-root board is not stored).
    These assertions document what every consumer may rely on — san/fens are
    display-only filler and must not feed board or PGN reconstruction."""
    from prepforge_chess.storage import codec

    after_e4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"
    # A BLACK-side root (root move 1...c5 arrives at ply 2): the same metadata
    # rules must hold for black root moves.
    after_c5 = "rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2"
    white_root = OpeningNode(
        id="rw", repertoire_id="r", fen=after_e4, side_to_move=Color.BLACK
    )
    black_root = OpeningNode(
        id="rb", repertoire_id="r", fen=after_c5, side_to_move=Color.WHITE
    )
    white_tree = codec.hydrate_opening_tree(
        after_e4, {"rw": white_root}, {"rw": "e2e4"}
    )
    black_tree = codec.hydrate_opening_tree(
        after_c5, {"rb": black_root}, {"rb": "c7c5"}
    )
    assert white_tree is not None and black_tree is not None

    w = white_tree.move
    assert w is not None
    assert w.uci == "e2e4"
    assert w.ply == 1
    assert w.move_number == 1  # white root: the root FEN's fullmove field
    assert w.side_to_move is Color.WHITE
    assert w.source is white_tree.source
    # Synthetic filler: san mirrors the UCI and both fens echo the root FEN.
    assert w.san == "e2e4"
    assert w.fen_before == after_e4
    assert w.fen_after == after_e4

    b = black_tree.move
    assert b is not None
    assert b.uci == "c7c5"
    assert b.ply == 2
    # Black-root quirk, pinned as-is: move_number echoes the root FEN's
    # fullmove field (2 after 1...c5), not the mover's 1. No consumer depends
    # on it (display filler + a FEN-first client fallback only).
    assert b.move_number == 2
    assert b.side_to_move is Color.BLACK
    assert b.source is black_tree.source
    assert b.san == "c7c5"
    assert b.fen_before == after_c5
    assert b.fen_after == after_c5
