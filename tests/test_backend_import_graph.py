"""The backend package imports in one direction: no module reaches itself.

Every ``import``/``from ... import`` of a ``prepforge_chess`` module counts,
including the ones under ``if TYPE_CHECKING:`` and inside functions, because a
cycle hidden behind a deferred import is still a cycle in the design.

Edges follow what Python loads. Importing ``a.b.c`` also runs ``a`` and ``a.b``
first, so those packages are dependencies too, except for a module inside them:
their ``__init__`` is already running when it loads. ``from pkg import name``
needs ``pkg.name`` when that is a submodule, and needs ``pkg`` itself when the
name is an attribute; the second holds inside ``pkg`` too, which is how a
package that re-exports a child's name and a child that imports it back from
the package fail at import time. ``import pkg`` (aliased or not) needs ``pkg``
only where code that runs while the module loads reads an attribute of it.
That last rule is static: it does not follow calls into functions.
"""
from __future__ import annotations

import ast
import subprocess
import sys
from pathlib import Path

PACKAGE = Path(__file__).resolve().parents[1] / "src" / "prepforge_chess"


def _module_name(root: Path, path: Path) -> str:
    parts = path.relative_to(root.parent).with_suffix("").parts
    return ".".join(parts[:-1] if parts[-1] == "__init__" else parts)


def _ancestors(module: str) -> list[str]:
    parts = module.split(".")
    return [".".join(parts[:end]) for end in range(1, len(parts))]


def _inside(module: str, package: str) -> bool:
    return module == package or module.startswith(package + ".")


def _import_time_nodes(tree: ast.Module) -> list[ast.AST]:
    """The nodes that run while the module loads: everything but function and
    lambda bodies. Decorators, default values and class bodies run then, and so
    do annotations unless ``from __future__ import annotations`` defers them."""
    lazy_annotations = any(
        isinstance(node, ast.ImportFrom) and node.module == "__future__"
        and any(alias.name == "annotations" for alias in node.names)
        for node in tree.body
    )
    found: list[ast.AST] = []
    pending: list[ast.AST] = list(tree.body)
    while pending:
        node = pending.pop()
        found.append(node)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            pending += [*node.decorator_list, *node.args.defaults, *filter(None, node.args.kw_defaults)]
            if not lazy_annotations:
                args = [*node.args.posonlyargs, *node.args.args, *node.args.kwonlyargs,
                        node.args.vararg, node.args.kwarg]
                pending += [arg.annotation for arg in args if arg and arg.annotation]
                pending += [node.returns] if node.returns else []
        elif isinstance(node, ast.Lambda):
            pending += [*node.args.defaults, *filter(None, node.args.kw_defaults)]
        elif isinstance(node, ast.AnnAssign) and lazy_annotations:
            pending += [node.target, *([node.value] if node.value else [])]
        else:
            pending += list(ast.iter_child_nodes(node))
    return found


def _import_graph(root: Path = PACKAGE) -> dict[str, set[str]]:
    modules = {_module_name(root, path): path for path in root.rglob("*.py")}
    graph: dict[str, set[str]] = {name: set() for name in modules}
    for name, path in modules.items():
        package = name if path.name == "__init__.py" else name.rpartition(".")[0]
        tree = ast.parse(path.read_text(encoding="utf-8"))
        loaded: set[str] = set()  # modules the statement makes Python load
        needed: set[str] = set()  # packages whose attributes it reads

        def resolve(node: ast.ImportFrom) -> str:
            base = node.module or ""
            if node.level:
                anchor = package.split(".")[: len(package.split(".")) - node.level + 1]
                base = ".".join([*anchor, base] if base else anchor)
            return base

        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                loaded.update(alias.name for alias in node.names)
            elif isinstance(node, ast.ImportFrom):
                base = resolve(node)
                loaded.add(base)
                for alias in node.names:
                    submodule = f"{base}.{alias.name}"
                    if submodule in modules:
                        loaded.add(submodule)
                    else:
                        needed.add(base)
        # A package bound as a module object (``import pkg as parent``) is
        # needed only where the module reads its attributes while loading;
        # merely holding it, or reading it later inside a function, is fine.
        running = _import_time_nodes(tree)
        bound: dict[str, str] = {}
        for node in running:
            if isinstance(node, ast.Import):
                for alias in node.names:
                    if alias.asname:
                        bound[alias.asname] = alias.name
                    else:
                        bound[alias.name.split(".")[0]] = alias.name.split(".")[0]
            elif isinstance(node, ast.ImportFrom):
                base = resolve(node)
                for alias in node.names:
                    if f"{base}.{alias.name}" in modules:
                        bound[alias.asname or alias.name] = f"{base}.{alias.name}"
        for node in running:
            if not isinstance(node, ast.Attribute):
                continue
            chain: list[str] = []
            value: ast.expr = node
            while isinstance(value, ast.Attribute):
                chain.insert(0, value.attr)
                value = value.value
            if not (isinstance(value, ast.Name) and value.id in bound):
                continue
            module = bound[value.id]
            for attr in chain:
                if f"{module}.{attr}" not in modules:
                    needed.add(module)
                    break
                module = f"{module}.{attr}"
        for target in loaded:
            for module in (*_ancestors(target), target):
                if module in modules and not _inside(name, module):
                    graph[name].add(module)
        graph[name].update(target for target in needed if target in modules and target != name)
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
    assert _cycles(_import_graph()) == []


