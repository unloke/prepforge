"""Stream structural corpus nodes as JSON lines; no network or text scoring."""
import hashlib
import io
import json
import sys
import time
from pathlib import Path

import chess
import chess.pgn

BASE = Path(__file__).resolve().parent


def key(board):
    return " ".join(board.fen(en_passant="legal").split()[:4])


def convert(games):
    standard = key(chess.Board())
    chapters, edges = [], {}
    for game in games:
        start = key(game.board())
        def visit(node, board):
            parent = key(board)
            result = []
            for index, child in enumerate(node.variations):
                move = child.move
                if move not in board.legal_moves:
                    raise ValueError("Illegal PGN move")
                side = "white" if board.turn else "black"
                board.push(move)
                fen = board.fen(en_passant="legal")
                edges.setdefault(parent, set()).add(key(board))
                result.append((fen, move.uci(), side, index == 0, visit(child, board)))
                board.pop()
            return result
        start_board = game.board()
        start_board.halfmove_clock, start_board.fullmove_number = 0, 1
        chapters.append((start, visit(game, start_board)))
    raw_chapter_count = len(chapters)
    def signature(tree):
        return tuple((uci, first, signature(children)) for _, uci, _, first, children in tree)
    unique = {}
    for start, tree in chapters:
        unique.setdefault((start, signature(tree)), (start, tree))
    chapters = [unique[k] for k in sorted(unique)]
    reachable, pending = {standard}, [standard]
    while pending:
        for child in edges.get(pending.pop(), ()):
            if child not in reachable:
                reachable.add(child)
                pending.append(child)
    nodes = [{"id": "root", "parent_id": None, "fen": chess.STARTING_FEN,
              "uci": None, "is_mainline": True, "is_prepared": True,
              "is_enabled": True, "ply": 0, "move_side": None}]
    occurrence = {standard: "root"}
    def append(tree, parent, ply):
        for fen, uci, side, first, children in tree:
            node_id = str(len(nodes))
            nodes.append({"id": node_id, "parent_id": parent, "fen": fen,
                          "uci": uci, "move_side": side, "ply": ply,
                          "is_mainline": first, "is_prepared": first, "is_enabled": True})
            occurrence.setdefault(" ".join(fen.split()[:4]), node_id)
            append(children, node_id, ply + 1)
    included = sum(bool(tree) and start in reachable for start, tree in chapters)
    # Exact ordered move trees are deduplicated BEFORE custom-root attachment.
    # Thus copying a raw chapter cannot create a new empty reply occurrence.
    waiting = [(start, tree) for start, tree in chapters if tree and start in reachable]
    while waiting:
        deferred = []
        for start, tree in waiting:
            if start not in occurrence:
                deferred.append((start, tree))
                continue
            parent = occurrence[start]
            parent_ply = 0 if parent == "root" else nodes[int(parent)]["ply"]
            append(tree, parent, parent_ply + 1)
        if len(deferred) == len(waiting):
            raise ValueError("Reachable custom root cannot be attached")
        waiting = deferred
    return nodes, {"raw_chapter_count": raw_chapter_count,
                   "exact_chapter_duplicates_removed": raw_chapter_count - len(chapters),
                   "distinct_structural_chapters": len(chapters),
                   "included_chapters": included,
                   "diagram_only_chapters": sum(not tree for _, tree in chapters),
                   "excluded_disconnected_chapters": sum(bool(tree) and start not in reachable for start, tree in chapters),
                   "excluded_custom_root_keys": sorted({start for start, tree in chapters if tree and start not in reachable}),
                   "attached_custom_chapters": sum(bool(tree) and start != standard and start in reachable for start, tree in chapters)}


def regression():
    """Independent minimal standard-line + custom-continuation duplication."""
    standard = chess.pgn.Game()
    first = standard.add_variation(chess.Move.from_uci("e2e4"))
    first.add_variation(chess.Move.from_uci("e7e5"))
    board = chess.Board()
    board.push_uci("e2e4")
    board.push_uci("e7e5")
    custom = chess.pgn.Game()
    custom.setup(board)
    custom.add_variation(chess.Move.from_uci("g1f3"))
    nodes, scope = convert([standard, custom])
    copied, duplicate_scope = convert([standard, custom] * 2)
    assert len(nodes) == 4 and copied == nodes
    assert convert([custom, standard])[0] == nodes
    assert scope["raw_chapter_count"] == 2
    assert duplicate_scope["raw_chapter_count"] == 4
    assert duplicate_scope["exact_chapter_duplicates_removed"] == 2
    # FEN counters, comments and descriptive headers do not affect identity.
    custom.headers["FEN"] = key(board) + " 17 99"
    custom.comment = "irrelevant"
    assert convert([standard, custom] * 2)[0] == nodes


def main():
    regression()
    for item in json.loads((BASE / "corpus/manifest.json").read_text(encoding="utf8")):
        started = time.perf_counter()
        raw = (BASE / "corpus" / item["file"]).read_bytes()
        assert hashlib.sha256(raw).hexdigest() == item["sha256"]
        stream, games = io.StringIO(raw.decode("utf-8-sig")), []
        while (game := chess.pgn.read_game(stream)) is not None:
            if game.errors:
                raise ValueError(game.errors)
            games.append(game)
        nodes, scope = convert(games)
        checks = {}
        for mode in ("empty", "ones"):
            for game in games:
                for header in list(game.headers):
                    if header not in ("FEN", "SetUp", "Variant"):
                        game.headers[header] = "irrelevant"
                stack = [game]
                while stack:
                    node = stack.pop()
                    node.comment = node.starting_comment = "" if mode == "empty" else "1"
                    node.nags.clear()
                    if mode == "ones":
                        node.nags.add(1)
                    stack.extend(node.variations)
            checks[mode] = convert(games) == (nodes, scope)
        duplicate, duplicate_scope = convert(games + games)
        assert duplicate == nodes, f"{item['id']}: raw chapter duplication changed converted nodes"
        reverse_invariant = convert(list(reversed(games))) == (nodes, scope)
        assert reverse_invariant, f"{item['id']}: reversed chapters changed converted input"
        print(json.dumps({"id": item["id"], "color": item["color"],
                          "role": item["content_role"], "sha256": item["sha256"],
                          "scope": scope, "duplicate_scope": duplicate_scope,
                          "nodes": nodes, "duplicate_nodes": duplicate,
                          "reverse_chapters_exact_input_invariance": reverse_invariant,
                          "annotation_conversion_invariance": checks,
                          "conversion_seconds": time.perf_counter() - started}), flush=True)


if __name__ == "__main__":
    main()
