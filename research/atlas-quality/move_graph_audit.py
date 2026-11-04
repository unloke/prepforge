"""Research-only move-graph diagnostics. No quality score or semantic inputs.

Run from the repository root with .venv313/Scripts/python.exe and this path.
Only PGN structural starting positions and legal moves enter audit(); color is
explicit. Comments, annotations, descriptive headers and external data do not.
"""
import hashlib
import io
import json
import math
import statistics
import time
from collections import Counter, deque
from pathlib import Path

import chess
import chess.pgn

BASE = Path(__file__).resolve().parent


def key(board):
    return " ".join(board.fen(en_passant="legal").split()[:4])


def chapters_from_games(games):
    """Boundary adapter: retain only the structural start and legal move tree."""
    def moves(node):
        return tuple(sorted(((child.move.uci(), moves(child)) for child in node.variations)))
    return [(key(game.board()), moves(game)) for game in games]


def distribution(values):
    values = sorted(values)
    return {"count": len(values), "min": values[0] if values else None,
            "median": statistics.median(values) if values else None,
            "p90": values[math.ceil(.9 * len(values)) - 1] if values else None,
            "max": values[-1] if values else None,
            "histogram": dict(sorted(Counter(values).items()))}


def distances(roots, edges):
    dist = {root: 0 for root in sorted(roots)}
    queue = deque(dist)
    while queue:
        parent = queue.popleft()
        for child in sorted(set(edges[parent].values())):
            if child not in dist:
                dist[child] = dist[parent] + 1
                queue.append(child)
    return dist


def audit(chapters, color):
    """Input contains canonical start FENs and nested UCI tuples, no metadata.

    A diagram is a chapter with no move. Its root is recorded, but cannot create
    a route, own decision, or potential unanswered continuation. Histories and
    clocks are intentionally excluded: nonterminal means legal moves exist,
    not a claim about repetition/fifty-move adjudication.
    """
    if color not in ("white", "black", "both"):
        raise ValueError("Explicit white/black/both color required")
    edges, all_positions, active, starts, diagrams = {}, set(), set(), set(), set()
    examples, incoming = {}, {}
    position_occurrences = move_occurrences = diagram_count = 0
    occurrence_leaf_depths = []
    for start, tree in chapters:
        all_positions.add(start)
        if not tree:
            position_occurrences += 1
            diagram_count += 1
            diagrams.add(start)
            continue
        starts.add(start)
        stack = [(chess.Board(start + " 0 1"), tree, (), ())]
        while stack:
            board, children, uci_path, san_path = stack.pop()
            parent = key(board)
            all_positions.add(parent)
            active.add(parent)
            edges.setdefault(parent, {})
            position_occurrences += 1
            candidate = (len(uci_path), start, uci_path, san_path)
            if parent not in examples or candidate < examples[parent]:
                examples[parent] = candidate
            if not children and uci_path:
                occurrence_leaf_depths.append(len(uci_path))
            for uci, grandchildren in children:
                move = chess.Move.from_uci(uci)
                if move not in board.legal_moves:
                    raise ValueError(f"Illegal edge {uci} at {parent}")
                san = board.san(move)
                child_board = board.copy(stack=False)
                child_board.push(move)
                child = key(child_board)
                previous = edges[parent].setdefault(uci, child)
                if previous != child:
                    raise ValueError("Conflicting canonical move edge")
                move_occurrences += 1
                stack.append((child_board, grandchildren, uci_path + (uci,), san_path + (san,)))
    for parent, outgoing in edges.items():
        for child in outgoing.values():
            incoming.setdefault(child, set()).add(parent)
    leaves = sorted(p for p in active if not edges[p])
    near = distances(starts, edges)
    standard = key(chess.Board())
    standard_dist = distances({standard}, edges) if standard in active else {}
    # Weak components group starting roots without asserting directed reach.
    neighbors = {p: set() for p in active}
    for parent, outgoing in edges.items():
        for child in outgoing.values():
            neighbors[parent].add(child)
            neighbors[child].add(parent)
    components, remaining = [], set(active)
    while remaining:
        first = min(remaining)
        group, queue = {first}, [first]
        remaining.remove(first)
        while queue:
            for child in neighbors[queue.pop()]:
                if child in remaining:
                    remaining.remove(child)
                    group.add(child)
                    queue.append(child)
        components.append({"positions": len(group),
            "edges": sum(len(edges[p]) for p in group),
            "chapter_root_keys": sorted(group & starts),
            "contains_standard_position": standard in group})
    per_side = {}
    for side in ("white", "black") if color == "both" else (color,):
        own = {p for p in active if p.split()[1] == ("w" if side == "white" else "b")}
        unanswered = [p for p in leaves if p in own and any(chess.Board(p + " 0 1").legal_moves)]
        shown = []
        for position in sorted(unanswered, key=lambda p: (examples[p][0], p))[:3]:
            length, start, uci_path, san_path = examples[position]
            shown.append({"start_fen": start + " 0 1", "uci_path": list(uci_path),
                          "san_path": list(san_path), "relative_ply": length,
                          "end_position": position,
                          "source": "actual single chapter move path; counters normalized"})
        per_side[side] = {
            "own_turn_distinct_choice_histogram": dict(sorted(Counter(len(edges[p]) for p in own).items())),
            "own_decision_positions_with_stored_choices": sum(bool(edges[p]) for p in own),
            "nonterminal_own_to_move_leaves": len(unanswered), "examples": shown}
    unique_edges = sum(map(len, edges.values()))
    graph = {"unique_positions_including_diagrams": len(all_positions),
             "active_unique_positions": len(active), "unique_edges": unique_edges,
             "active_chapter_root_keys": sorted(starts),
             "diagram_only_root_keys": sorted(diagrams - active),
             "custom_start_keys": sorted((starts | diagrams) - {standard}),
             "weak_root_connectivity_groups": components,
             "active_roots_directed_reachable_from_standard": sorted(starts & standard_dist.keys()),
             "active_roots_not_directed_reachable_from_standard": sorted(starts - standard_dist.keys()),
             "positions_with_multiple_distinct_incoming_parents": sum(len(v) > 1 for v in incoming.values()),
             "graph_terminal_positions": len(leaves),
             "shortest_relative_ply_from_any_active_chapter_root": distribution(near.values()),
             "graph_leaf_shortest_relative_ply": distribution(near[p] for p in leaves),
             "shortest_ply_from_standard_position": distribution(standard_dist.values()),
             "active_positions_unreachable_from_standard": len(active - standard_dist.keys()),
             "by_side": per_side}
    return {"graph": graph, "occurrences": {
        "chapters": len(chapters), "diagram_only_chapters": diagram_count,
        "position_occurrences_including_roots": position_occurrences,
        "move_edge_occurrences": move_occurrences,
        "merged_position_occurrence_savings": position_occurrences - len(all_positions),
        "merged_edge_occurrence_savings": move_occurrences - unique_edges,
        "chapter_terminal_relative_ply": distribution(occurrence_leaf_depths)}}


