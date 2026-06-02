from __future__ import annotations

import json
import re
from typing import Any, Dict, Iterable, List, Optional, Tuple

from prepforge_chess.core.chess_core import STARTING_FEN
from prepforge_chess.core.models import (
    Color,
    EngineEvaluation,
    MoveClassification,
    MoveRecord,
    MoveSource,
    OpeningNode,
    Repertoire,
)


PACKAGE_KIND = "prepforge_repertoire_package"
PACKAGE_SCHEMA_VERSION = 1

_ID_PATTERN = re.compile(r"^[A-Za-z0-9._-]{1,80}$")
_TAG_PATTERN = re.compile(r"^[A-Za-z0-9 _\-]{1,40}$")
_NAME_MAX = 200
_COMMENT_MAX = 2000

_DRAWING_PATTERN = re.compile(r"\[%(cal|csl)\s+([^\]]*)\]")


def _extract_drawings(comment: Optional[str]) -> Tuple[Optional[str], List[str], List[str]]:
    """Pull Lichess [%cal ...] arrows and [%csl ...] circles out of a comment.

    Returns the comment with those tokens stripped, plus colourless arrow/circle
    lists (a leading G/R/Y/B colour letter is dropped to match our single-colour
    board model)."""
    if not comment:
        return None, [], []
    arrows: List[str] = []
    circles: List[str] = []

    def _take(match: "re.Match[str]") -> str:
        kind = match.group(1)
        bucket = arrows if kind == "cal" else circles
        for token in match.group(2).split(","):
            token = token.strip()
            if not token:
                continue
            body = token[1:] if token[0] in "GRYB" else token
            if body:
                bucket.append(body)
        return ""

    cleaned = _DRAWING_PATTERN.sub(_take, comment).strip()
    return (cleaned or None), arrows, circles


def _validate_id(value: Any, label: str) -> str:
    if not isinstance(value, str) or not _ID_PATTERN.match(value):
        raise ValueError("invalid {0}".format(label))
    return value


def _validate_tags(values: Any) -> List[str]:
    if values is None:
        return []
    if not isinstance(values, list):
        raise ValueError("tags must be a list")
    result: List[str] = []
    for item in values:
        if not isinstance(item, str) or not _TAG_PATTERN.match(item):
            raise ValueError("invalid tag value: {0!r}".format(item))
        result.append(item)
    return result


def _validate_text(value: Any, label: str, max_len: int) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ValueError("{0} must be a string".format(label))
    if len(value) > max_len:
        raise ValueError("{0} exceeds {1} characters".format(label, max_len))
    return value


