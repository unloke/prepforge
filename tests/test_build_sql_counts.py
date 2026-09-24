"""Build mutations must not issue one statement per existing tree node."""

from sqlalchemy import event

from prepforge_chess.core.models import Color
from prepforge_chess.services.opening_builder import CreateRepertoireRequest, OpeningBuilderService
from prepforge_chess.services.workspace_view import build_workspace_payload
from prepforge_chess.storage.database import apply_schema, connect_database
from prepforge_chess.storage.repositories import PrepForgeRepository


def count_statements(engine, operation):
    statements = []

    def collect(_conn, _cursor, statement, _parameters, _context, _executemany):
        statements.append(statement)

    event.listen(engine, "before_cursor_execute", collect)
    try:
        result = operation()
    finally:
        event.remove(engine, "before_cursor_execute", collect)
    return len(statements), result


def test_build_mutations_have_constant_statement_counts():
    engine = connect_database()
    apply_schema(engine)
    repo = PrepForgeRepository(engine)
    builder = OpeningBuilderService(repo)
    rep = builder.create_repertoire(CreateRepertoireRequest("SQL counts", Color.WHITE))
    root = rep.root_node
    first = builder.add_move(rep.id, root.id, "e2e4")
    second = builder.add_move(rep.id, first.id, "e7e5")
    # The benchmark covers 500/2000 nodes; this test checks the SQL shape.
    for move in ["g1f3", "b8c6", "f1c4", "g8f6"]:
        second = builder.add_move(rep.id, second.id, move)

    count, _ = count_statements(engine, lambda: builder.mark_prepared(rep.id, first.id))
    assert count <= 3
    count, _ = count_statements(
        engine, lambda: builder.set_annotations(rep.id, first.id, ["Ge2e4"], ["Rd4"])
    )
    assert count <= 3
    count, _ = count_statements(engine, lambda: build_workspace_payload(repo, rep.id))
    assert count <= 3
    count, _ = count_statements(engine, lambda: build_workspace_payload(repo, rep.id))
    assert count == 2  # unchanged health needs no UPDATE
    count, _ = count_statements(engine, lambda: builder.add_moves_batch(
        rep.id, [
            {"tempId": "tmp-1", "parentRef": root.id, "uci": "d2d4"},
            {"tempId": "tmp-2", "parentRef": root.id, "uci": "c2c4"},
            {"tempId": "tmp-3", "parentRef": root.id, "uci": "g1f3"},
        ]
    ))
    assert count <= 3
