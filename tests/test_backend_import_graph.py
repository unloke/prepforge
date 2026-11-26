"""The backend package imports in one direction: no module reaches itself.

Every ``import``/``from ... import`` of a ``prepforge_chess`` module counts,
including the ones under ``if TYPE_CHECKING:`` and inside functions, because a
cycle hidden behind a deferred import is still a cycle in the design.

Edges follow what Python loads. Importing ``a.b.c`` also runs ``a`` and ``a.b``
first, so those packages are dependencies too, except for a module inside them:
their ``__init__`` is already running when it loads, so for those the edge
follows what the module needs from the unfinished package instead. A module
inside ``pkg`` depends on ``pkg`` when, while it loads, it reads a name from
``pkg`` (``from pkg import name`` or ``pkg.name``) that ``pkg/__init__`` has not
set yet at the point where it starts loading that module, directly or through
other modules. Code that runs while a module loads is walked in statement
order: module and class bodies, decorators, default values, eager annotations,
comprehensions and the first iterable of a generator expression, but not
function or lambda bodies, the rest of a generator expression, or an
``if TYPE_CHECKING:`` block. A name stops standing for a module once the module
rebinds it. The walk is static: it does not follow calls into functions, so
``test_every_backend_module_imports_on_its_own`` imports each module for real.
"""
from __future__ import annotations

import ast
import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Callable, Optional, Union

SRC = Path(__file__).resolve().parents[1] / "src"
PACKAGE = SRC / "prepforge_chess"


def _module_name(root: Path, path: Path) -> str:
    parts = path.relative_to(root.parent).with_suffix("").parts
    return ".".join(parts[:-1] if parts[-1] == "__init__" else parts)


def _ancestors(module: str) -> list[str]:
    parts = module.split(".")
    return [".".join(parts[:end]) for end in range(1, len(parts))]


def _inside(module: str, package: str) -> bool:
    return module == package or module.startswith(package + ".")


@dataclass
class _Load:
    targets: list[str]  # modules this statement makes Python run, the last one last


@dataclass
class _Bind:
    name: str  # a name the module sets in its own namespace


@dataclass
class _Read:
    module: str  # a module object the code holds
    chain: list[str]  # attributes read from it, outermost first


_Event = Union[_Load, _Bind, _Read]
_Scope = dict[str, str]  # local name -> the module it is bound to


