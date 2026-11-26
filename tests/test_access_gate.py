"""The shared repertoire access gate, and that routers reach it only through it."""
from __future__ import annotations

import ast
from pathlib import Path

import pytest
from fastapi import HTTPException

from prepforge_chess.api.access import editable_repertoire, owned_repertoire, require_access

ROUTERS = Path(__file__).resolve().parents[1] / "src" / "prepforge_chess" / "api" / "routers"


class FakeAccess:
    def __init__(self, role):
        self.role = role
        self.op_actor = None
        self.op_kind = None

    def access_role(self, repertoire_id, user_id):
        return ({"id": repertoire_id, "name": "Prep"} if self.role else None), self.role

    def list_shared_with(self, user_id):
        return []


def test_returns_meta_with_the_callers_role():
    assert require_access(FakeAccess("copy"), "r1", "u1", "copy") == {"id": "r1", "name": "Prep", "role": "copy"}


def test_no_access_is_a_404_that_never_reveals_the_repertoire():
    with pytest.raises(HTTPException) as caught:
        require_access(FakeAccess(None), "r1", "u1")
    assert (caught.value.status_code, caught.value.detail) == (404, "repertoire not found")


@pytest.mark.parametrize(("role", "need", "detail"), [
    ("view", "copy", "The owner hasn't allowed copies of this repertoire."),
    ("copy", "edit", "You can't edit this repertoire."),
    ("edit", "owner", "Only the owner can do this."),
])
def test_a_role_below_the_need_is_a_403(role, need, detail):
    with pytest.raises(HTTPException) as caught:
        require_access(FakeAccess(role), "r1", "u1", need)
    assert (caught.value.status_code, caught.value.detail) == (403, detail)


def test_owner_and_edit_gates_stamp_the_author_of_the_writes():
    owner = FakeAccess("owner")
    owned_repertoire(owner, "r1", "u1")
    assert (owner.op_actor, owner.op_kind) == ("u1", None)
    editor = FakeAccess("edit")
    editable_repertoire(editor, "r1", "u2", "add_move")
    assert (editor.op_actor, editor.op_kind) == ("u2", "add_move")
    with pytest.raises(HTTPException):
        owned_repertoire(FakeAccess("edit"), "r1", "u2")


def test_no_router_reaches_into_the_workspace_router():
    found = []
    for path in ROUTERS.glob("*.py"):
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if isinstance(node, ast.ImportFrom) and node.module == "prepforge_chess.api.routers.workspace":
                found.append(f"{path.name}: {', '.join(alias.name for alias in node.names)}")
            if isinstance(node, ast.ImportFrom) and node.module == "prepforge_chess.api.routers":
                found += [f"{path.name}: workspace" for alias in node.names if alias.name == "workspace"]
    assert found == []
