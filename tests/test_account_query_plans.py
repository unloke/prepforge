from sqlalchemy import text

from prepforge_chess.storage.database import apply_schema, connect_database


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