@dataclass
class _Walk:
    """What a module does while it loads, in the order Python does it."""

    name: str
    modules: set[str]
    resolve: Callable[[ast.ImportFrom], str]
    lazy_annotations: bool
    events: list[_Event] = field(default_factory=list)
    globals: _Scope = field(default_factory=dict)

    def load(self, target: str) -> None:
        targets = [m for m in (*_ancestors(target), target)
                   if m in self.modules and not _inside(self.name, m)]
        if targets:
            self.events.append(_Load(targets))

    def store(self, name: str, scope: _Scope, module: Optional[str] = None) -> None:
        if module is None:
            scope.pop(name, None)
        else:
            scope[name] = module
        if scope is self.globals:
            self.events.append(_Bind(name))

    def body(self, statements: list[ast.stmt], scope: _Scope) -> None:
        for statement in statements:
            self.statement(statement, scope)

    def statement(self, node: ast.stmt, scope: _Scope) -> None:
        if isinstance(node, ast.Import):
            for alias in node.names:
                self.load(alias.name)
                top = alias.name.split(".")[0]
                self.store(alias.asname or top, scope, alias.name if alias.asname else top)
        elif isinstance(node, ast.ImportFrom):
            base = self.resolve(node)
            if base == "__future__":
                return
            self.load(base)
            for alias in node.names:
                if alias.name != "*" and f"{base}.{alias.name}" in self.modules:
                    self.load(f"{base}.{alias.name}")
            for alias in node.names:
                if alias.name == "*":
                    continue
                submodule = f"{base}.{alias.name}"
                if submodule not in self.modules:
                    self.events.append(_Read(base, [alias.name]))
                self.store(alias.asname or alias.name, scope,
                           submodule if submodule in self.modules else None)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            self.expressions([*node.decorator_list, *node.args.defaults, *node.args.kw_defaults], scope)
            if not self.lazy_annotations:
                args = [*node.args.posonlyargs, *node.args.args, *node.args.kwonlyargs,
                        node.args.vararg, node.args.kwarg]
                self.expressions([arg.annotation for arg in args if arg], scope)
                self.expressions([node.returns], scope)
            self.store(node.name, scope)
        elif isinstance(node, ast.ClassDef):
            self.expressions([*node.decorator_list, *node.bases, *(kw.value for kw in node.keywords)], scope)
            self.body(node.body, dict(scope))
            self.store(node.name, scope)
        elif isinstance(node, ast.Assign):
            self.expression(node.value, scope)
            for target in node.targets:
                self.target(target, scope)
        elif isinstance(node, ast.AugAssign):
            self.expression(node.value, scope)
            self.target(node.target, scope)
        elif isinstance(node, ast.AnnAssign):
            self.expression(node.value, scope)
            if not self.lazy_annotations:
                self.expression(node.annotation, scope)
            if node.value is not None or not isinstance(node.target, ast.Name):
                self.target(node.target, scope)
        elif isinstance(node, (ast.For, ast.AsyncFor)):
            self.expression(node.iter, scope)
            self.target(node.target, scope)
            self.body(node.body, scope)
            self.body(node.orelse, scope)
        elif isinstance(node, ast.If):
            if _is_type_checking(node.test):
                self.body(node.orelse, scope)
                return
            self.expression(node.test, scope)
            self.body(node.body, scope)
            self.body(node.orelse, scope)
        elif isinstance(node, (ast.With, ast.AsyncWith)):
            for item in node.items:
                self.expression(item.context_expr, scope)
                if item.optional_vars is not None:
                    self.target(item.optional_vars, scope)
            self.body(node.body, scope)
        elif isinstance(node, ast.Try) or type(node).__name__ == "TryStar":
            self.body(node.body, scope)
            for handler in node.handlers:
                self.expression(handler.type, scope)
                if handler.name:
                    self.store(handler.name, scope)
                self.body(handler.body, scope)
            self.body(node.orelse, scope)
            self.body(node.finalbody, scope)
        elif isinstance(node, ast.Delete):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    scope.pop(target.id, None)
                else:
                    self.target(target, scope)
        elif isinstance(node, ast.Match):
            self.expression(node.subject, scope)
            for case in node.cases:
                for part in ast.walk(case.pattern):
                    for name in (getattr(part, "name", None), getattr(part, "rest", None)):
                        if isinstance(name, str):
                            self.store(name, scope)
                    if isinstance(part, ast.MatchValue):
                        self.expression(part.value, scope)
                    elif isinstance(part, ast.MatchClass):
                        self.expression(part.cls, scope)
                self.expression(case.guard, scope)
                self.body(case.body, scope)
        elif type(node).__name__ == "TypeAlias":
            return  # evaluated lazily
        else:
            for child in ast.iter_child_nodes(node):
                if isinstance(child, ast.stmt):
                    self.statement(child, scope)
                elif isinstance(child, ast.expr):
                    self.expression(child, scope)

    def target(self, node: ast.expr, scope: _Scope) -> None:
        if isinstance(node, ast.Name):
            self.store(node.id, scope)
        elif isinstance(node, (ast.Tuple, ast.List)):
            for element in node.elts:
                self.target(element, scope)
        elif isinstance(node, ast.Starred):
            self.target(node.value, scope)
        else:  # an attribute or subscript target evaluates its object first
            self.expression(node, scope)

    def expressions(self, nodes: list[Optional[ast.expr]], scope: _Scope) -> None:
        for node in nodes:
            self.expression(node, scope)

    def expression(self, node: Optional[ast.AST], scope: _Scope) -> None:
        if node is None:
            return
        if isinstance(node, ast.Attribute):
            chain: list[str] = []
            value: ast.expr = node
            while isinstance(value, ast.Attribute):
                chain.insert(0, value.attr)
                value = value.value
            if isinstance(value, ast.Name) and value.id in scope:
                self.events.append(_Read(scope[value.id], chain))
            else:
                self.expression(value, scope)
        elif isinstance(node, ast.Lambda):
            self.expressions([*node.args.defaults, *node.args.kw_defaults], scope)
        elif isinstance(node, ast.GeneratorExp):
            # Only the first iterable runs when the generator is made.
            self.expression(node.generators[0].iter, scope)
        elif isinstance(node, (ast.ListComp, ast.SetComp, ast.DictComp)):
            self.expression(node.generators[0].iter, scope)
            inner = dict(scope)
            for index, generator in enumerate(node.generators):
                if index:
                    self.expression(generator.iter, inner)
                for name in ast.walk(generator.target):
                    if isinstance(name, ast.Name):
                        inner.pop(name.id, None)
                self.expressions(generator.ifs, inner)
            if isinstance(node, ast.DictComp):
                self.expressions([node.key, node.value], inner)
            else:
                self.expression(node.elt, inner)
        elif isinstance(node, ast.NamedExpr):
            self.expression(node.value, scope)
            self.store(node.target.id, scope)
        else:
            for child in ast.iter_child_nodes(node):
                self.expression(child, scope)


