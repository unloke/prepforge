from prepforge_chess.storage.database import apply_schema, connect_database, list_tables


def test_schema_can_initialize_in_memory_database():
    connection = connect_database()

    apply_schema(connection)

    tables = set(list_tables(connection))
    assert "games" in tables
    assert "moves" in tables
    assert "repertoires" in tables
    assert "training_sessions" in tables
