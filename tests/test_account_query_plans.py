from sqlalchemy import text

from prepforge_chess.storage.database import apply_schema, connect_database


def test_mastery_recursion_uses_repertoire_and_parent_index_columns():
    from sqlalchemy import event
    from prepforge_chess.storage.repositories import PrepForgeRepository

    engine = connect_database()
    apply_schema(engine)
    statements = []
    def collect(_conn, _cursor, sql, params, _context, _many):
        statements.append((sql, params))
    event.listen(engine, "before_cursor_execute", collect)
    try:
        PrepForgeRepository(engine).due_counts_by_repertoire("owner")
    finally:
        event.remove(engine, "before_cursor_execute", collect)
    assert len(statements) == 1
    sql, params = statements[0]
    with engine.connect() as conn:
        plan = list(conn.exec_driver_sql("EXPLAIN QUERY PLAN " + sql, params))
    searches = [row[3] for row in plan if "idx_opening_nodes_repertoire_parent" in row[3]
                and "repertoire_id=? AND parent_id=?" in row[3]]
    assert len(searches) == 2, plan  # anchor and recursive step


def test_account_lifecycle_indexes_support_filter_and_order():
    engine = connect_database()
    apply_schema(engine)
    queries = [
        ("SELECT id FROM games WHERE owner_user_id='owner' ORDER BY created_at DESC, id DESC LIMIT 100",
         "idx_games_owner_created"),
        ("SELECT id FROM analysis_results WHERE game_id='game' ORDER BY analyzed_at DESC, id DESC LIMIT 1",
         "idx_analysis_results_game_latest"),
        ("SELECT COUNT(*) FROM train_attempt_receipts WHERE created_at < '2026-01-01'",
         "ix_train_attempt_receipts_created_at"),
    ]
    with engine.connect() as conn:
        for query, index in queries:
            plan = " ".join(str(row) for row in conn.execute(text("EXPLAIN QUERY PLAN " + query)))
            assert index in plan
            assert "TEMP B-TREE" not in plan