def _is_type_checking(test: ast.expr) -> bool:
    return ((isinstance(test, ast.Name) and test.id == "TYPE_CHECKING")
            or (isinstance(test, ast.Attribute) and test.attr == "TYPE_CHECKING"))


def _import_graph(root: Path = PACKAGE) -> dict[str, set[str]]:
    paths = {_module_name(root, path): path for path in root.rglob("*.py")}
    modules = set(paths)
    graph: dict[str, set[str]] = {name: set() for name in modules}  # what each module loads
    running: dict[str, set[str]] = {name: set() for name in modules}  # ... while it loads
    walks: dict[str, _Walk] = {}
    for name, path in paths.items():
        package = name if path.name == "__init__.py" else name.rpartition(".")[0]
        tree = ast.parse(path.read_text(encoding="utf-8"))

        def resolve(node: ast.ImportFrom, package: str = package) -> str:
            base = node.module or ""
            if node.level:
                anchor = package.split(".")[: len(package.split(".")) - node.level + 1]
                base = ".".join([*anchor, base] if base else anchor)
            return base

        loaded: set[str] = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                loaded.update(alias.name for alias in node.names)
            elif isinstance(node, ast.ImportFrom):
                base = resolve(node)
                loaded.add(base)
                loaded.update(f"{base}.{alias.name}" for alias in node.names)
        for target in loaded:
            graph[name].update(module for module in (*_ancestors(target), target)
                               if module in modules and not _inside(name, module))
        lazy = any(isinstance(node, ast.ImportFrom) and node.module == "__future__"
                   and any(alias.name == "annotations" for alias in node.names) for node in tree.body)
        walk = _Walk(name, modules, resolve, lazy)
        walk.body(tree.body, walk.globals)
        walks[name] = walk
        for event in walk.events:
            if isinstance(event, _Load):
                running[name].update(event.targets)

    @lru_cache(maxsize=None)
    def runs(module: str) -> frozenset[str]:
        """Every module that loading ``module`` runs, itself included."""
        seen, pending = {module}, [module]
        while pending:
            for nxt in running[pending.pop()] - seen:
                seen.add(nxt)
                pending.append(nxt)
        return frozenset(seen)

    def runs_any(event: _Load) -> frozenset[str]:
        return frozenset().union(*(runs(target) for target in event.targets))

    def has_yet(reader: str, before: int, package: str, attr: str) -> bool:
        """Whether ``package.attr`` is set when ``reader`` reads it, at event ``before``."""
        submodule = f"{package}.{attr}"
        if submodule in modules and any(
            isinstance(event, _Load) and submodule in runs_any(event)
            for event in walks[reader].events[:before]
        ):
            return True
        starts = None  # where the package's __init__ starts loading the reader
        sets = None  # where it sets the attribute
        for index, event in enumerate(walks[package].events):
            if isinstance(event, _Load):
                ran = runs_any(event)
                if starts is None and reader in ran:
                    starts = index
                if sets is None and submodule in ran:
                    sets = index
            elif isinstance(event, _Bind) and event.name == attr and sets is None:
                sets = index
        return starts is None or (sets is not None and sets < starts)

    for name, walk in walks.items():
        for index, event in enumerate(walk.events):
            if not isinstance(event, _Read):
                continue
            module = event.module
            for attr in event.chain:
                if module in modules and module != name and _inside(name, module) \
                        and not has_yet(name, index, module, attr):
                    graph[name].add(module)
                    break
                if f"{module}.{attr}" not in modules:
                    break
                module = f"{module}.{attr}"
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


def _import_alone(module: str) -> Optional[str]:
    """Import one module in a fresh interpreter; the error it raised, if any."""
    code = f"import sys; sys.path.insert(0, {str(SRC)!r}); import {module}"
    result = subprocess.run([sys.executable, "-I", "-c", code], capture_output=True, text=True)
    return None if result.returncode == 0 else result.stderr.strip().splitlines()[-1]


def test_every_backend_module_imports_on_its_own():
    # The static walk above cannot see an import order that only a call into a
    # function reveals. Importing every module first, each in a clean
    # interpreter, catches any ImportError or AttributeError that order causes.
    names = sorted(_module_name(PACKAGE, path) for path in PACKAGE.rglob("*.py"))
    with ThreadPoolExecutor(max_workers=os.cpu_count() or 2) as pool:
        errors = dict(zip(names, pool.map(_import_alone, names)))
    assert {name: error for name, error in errors.items() if error} == {}


# ------------------------------------------------------- the checker's own cases