def invariance(games, color, original):
    """All-corpus mutation check. No file is modified."""
    outcomes = {}
    for mode in ("empty", "ones", "drawing_tags"):
        for game in games:
            for field in list(game.headers):
                if field not in ("FEN", "SetUp", "Variant"):
                    game.headers[field] = "irrelevant mutated title/header"
            stack = [game]
            while stack:
                node = stack.pop()
                node.comment = "" if mode == "empty" else "1"
                node.starting_comment = node.comment
                node.nags.clear()
                if mode != "empty":
                    node.nags.add(1 if mode == "ones" else 4)
                if mode == "drawing_tags":
                    node.comment += " [%cal Ga1a2][%csl Re4][%eval 99.9]"
                stack.extend(node.variations)
        outcomes[mode] = audit(chapters_from_games(games), color) == original
    chapters = chapters_from_games(games)
    duplicated = audit(chapters + chapters, color)
    outcomes["duplicate_all_chapters_merged_graph"] = duplicated["graph"] == original["graph"]
    outcomes["duplicate_all_chapters_occurrences_double"] = (
        duplicated["occurrences"]["move_edge_occurrences"] == 2 * original["occurrences"]["move_edge_occurrences"])
    if not all(outcomes.values()):
        raise AssertionError(outcomes)
    return outcomes


def main():
    started = time.perf_counter()
    manifest = json.loads((BASE / "corpus/manifest.json").read_text(encoding="utf8"))
    rows = []
    for item in manifest:
        raw = (BASE / "corpus" / item["file"]).read_bytes()
        assert hashlib.sha256(raw).hexdigest() == item["sha256"]
        stream, games = io.StringIO(raw.decode("utf-8-sig")), []
        while (game := chess.pgn.read_game(stream)) is not None:
            if game.errors:
                raise ValueError(f"PGN parse errors for {item['id']}: {game.errors}")
            games.append(game)
        audit_start = time.perf_counter()
        result = audit(chapters_from_games(games), item["color"])
        audit_seconds = time.perf_counter() - audit_start
        check_start = time.perf_counter()
        checks = invariance(games, item["color"], result)
        rows.append({"study_id": item["id"], "color": item["color"],
                     "raw_sha256": item["sha256"], **result, "invariance": checks,
                     "cost_seconds": {"original_audit": audit_seconds,
                                      "invariance": time.perf_counter() - check_start}})
        print(f"{len(rows)}/{len(manifest)} {item['id']}: {result['graph']['active_unique_positions']} active positions; invariance passed", flush=True)
    output = {
        "method": "canonical-legal-move-union-v1", "python_chess_version": chess.__version__,
        "limitations": ["Diagnostics only; no quality score or semantic assessment.",
            "Own alternatives are not errors; intentional endings are not established holes.",
            "Merged savings include repeated chapter prefixes and duplicates, not only move-order transpositions.",
            "Diagram-only chapters create no routes or decision opportunities.",
            "Only structural start FEN and UCI trees enter the core; no comments, NAGs, prose headers, stars, engines or LLM outputs.",
            "Position identity ignores clocks and history; nonterminal means legal moves exist. Draw adjudication is not evaluated.",
            "Shortest graph depths are relative to recorded chapter roots; terminal occurrence depths are relative to each original chapter root.",
            "Examples are legal paths from individual source chapters; endpoints are leaves only after all chapter continuations are merged."],
        "studies": rows,
        "totals": {"studies": len(rows), "raw_bytes": sum(r["bytes"] for r in manifest),
                   "original_audit_seconds": sum(r["cost_seconds"]["original_audit"] for r in rows),
                   "wall_seconds": time.perf_counter() - started,
                   "all_corpus_invariance_passed": all(all(r["invariance"].values()) for r in rows)}}
    (BASE / "move-graph-results.json").write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
    print(json.dumps(output["totals"], indent=2))


if __name__ == "__main__":
    main()
