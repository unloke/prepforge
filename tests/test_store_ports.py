"""The narrow store ports are real boundaries, checked statically.

``storage.ports`` declares what each caller may touch; ``WorkspaceRepository``
is the single implementation behind all of them. These tests keep both sides
honest without a type checker:

* every port member exists on ``WorkspaceRepository`` with the same parameters;
* every router/service parameter named ``repo``/``repository`` is annotated
  with a port, never with the whole repository;
* a function or class may use only its port's members on that parameter, and
  may pass it on only to a callee whose port asks for no more;
* a tree delete reaches training state only through ``services.workflows``.
"""
from __future__ import annotations

import ast
import inspect
from functools import lru_cache
from pathlib import Path
from typing import Iterator, Optional

from prepforge_chess.storage import ports
from prepforge_chess.storage.repositories.workspace import WorkspaceRepository

SRC = Path(__file__).resolve().parents[1] / "src"
PACKAGE = SRC / "prepforge_chess"
CONSUMER_DIRS = (PACKAGE / "api", PACKAGE / "services")
REPOSITORY_PARAMS = {"repo", "repository", "store"}


def _port_classes() -> dict[str, type]:
    return {
        name: value for name, value in vars(ports).items()
        if isinstance(value, type) and value.__module__ == ports.__name__
    }


@lru_cache(maxsize=None)
def _members(port_name: str) -> frozenset[str]:
    names: set[str] = set()
    for cls in _port_classes()[port_name].__mro__:
        if cls.__module__ != ports.__name__:
            continue
        names.update(getattr(cls, "__annotations__", {}))
        names.update(name for name, value in vars(cls).items() if callable(value) and not name.startswith("_"))
    return frozenset(names)


def test_every_port_member_exists_on_the_implementation_with_its_parameters():
    for name, cls in _port_classes().items():
        for member in _members(name):
            assert hasattr(WorkspaceRepository, member) or member in _instance_attributes(), (name, member)
            declared = getattr(cls, member, None)
            if callable(declared):
                assert (
                    list(inspect.signature(declared).parameters.values())
                    == list(inspect.signature(getattr(WorkspaceRepository, member)).parameters.values())
                ), f"{name}.{member} drifted from WorkspaceRepository.{member}"


def _instance_attributes() -> set[str]:
    from sqlalchemy import create_engine

    return set(vars(WorkspaceRepository(create_engine("sqlite://"))))


# ------------------------------------------------------------------ usage check


def _module_name(path: Path) -> str:
    parts = path.relative_to(SRC).with_suffix("").parts
    return ".".join(parts[:-1] if parts[-1] == "__init__" else parts)


@lru_cache(maxsize=None)
def _modules() -> dict[str, ast.Module]:
    return {
        _module_name(path): ast.parse(path.read_text(encoding="utf-8"))
        for folder in CONSUMER_DIRS for path in folder.rglob("*.py")
    }


@lru_cache(maxsize=None)
def _imports(module: str) -> dict[str, tuple[str, Optional[str]]]:
    """Local name -> (module, attribute or None for a module alias)."""
    found: dict[str, tuple[str, Optional[str]]] = {}
    for node in _modules()[module].body:
        if isinstance(node, ast.ImportFrom) and node.module:
            for alias in node.names:
                local = alias.asname or alias.name
                submodule = f"{node.module}.{alias.name}"
                found[local] = (submodule, None) if submodule in _modules() else (node.module, alias.name)
    return found


def _port_of(annotation: Optional[ast.expr]) -> Optional[str]:
    if isinstance(annotation, ast.Constant) and isinstance(annotation.value, str):
        annotation = ast.parse(annotation.value, mode="eval").body
    if isinstance(annotation, ast.Name) and annotation.id in _port_classes():
        return annotation.id
    return None


def _params(fn: ast.FunctionDef | ast.AsyncFunctionDef) -> list[ast.arg]:
    return [*fn.args.posonlyargs, *fn.args.args, *fn.args.kwonlyargs]


def _definitions(module: str) -> dict[str, ast.AST]:
    return {
        node.name: node for node in _modules()[module].body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
    }


def _resolve(module: str, func: ast.expr) -> Optional[tuple[str, ast.AST]]:
    """The scanned function or class a call targets, by name."""
    if isinstance(func, ast.Name):
        if func.id in _definitions(module):
            return module, _definitions(module)[func.id]
        target = _imports(module).get(func.id)
        if target and target[1] and target[0] in _modules():
            node = _definitions(target[0]).get(target[1])
            return (target[0], node) if node is not None else None
    if isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name):
        target = _imports(module).get(func.value.id)
        if target and target[1] is None:
            node = _definitions(target[0]).get(func.attr)
            return (target[0], node) if node is not None else None
    return None


