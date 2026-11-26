"""The backend package imports in one direction: no module reaches itself.

Every ``import``/``from ... import`` of a ``prepforge_chess`` module counts,
including the ones under ``if TYPE_CHECKING:`` and inside functions, because a
cycle hidden behind a deferred import is still a cycle in the design.
"""
from __future__ import annotations

import ast
from pathlib import Path

PACKAGE = Path(__file__).resolve().parents[1] / "src" / "prepforge_chess"


def _module_name(path: Path) -> str:
    parts = path.relative_to(PACKAGE.parent).with_suffix("").parts
    return ".".join(parts[:-1] if parts[-1] == "__init__" else parts)


def _import_graph() -> dict[str, set[str]]:
    modules = {_module_name(path): path for path in PACKAGE.rglob("*.py")}
    graph: dict[str, set[str]] = {name: set() for name in modules}
    for name, path in modules.items():
        package = name if path.name == "__init__.py" else name.rpartition(".")[0]
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            targets: list[str] = []
            if isinstance(node, ast.Import):
                targets = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom):
                base = node.module or ""
                if node.level:
                    anchor = package.split(".")[: len(package.split(".")) - node.level + 1]
                    base = ".".join([*anchor, base] if base else anchor)
                targets = [base] + [f"{base}.{alias.name}" for alias in node.names]
            for target in targets:
                if target in modules and target != name:
                    graph[name].add(target)
    return graph


def _cycles(graph: dict[str, set[str]]) -> list[list[str]]:
    """Strongly connected components with more than one module (Tarjan)."""
    index: dict[str, int] = {}
    low: dict[str, int] = {}
    stack: list[str] = []
    on_stack: set[str] = set()
    found: list[list[str]] = []

    def visit(node: str) -> None:
        index[node] = low[node] = len(index)
        stack.append(node)
        on_stack.add(node)
        for nxt in graph[node]:
            if nxt not in index:
                visit(nxt)
                low[node] = min(low[node], low[nxt])
            elif nxt in on_stack:
                low[node] = min(low[node], index[nxt])
        if low[node] == index[node]:
            component = []
            while True:
                item = stack.pop()
                on_stack.discard(item)
                component.append(item)
                if item == node:
                    break
            if len(component) > 1:
                found.append(sorted(component))

    for node in sorted(graph):
        if node not in index:
            visit(node)
    return found


def test_backend_has_no_import_cycles():
    graph = _import_graph()
    # A package's __init__ re-exporting its children is not a design cycle.
    for name in graph:
        graph[name] = {target for target in graph[name] if not name.startswith(target + ".")}
    assert _cycles(graph) == []
