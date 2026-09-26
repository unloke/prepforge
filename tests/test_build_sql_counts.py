"""Build mutations must not issue one statement per existing tree node."""

import os

import pytest
from sqlalchemy import create_engine, event

from prepforge_chess.core.models import Color
from prepforge_chess.services.opening_builder import CreateRepertoireRequest, OpeningBuilderService
from prepforge_chess.services.workspace_view import build_workspace_payload
from prepforge_chess.storage import sa_tables
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


def _seed_chain(builder, name, ucs):
    rep = builder.create_repertoire(CreateRepertoireRequest(name, Color.WHITE))
    parent = rep.root_node.id
    for uci in ucs:
        parent = builder.add_move(rep.id, parent, uci).id
    return rep.id


def _list_statement_profile(engine, repo, builder):
    """Statement count of ``list_repertoires`` with 5 repertoires vs 1.

    Returns ``(count_one, count_many, listed_one, listed_many)`` so callers can
    assert the count is O(1) in the repertoire count while the result set
    grows — the regression guard for the old id-list + ``load_repertoire(id)``
    × N shape, which scaled linearly with N (per repertoire: one SELECT for the
    repertoire row, one for its opening nodes, plus one more per referenced
    evaluation batch).
    """
    _seed_chain(builder, "SQL list solo", ["e2e4", "e7e5"])
    count_one, listed_one = count_statements(engine, lambda: repo.list_repertoires())
    for index in range(4):
        _seed_chain(builder, "SQL list rep {0}".format(index), ["d2d4", "d7d5", "c2c4"])
    count_many, listed_many = count_statements(engine, lambda: repo.list_repertoires())
    return count_one, count_many, listed_one, listed_many


def test_list_repertoires_statement_count_is_constant():
    """SQLite twin of the postgres variant below — same O(1) profile (2 or 3
    statements regardless of repertoire count), same assertions."""
    engine = connect_database()
    apply_schema(engine)
    repo = PrepForgeRepository(engine)
    builder = OpeningBuilderService(repo)

    count_one, count_many, listed_one, listed_many = _list_statement_profile(
        engine, repo, builder
    )
    assert len(listed_one) == 1
    assert len(listed_many) == 5
    # 1 repertoire and 5 repertoires cost the same number of statements: O(1).
    # Either 2 statements (no referenced engine evaluations) or 3 (one extra
    # SELECT for the referenced evaluations).
    assert count_many == count_one
    assert count_many in (2, 3)


def _psycopg3_url(raw: str) -> str:
    # TEST_POSTGRES_URL is a bare postgresql:// URL, which SQLAlchemy maps to the
    # psycopg2 dialect — but the project ships psycopg 3 (same pin as config.py).
    if raw.startswith("postgresql://"):
        return "postgresql+psycopg://" + raw[len("postgresql://") :]
    if raw.startswith("postgres://"):
        return "postgresql+psycopg://" + raw[len("postgres://") :]
    return raw


def test_list_repertoires_statement_count_postgres():
    """PostgreSQL variant of the SQLite count guard above — identical O(1)
    profile (2 or 3 statements regardless of repertoire count) so the dialect
    cannot regress the batching."""
    url = os.getenv("TEST_POSTGRES_URL")
    if not url:
        pytest.skip("TEST_POSTGRES_URL is not configured")
    engine = create_engine(_psycopg3_url(url), future=True)
    sa_tables.metadata.create_all(engine, tables=list(sa_tables.DOMAIN_TABLES))
    repo = PrepForgeRepository(engine)
    builder = OpeningBuilderService(repo)

    count_one, count_many, listed_one, listed_many = _list_statement_profile(
        engine, repo, builder
    )
    # Relative assertions: the CI database is shared, so other runs may have
    # left repertoires behind — only the growth and the statement count matter.
    # The count is O(1) in the repertoire count: 2 statements without referenced
    # engine evaluations, 3 with them.
    assert len(listed_many) - len(listed_one) == 4
    assert count_many == count_one
    assert count_many in (2, 3)