def _callee_port(node: ast.AST, call: ast.Call, position: Optional[int], keyword: Optional[str]) -> tuple[bool, Optional[str]]:
    """(is a scanned callee, port its matching parameter declares)."""
    if isinstance(node, ast.ClassDef):
        init = next((item for item in node.body if isinstance(item, ast.FunctionDef) and item.name == "__init__"), None)
        if init is None:
            return False, None
        params = _params(init)[1:]
    else:
        params = _params(node)
    if keyword is not None:
        match = next((param for param in params if param.arg == keyword), None)
    else:
        positional = [*node.args.posonlyargs, *node.args.args] if not isinstance(node, ast.ClassDef) else _params(init)[1:]
        match = positional[position] if position is not None and position < len(positional) else None
    if match is None:
        return True, None
    return True, _port_of(match.annotation)


def _is_ref(expr: ast.expr, ref: tuple[str, ...]) -> bool:
    if len(ref) == 1:
        return isinstance(expr, ast.Name) and expr.id == ref[0]
    return (isinstance(expr, ast.Attribute) and expr.attr == ref[1]
            and isinstance(expr.value, ast.Name) and expr.value.id == ref[0])


def _violations(module: str, scope: ast.AST, ref: tuple[str, ...], port: str, where: str) -> Iterator[str]:
    allowed = _members(port)
    for node in ast.walk(scope):
        if isinstance(node, ast.Attribute) and _is_ref(node.value, ref) and node.attr not in allowed:
            yield f"{where}: {'.'.join(ref)}.{node.attr} is not on {port}"
        if isinstance(node, ast.Call):
            passed = [(index, None, arg) for index, arg in enumerate(node.args)]
            passed += [(None, kw.arg, kw.value) for kw in node.keywords if kw.arg]
            for index, keyword, arg in passed:
                if not _is_ref(arg, ref):
                    continue
                target = _resolve(module, node.func)
                if target is None:
                    continue
                scanned, needed = _callee_port(target[1], node, index, keyword)
                if not scanned:
                    continue
                if needed is None:
                    yield f"{where}: passes {'.'.join(ref)} to {target[1].name}, whose parameter has no port"
                elif not _members(needed) <= allowed:
                    missing = sorted(_members(needed) - allowed)
                    yield f"{where}: passes {port} to {target[1].name}, which needs {needed} ({missing})"


def _functions(tree: ast.AST) -> Iterator[ast.FunctionDef | ast.AsyncFunctionDef]:
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            yield node


def test_consumers_annotate_their_repository_with_a_port():
    unported = []
    for module, tree in _modules().items():
        for fn in _functions(tree):
            for param in _params(fn):
                if param.arg in REPOSITORY_PARAMS and _port_of(param.annotation) is None:
                    unported.append(f"{module}.{fn.name}({param.arg})")
    assert unported == []


def test_consumers_use_only_their_port():
    found: list[str] = []
    for module, tree in _modules().items():
        for fn in _functions(tree):
            for param in _params(fn):
                port = _port_of(param.annotation)
                if port is not None:
                    found += _violations(module, fn, (param.arg,), port, f"{module}.{fn.name}")
        for cls in (node for node in ast.walk(tree) if isinstance(node, ast.ClassDef)):
            init = next((item for item in cls.body if isinstance(item, ast.FunctionDef) and item.name == "__init__"), None)
            if init is None:
                continue
            for param in _params(init):
                port = _port_of(param.annotation)
                if port is None:
                    continue
                for stmt in ast.walk(init):
                    if (isinstance(stmt, ast.Assign) and isinstance(stmt.value, ast.Name)
                            and stmt.value.id == param.arg):
                        for target in stmt.targets:
                            if (isinstance(target, ast.Attribute) and isinstance(target.value, ast.Name)
                                    and target.value.id == "self"):
                                found += _violations(module, cls, ("self", target.attr), port, f"{module}.{cls.name}")
    assert found == []


# Tree deletes and the training cleanup they need meet only in the named
# workflows, so no router or service can delete nodes and skip the cleanup.
WORKFLOW_ONLY = set(_members("TrainingCleanupStore")) | {"remove_opening_nodes", "remove_repertoire", "revert_op"}


def test_tree_deletes_and_training_cleanup_meet_only_in_workflows():
    stray = [
        f"{module}:{node.lineno} .{node.attr}"
        for module, tree in _modules().items() if module != "prepforge_chess.services.workflows"
        for node in ast.walk(tree)
        if isinstance(node, ast.Attribute) and node.attr in WORKFLOW_ONLY
    ]
    assert stray == []