class RepertoireExportService:
    def export_package(self, repertoire: Repertoire) -> Dict[str, Any]:
        nodes = [
            self._node_to_dict(node, depth)
            for node, depth in self._walk_nodes(repertoire.root_node)
        ]
        return {
            "kind": PACKAGE_KIND,
            "schema_version": PACKAGE_SCHEMA_VERSION,
            "repertoire": {
                "id": repertoire.id,
                "name": repertoire.name,
                "color": repertoire.color.value,
                "root_fen": repertoire.root_fen,
                "root_node_id": repertoire.root_node.id,
                "main_engine": repertoire.main_engine,
                "human_model": repertoire.human_model,
                "branch_depth": repertoire.branch_depth,
                "opponent_branch_threshold": repertoire.opponent_branch_threshold,
                "sub_branch_threshold": repertoire.sub_branch_threshold,
                "max_total_nodes": repertoire.max_total_nodes,
                "max_line_length": repertoire.max_line_length,
                "notes": repertoire.notes,
                "tags": list(repertoire.tags),
            },
            "nodes": nodes,
        }

    def export_package_json(self, repertoire: Repertoire, *, indent: int = 2) -> str:
        return json.dumps(
            self.export_package(repertoire),
            ensure_ascii=True,
            indent=indent,
            sort_keys=True,
        )

    def import_package_json(self, text: str) -> Repertoire:
        return self.import_package(json.loads(text))

    def import_package(self, package: Dict[str, Any]) -> Repertoire:
        if package.get("kind") != PACKAGE_KIND:
            raise ValueError("not a PrepForge repertoire package")
        if package.get("schema_version") != PACKAGE_SCHEMA_VERSION:
            raise ValueError("unsupported repertoire package schema")

        repertoire_payload = package["repertoire"]
        repertoire_id = _validate_id(repertoire_payload.get("id"), "repertoire id")
        nodes: Dict[str, OpeningNode] = {}

        for payload in package.get("nodes", []):
            node_id = _validate_id(payload.get("id"), "node id")
            payload = dict(payload)
            payload["id"] = node_id
            if payload.get("parent_id") is not None:
                payload["parent_id"] = _validate_id(payload["parent_id"], "node parent_id")
            payload["tags"] = _validate_tags(payload.get("tags"))
            payload["comment"] = _validate_text(payload.get("comment"), "comment", _COMMENT_MAX)
            nodes[node_id] = self._node_from_dict(payload, repertoire_id)

        for payload in package.get("nodes", []):
            parent = nodes[payload["id"]]
            for child_id in payload.get("children", []):
                if not isinstance(child_id, str):
                    continue
                child = nodes.get(child_id)
                if child is not None and child.parent_id == parent.id:
                    parent.children.append(child)

        root_node_id = _validate_id(repertoire_payload.get("root_node_id"), "root_node_id")
        root_node = nodes.get(root_node_id)
        if root_node is None:
            raise ValueError("package root node is missing")

        return Repertoire(
            id=repertoire_id,
            name=_validate_text(repertoire_payload.get("name"), "name", _NAME_MAX) or "Untitled",
            color=Color(repertoire_payload["color"]),
            root_fen=repertoire_payload["root_fen"],
            root_node=root_node,
            main_engine=repertoire_payload.get("main_engine", "stockfish"),
            human_model=repertoire_payload.get("human_model", "maia3"),
            branch_depth=repertoire_payload.get("branch_depth", 12),
            opponent_branch_threshold=repertoire_payload.get("opponent_branch_threshold", 0.10),
            sub_branch_threshold=repertoire_payload.get("sub_branch_threshold", 0.30),
            max_total_nodes=repertoire_payload.get("max_total_nodes", 1000),
            max_line_length=repertoire_payload.get("max_line_length", 24),
            notes=_validate_text(repertoire_payload.get("notes"), "notes", _COMMENT_MAX) or None,
            tags=_validate_tags(repertoire_payload.get("tags")),
        )

    def export_mainline_pgn(
        self,
        repertoire: Repertoire,
        *,
        include_disabled: bool = False,
    ) -> str:
        return self._format_pgn(
            repertoire,
            self._mainline_nodes(repertoire.root_node, include_disabled=include_disabled),
        )

    def export_node_path_pgn(
        self,
        repertoire: Repertoire,
        node_id: str,
        *,
        include_disabled: bool = False,
    ) -> str:
        nodes = self._path_to_node(repertoire.root_node, node_id)
        if not include_disabled and any(not node.is_enabled for node in nodes):
            raise ValueError("node path contains a disabled branch")
        return self._format_pgn(repertoire, nodes)

    def export_tree_pgn(self, repertoire: Repertoire) -> str:
        """Export the whole repertoire as PGN with variations (RAVs)."""
        import chess
        import chess.pgn

        game = chess.pgn.Game()
        game.headers["Event"] = "PrepForge Repertoire"
        game.headers["Site"] = "PrepForge"
        game.headers["White"] = repertoire.name if repertoire.color is Color.WHITE else "Opponent"
        game.headers["Black"] = repertoire.name if repertoire.color is Color.BLACK else "Opponent"
        game.headers["Result"] = "*"
        game.headers["PrepForgeColor"] = repertoire.color.value
        game.headers["PrepForgeId"] = repertoire.id

        try:
            board = chess.Board(repertoire.root_fen or STARTING_FEN)
        except Exception:
            board = chess.Board()
        game.setup(board)

        def add_subtree(parent_pgn_node, opening_node):
            children = sorted(
                [c for c in opening_node.children if c.move is not None],
                key=lambda c: (not c.is_mainline, not c.is_enabled),
            )
            for index, child in enumerate(children):
                try:
                    move = chess.Move.from_uci(child.move.uci)
                except Exception:
                    continue
                if index == 0:
                    new_node = parent_pgn_node.add_main_variation(move)
                else:
                    new_node = parent_pgn_node.add_variation(move)
                annotations = []
                if child.comment:
                    annotations.append(child.comment)
                # Lichess renders these drawing commands from PGN comments:
                # arrows via [%cal ...], circles via [%csl ...]. Our board uses a
                # single colour, so export everything green (G).
                if child.arrows:
                    annotations.append(
                        "[%cal " + ",".join("G" + a for a in child.arrows) + "]"
                    )
                if child.circles:
                    annotations.append(
                        "[%csl " + ",".join("G" + s for s in child.circles) + "]"
                    )
                if not child.is_enabled:
                    annotations.append("[disabled]")
                if child.tags:
                    annotations.append("[" + ",".join(child.tags) + "]")
                if annotations:
                    new_node.comment = " ".join(annotations)
                add_subtree(new_node, child)

        add_subtree(game, repertoire.root_node)
        exporter = chess.pgn.StringExporter(headers=True, variations=True, comments=True)
        return game.accept(exporter)

    def import_tree_pgn(
        self,
        pgn_text: str,
        *,
        name: str,
        color: Color,
    ) -> Repertoire:
        """Build a Repertoire from a PGN with variations."""
        import io
        import uuid
        import chess
        import chess.pgn

        if not pgn_text or not pgn_text.strip():
            raise ValueError("PGN text is empty")

        parsed = chess.pgn.read_game(io.StringIO(pgn_text))
        if parsed is None:
            raise ValueError("could not parse PGN")
        if parsed.errors:
            first = parsed.errors[0]
            raise ValueError(
                "PGN has parse errors: {0}".format(
                    getattr(first, "args", [None])[0] or str(first)
                )
            )

        repertoire_id = str(uuid.uuid4())
        starting_fen = parsed.headers.get("FEN") or STARTING_FEN
        root_id = str(uuid.uuid4())
        root = OpeningNode(
            id=root_id,
            repertoire_id=repertoire_id,
            parent_id=None,
            move=None,
            fen=starting_fen,
            side_to_move=Color.WHITE if "w" in (starting_fen.split(" ")[1:2] or ["w"])[0] else Color.BLACK,
            engine_evaluation=None,
            maia_probability=None,
            is_mainline=False,
            is_user_prepared_move=False,
            is_enabled=True,
            priority=0.0,
            comment=None,
            tags=[],
            source=MoveSource.IMPORTED_PGN,
        )

        def attach(pgn_node, parent_node):
            board = pgn_node.board()
            children = list(pgn_node.variations)
            for index, variation in enumerate(children):
                move = variation.move
                san = board.san(move)
                new_board = board.copy(stack=False)
                new_board.push(move)
                node_id = str(uuid.uuid4())
                comment, arrows, circles = _extract_drawings(variation.comment or None)
                node = OpeningNode(
                    id=node_id,
                    repertoire_id=repertoire_id,
                    parent_id=parent_node.id,
                    move=MoveRecord(
                        uci=move.uci(),
                        san=san,
                        fen_before=board.fen(),
                        fen_after=new_board.fen(),
                        move_number=board.fullmove_number,
                        ply=board.ply() + 1,
                        side_to_move=Color.WHITE if board.turn else Color.BLACK,
                        source=MoveSource.IMPORTED_PGN,
                    ),
                    fen=new_board.fen(),
                    side_to_move=Color.BLACK if board.turn else Color.WHITE,
                    engine_evaluation=None,
                    maia_probability=None,
                    is_mainline=(index == 0),
                    is_user_prepared_move=(Color.WHITE if board.turn else Color.BLACK) is color,
                    is_enabled=True,
                    priority=0.0,
                    comment=comment,
                    tags=[],
                    arrows=arrows,
                    circles=circles,
                    source=MoveSource.IMPORTED_PGN,
                )
                parent_node.children.append(node)
                attach(variation, node)

        attach(parsed, root)

        return Repertoire(
            id=repertoire_id,
            name=name.strip() or "Imported repertoire",
            color=color,
            root_fen=starting_fen,
            root_node=root,
            notes=parsed.headers.get("Annotator") or None,
            tags=[],
            is_active=True,
        )

    def _node_to_dict(self, node: OpeningNode, depth: int) -> Dict[str, Any]:
        return {
            "id": node.id,
            "repertoire_id": node.repertoire_id,
            "parent_id": node.parent_id,
            "depth": depth,
            "fen": node.fen,
            "side_to_move": node.side_to_move.value,
            "move": self._move_to_dict(node.move),
            "engine_evaluation": self._evaluation_to_dict(node.engine_evaluation),
            "maia_probability": node.maia_probability,
            "is_mainline": node.is_mainline,
            "is_user_prepared_move": node.is_user_prepared_move,
            "is_enabled": node.is_enabled,
            "priority": node.priority,
            "comment": node.comment,
            "tags": list(node.tags),
            "arrows": list(node.arrows),
            "circles": list(node.circles),
            "tactical_warning": node.tactical_warning,
            "strategic_idea": node.strategic_idea,
            "typical_plan": node.typical_plan,
            "source": node.source.value,
            "children": [child.id for child in node.children],
        }

    def _node_from_dict(self, payload: Dict[str, Any], repertoire_id: str) -> OpeningNode:
        return OpeningNode(
            id=payload["id"],
            repertoire_id=repertoire_id,
            parent_id=payload.get("parent_id"),
            move=self._move_from_dict(payload.get("move")),
            fen=payload["fen"],
            side_to_move=Color(payload["side_to_move"]),
            engine_evaluation=self._evaluation_from_dict(payload.get("engine_evaluation")),
            maia_probability=payload.get("maia_probability"),
            is_mainline=payload.get("is_mainline", False),
            is_user_prepared_move=payload.get("is_user_prepared_move", False),
            is_enabled=payload.get("is_enabled", True),
            priority=payload.get("priority", 0.0),
            comment=payload.get("comment"),
            tags=list(payload.get("tags", [])),
            arrows=list(payload.get("arrows", [])),
            circles=list(payload.get("circles", [])),
            tactical_warning=payload.get("tactical_warning"),
            strategic_idea=payload.get("strategic_idea"),
            typical_plan=payload.get("typical_plan"),
            source=MoveSource(payload.get("source", MoveSource.MANUAL.value)),
        )

    def _move_to_dict(self, move: Optional[MoveRecord]) -> Optional[Dict[str, Any]]:
        if move is None:
            return None
        return {
            "uci": move.uci,
            "san": move.san,
            "fen_before": move.fen_before,
            "fen_after": move.fen_after,
            "move_number": move.move_number,
            "ply": move.ply,
            "side_to_move": move.side_to_move.value,
            "source": move.source.value,
            "engine_eval_before": self._evaluation_to_dict(move.engine_eval_before),
            "engine_eval_after": self._evaluation_to_dict(move.engine_eval_after),
            "best_move_uci": move.best_move_uci,
            "best_move_eval": self._evaluation_to_dict(move.best_move_eval),
            "classification": move.classification.value,
            "comment": move.comment,
            "tags": list(move.tags),
        }

    def _move_from_dict(self, payload: Optional[Dict[str, Any]]) -> Optional[MoveRecord]:
        if payload is None:
            return None
        return MoveRecord(
            uci=payload["uci"],
            san=payload["san"],
            fen_before=payload["fen_before"],
            fen_after=payload["fen_after"],
            move_number=payload["move_number"],
            ply=payload["ply"],
            side_to_move=Color(payload["side_to_move"]),
            source=MoveSource(payload.get("source", MoveSource.MANUAL.value)),
            engine_eval_before=self._evaluation_from_dict(payload.get("engine_eval_before")),
            engine_eval_after=self._evaluation_from_dict(payload.get("engine_eval_after")),
            best_move_uci=payload.get("best_move_uci"),
            best_move_eval=self._evaluation_from_dict(payload.get("best_move_eval")),
            classification=MoveClassification(
                payload.get("classification", MoveClassification.UNKNOWN.value)
            ),
            comment=payload.get("comment"),
            tags=list(payload.get("tags", [])),
        )

    def _evaluation_to_dict(
        self,
        evaluation: Optional[EngineEvaluation],
    ) -> Optional[Dict[str, Any]]:
        if evaluation is None:
            return None
        return {
            "engine": evaluation.engine,
            "depth": evaluation.depth,
            "nodes": evaluation.nodes,
            "time_ms": evaluation.time_ms,
            "score_cp": evaluation.score_cp,
            "mate_in": evaluation.mate_in,
            "best_move_uci": evaluation.best_move_uci,
            "pv": list(evaluation.pv),
            "wdl": dict(evaluation.wdl) if evaluation.wdl is not None else None,
        }

    def _evaluation_from_dict(
        self,
        payload: Optional[Dict[str, Any]],
    ) -> Optional[EngineEvaluation]:
        if payload is None:
            return None
        return EngineEvaluation(
            engine=payload["engine"],
            depth=payload.get("depth"),
            nodes=payload.get("nodes"),
            time_ms=payload.get("time_ms"),
            score_cp=payload.get("score_cp"),
            mate_in=payload.get("mate_in"),
            best_move_uci=payload.get("best_move_uci"),
            pv=list(payload.get("pv", [])),
            wdl=payload.get("wdl"),
        )

    def _walk_nodes(self, root: OpeningNode) -> Iterable[Tuple[OpeningNode, int]]:
        yield root, 0
        for child in root.children:
            for node, depth in self._walk_nodes(child):
                yield node, depth + 1

    def _mainline_nodes(
        self,
        root: OpeningNode,
        *,
        include_disabled: bool,
    ) -> List[OpeningNode]:
        path: List[OpeningNode] = []
        node = root
        while True:
            candidates = [
                child for child in node.children if include_disabled or child.is_enabled
            ]
            mainline = [child for child in candidates if child.is_mainline]
            if mainline:
                node = mainline[0]
            elif len(candidates) == 1:
                node = candidates[0]
            else:
                break
            path.append(node)
        return path

    def _path_to_node(self, root: OpeningNode, node_id: str) -> List[OpeningNode]:
        by_id = {node.id: node for node, _ in self._walk_nodes(root)}
        if node_id not in by_id:
            raise ValueError("opening node not found: {0}".format(node_id))

        path = []
        current = by_id[node_id]
        while current.parent_id is not None:
            path.append(current)
            current = by_id[current.parent_id]
        path.reverse()
        return path

    def _format_pgn(self, repertoire: Repertoire, nodes: List[OpeningNode]) -> str:
        headers = [
            ("Event", repertoire.name),
            ("Site", "PrepForge Chess"),
            ("White", "Repertoire" if repertoire.color is Color.WHITE else "?"),
            ("Black", "Repertoire" if repertoire.color is Color.BLACK else "?"),
            ("Result", "*"),
        ]
        if repertoire.root_fen != STARTING_FEN:
            headers.append(("SetUp", "1"))
            headers.append(("FEN", repertoire.root_fen))

        header_text = "\n".join(
            '[{0} "{1}"]'.format(name, self._escape_header(value))
            for name, value in headers
        )
        moves = [node.move for node in nodes if node.move is not None]
        return "{0}\n\n{1}".format(header_text, self._format_movetext(moves))

    def _format_movetext(self, moves: List[MoveRecord]) -> str:
        if not moves:
            return "*"

        parts: List[str] = []
        for index, move in enumerate(moves):
            previous = moves[index - 1] if index > 0 else None
            if move.side_to_move is Color.WHITE:
                parts.append("{0}.".format(move.move_number))
            elif previous is None or previous.move_number != move.move_number:
                parts.append("{0}...".format(move.move_number))
            parts.append(move.san)
        parts.append("*")
        return " ".join(parts)

    def _escape_header(self, value: str) -> str:
        return str(value).replace("\\", "\\\\").replace('"', '\\"')
