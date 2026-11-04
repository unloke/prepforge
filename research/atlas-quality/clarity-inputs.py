"""Offline PGN -> merged, comment-preserving Atlas clarity scopes. No HTTP."""
import hashlib
import io
import json
from pathlib import Path

import chess.pgn

BASE = Path(__file__).resolve().parent


def key(board):
    return " ".join(board.fen(en_passant="legal").split()[:4])


def add_text(target, field, text):
    if text and text not in target[field]:
        target[field].append(text)


def fresh(board, move=None, mover=None):
    return {"fen": board.fen(en_passant="legal"), "positionKey": key(board),
            "uci": move.uci() if move else None, "move_side": mover,
            "ply": board.ply(), "comments": [], "starting_comments": [],
            "nags": set(), "children": {}, "source_chapters": set()}


def convert(study, raw):
    roots, errors, chapter_metadata = {}, [], []
    stream = io.StringIO(raw.decode("utf-8-sig"))
    while (game := chess.pgn.read_game(stream)) is not None:
        number = len(chapter_metadata) + 1
        chapter_metadata.append({"number": number, "headers": dict(game.headers)})
        errors.extend({"chapter": number, "error": str(e)} for e in game.errors)
        board = game.board()
        target_root = roots.setdefault(key(board), fresh(board))
        stack = [(game, board, target_root)]
        while stack:
            source, before, target = stack.pop()
            add_text(target, "comments", source.comment)
            add_text(target, "starting_comments", getattr(source, "starting_comment", ""))
            target["nags"].update(source.nags)
            target["source_chapters"].add(number)
            pending = []
            for child in source.variations:
                after = before.copy(stack=False)
                mover = "white" if before.turn else "black"
                after.push(child.move)
                destination = target["children"].setdefault(child.move.uci(), fresh(after, child.move, mover))
                pending.append((child, after, destination))
            stack.extend(reversed(pending))
    scopes = []
    for root_index, root in enumerate(roots.values()):
        nodes = []
        stack = [(root, None, 0, True)]
        while stack:
            source, parent_id, depth, mainline = stack.pop()
            node_id = f"r{root_index}n{len(nodes)}"
            # Starting variation text is local move context, not a descriptive tag.
            # Preserve the separate raw fields; join their union for app.comment.
            local_text = list(dict.fromkeys(source["starting_comments"] + source["comments"]))
            nodes.append({"id": node_id, "parent_id": parent_id, "fen": source["fen"],
                          "depth": depth, "ply": source["ply"], "uci": source["uci"],
                          "move_side": source["move_side"], "is_enabled": True,
                          "is_mainline": mainline, "comment": "\n\n".join(local_text),
                          "starting_comment": "\n\n".join(source["starting_comments"]),
                          "after_comment": "\n\n".join(source["comments"]),
                          "nags": sorted(source["nags"]), "tags": [],
                          "source_chapters": sorted(source["source_chapters"])})
            children = list(source["children"].values())
            stack.extend(reversed([(child, node_id, depth + 1, i == 0) for i, child in enumerate(children)]))
        scopes.append({"rootNodeId": nodes[0]["id"], "rootPositionKey": root["positionKey"], "nodes": nodes})
    return {"studyId": study["id"], "title": study["title"], "color": study["color"],
            "role": study["content_role"], "pgnSha256": hashlib.sha256(raw).hexdigest(),
            "chapters": chapter_metadata, "mergedRootScopes": scopes, "parseErrors": errors}


def main():
    manifest_path = BASE / "corpus" / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf8"))
    studies = []
    for study in manifest:
        raw = (BASE / "corpus" / study["file"]).read_bytes()
        assert hashlib.sha256(raw).hexdigest() == study["sha256"], study["id"]
        studies.append(convert(study, raw))
    result = {"meta": {"manifestSha256": hashlib.sha256(manifest_path.read_bytes()).hexdigest(),
                       "conversion": "Same canonical-FEN roots and same-parent UCI branches merged. Source-order first mainline; union of comments/start-comments/NAGs; no header titles or likes injected as explanations.",
                       "noteMapping": "comment = distinct starting_comment + after-move comment. Separate source fields and chapter provenance retained. NAG integers retained separately; no descriptive tags invented."},
              "studies": studies}
    output = BASE.parents[1] / "tmp" / "atlas-clarity-inputs.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf8")
    print(json.dumps({"studies": len(studies), "rootScopes": sum(len(s["mergedRootScopes"]) for s in studies),
                      "nodes": sum(len(scope["nodes"]) for s in studies for scope in s["mergedRootScopes"]),
                      "parseErrors": sum(len(s["parseErrors"]) for s in studies)}))


if __name__ == "__main__":
    main()