def _package(tmp_path: Path, files: dict[str, str], name: str = "pkg") -> Path:
    for relative, source in files.items():
        path = tmp_path / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(source, encoding="utf-8")
    return tmp_path / name


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


def test_submodule_the_package_has_not_loaded_yet_is_found(tmp_path):
    # forge/__init__ loads leaf before config, and leaf reads forge.config
    # while it loads, so forge has no config attribute yet.
    root = _package(tmp_path, {
        "forge/__init__.py": "from . import leaf\nfrom . import config\n",
        "forge/config.py": "LIMIT = 3\n",
        "forge/leaf.py": "import forge\nVALUE = forge.config.LIMIT\n",
    }, name="forge")
    assert not _imports_cleanly(root, "forge")
    assert _cycles(_import_graph(root)) == [["forge", "forge.leaf"]]


def test_submodule_loaded_before_the_reader_is_not_a_cycle(tmp_path):
    # The same read is fine once config loads first, or once leaf loads it itself.
    root = _package(tmp_path, {
        "forge/__init__.py": "from . import config\nfrom . import leaf\nfrom . import other\n",
        "forge/config.py": "LIMIT = 3\n",
        "forge/leaf.py": "import forge\nVALUE = forge.config.LIMIT\n",
        "forge/other.py": "import forge.config\nimport forge\nVALUE = forge.config.LIMIT\n",
    }, name="forge")
    assert _imports_cleanly(root, "forge")
    assert _cycles(_import_graph(root)) == []


def test_name_the_package_sets_before_loading_the_child_is_not_a_cycle(tmp_path):
    root = _package(tmp_path, {
        "pkg/__init__.py": "value = 1\nfrom pkg.child import VALUE\n",
        "pkg/child.py": "from pkg import value\nimport pkg\nVALUE = value + pkg.value\n",
    })
    assert _imports_cleanly(root, "pkg")
    assert _cycles(_import_graph(root)) == []


def test_alias_rebound_before_the_read_is_not_a_cycle(tmp_path):
    # After the rebinding, config is a plain object, not the unfinished package.
    root = _package(tmp_path, {
        "forge/__init__.py": "from forge.child import VALUE\nlimit = 1\n",
        "forge/child.py": "import types\nimport forge as config\n"
                          "config = types.SimpleNamespace(limit=2)\nVALUE = config.limit\n",
    }, name="forge")
    assert _imports_cleanly(root, "forge")
    assert _cycles(_import_graph(root)) == []


def test_alias_read_before_it_is_rebound_is_found(tmp_path):
    root = _package(tmp_path, {
        "forge/__init__.py": "from forge.child import VALUE\nlimit = 1\n",
        "forge/child.py": "import types\nimport forge as config\nVALUE = config.limit\n"
                          "config = types.SimpleNamespace(limit=2)\n",
    }, name="forge")
    assert not _imports_cleanly(root, "forge")
    assert _cycles(_import_graph(root)) == [["forge", "forge.child"]]


def test_generator_that_is_never_iterated_is_not_a_cycle(tmp_path):
    # Making a generator runs only its first iterable.
    root = _package(tmp_path, {
        "pkg/__init__.py": "from pkg.child import VALUES\nlimit = 1\n",
        "pkg/child.py": "import pkg as parent\nVALUES = (parent.limit for _ in range(1))\n",
    })
    assert _imports_cleanly(root, "pkg")
    assert _cycles(_import_graph(root)) == []


def test_comprehensions_calls_and_a_generator_first_iterable_run_while_loading(tmp_path):
    for index, source in enumerate((
        "VALUES = (item for item in parent.items)\n",
        "VALUES = [parent.limit for _ in range(1)]\n",
        "VALUES = {parent.limit for _ in range(1)}\n",
        "VALUES = {key: parent.limit for key in range(1)}\n",
        "VALUES = list((parent.limit,))\n",
    )):
        root = _package(tmp_path / f"case{index}", {
            "pkg/__init__.py": "from pkg.child import VALUES\nlimit = 1\nitems = ()\n",
            "pkg/child.py": "import pkg as parent\n" + source,
        })
        assert not _imports_cleanly(root, "pkg"), source
        assert _cycles(_import_graph(root)) == [["pkg", "pkg.child"]], source


def test_names_under_type_checking_do_not_run(tmp_path):
    root = _package(tmp_path, {
        "pkg/__init__.py": "from pkg.child import VALUE\nvalue = 1\n",
        "pkg/child.py": "from typing import TYPE_CHECKING\nif TYPE_CHECKING:\n"
                        "    from pkg import value\nVALUE = 2\n",
    })
    assert _imports_cleanly(root, "pkg")
    assert _cycles(_import_graph(root)) == []