# ------------------------------------------------------- the checker's own cases


def _package(tmp_path: Path, files: dict[str, str]) -> Path:
    for relative, source in files.items():
        path = tmp_path / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(source, encoding="utf-8")
    return tmp_path / "pkg"


def _imports_cleanly(root: Path, module: str) -> bool:
    code = f"import sys; sys.path.insert(0, {str(root.parent)!r}); import {module}"
    return subprocess.run([sys.executable, "-I", "-c", code], capture_output=True).returncode == 0


def test_cycle_through_a_package_init_is_found(tmp_path):
    # The package re-exports a name from its child; the child imports it back
    # from the package. Python fails to import this.
    root = _package(tmp_path, {
        "pkg/__init__.py": "from pkg.child import VALUE\n",
        "pkg/child.py": "from pkg import VALUE\n",
    })
    assert not _imports_cleanly(root, "pkg")
    assert _cycles(_import_graph(root)) == [["pkg", "pkg.child"]]


def test_child_importing_a_sibling_through_its_package_is_not_a_cycle(tmp_path):
    # The package re-exports from its children, and children import siblings
    # and the package's own submodules; none of it needs an unfinished module.
    root = _package(tmp_path, {
        "pkg/__init__.py": "from pkg.child import VALUE\n",
        "pkg/child.py": "from pkg import sibling\nimport pkg.sibling\nfrom . import helper\nVALUE = sibling.X\n",
        "pkg/sibling.py": "X = 1\n",
        "pkg/helper.py": "",
    })
    assert _imports_cleanly(root, "pkg")
    assert _cycles(_import_graph(root)) == []


def test_cycle_through_a_subpackage_init_loaded_from_outside_is_found(tmp_path):
    # Importing pkg.a.x runs pkg/a/__init__ first, which imports the importer back.
    root = _package(tmp_path, {
        "pkg/__init__.py": "",
        "pkg/a/__init__.py": "from pkg.b.mod import N\n",
        "pkg/a/x.py": "Y = 1\n",
        "pkg/b/__init__.py": "",
        "pkg/b/mod.py": "from pkg.a.x import Y\nN = Y\n",
    })
    assert not _imports_cleanly(root, "pkg.b.mod")
    assert _cycles(_import_graph(root)) == [["pkg.a", "pkg.b.mod"]]


def test_package_attribute_read_while_loading_is_found(tmp_path):
    # The child holds the package as a module object and reads a name from it
    # at import time, before the package's __init__ has set that name.
    root = _package(tmp_path, {
        "pkg/__init__.py": "from pkg.child import VALUE\nvalue = 1\n",
        "pkg/child.py": "import pkg as parent\nVALUE = parent.value\n",
    })
    assert not _imports_cleanly(root, "pkg")
    assert _cycles(_import_graph(root)) == [["pkg", "pkg.child"]]


def test_holding_the_package_without_reading_it_while_loading_is_not_a_cycle(tmp_path):
    # Holding the module object, or reading it later inside a function, needs
    # nothing the unfinished package lacks.
    root = _package(tmp_path, {
        "pkg/__init__.py": "from pkg.child import VALUE, later\nvalue = 1\n",
        "pkg/child.py": "import pkg as parent\nimport pkg\nVALUE = 2\n"
                        "def later():\n    return parent.value + pkg.value\n",
    })
    assert _imports_cleanly(root, "pkg")
    assert _cycles(_import_graph(root)) == []


def test_package_attribute_read_in_a_decorator_is_found(tmp_path):
    # A decorator runs while the module loads, unlike the function body.
    root = _package(tmp_path, {
        "pkg/__init__.py": "from pkg.child import run\ndef register(fn):\n    return fn\n",
        "pkg/child.py": "import pkg\n@pkg.register\ndef run():\n    pass\n",
    })
    assert not _imports_cleanly(root, "pkg")
    assert _cycles(_import_graph(root)) == [["pkg", "pkg.child"]]
