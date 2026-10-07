from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, inspect, text

from prepforge_chess.api.config import get_settings
from prepforge_chess.core.chess_core import STARTING_FEN
from prepforge_chess.storage.repositories import PrepForgeRepository


def test_remove_compute_settings_preserves_repertoire_tree(tmp_path, monkeypatch):
    url = "sqlite:///" + (tmp_path / "compute-cleanup.sqlite3").as_posix()
    monkeypatch.setenv("DATABASE_URL", url)
    get_settings.cache_clear()
    cfg = Config("alembic.ini")
    engine = create_engine(url)
    try:
        command.upgrade(cfg, "a73c9e8124bf")
        with engine.begin() as conn:
            conn.exec_driver_sql("PRAGMA foreign_keys=ON")
            conn.execute(text("""
                INSERT INTO repertoires (
                    id, name, color, root_fen, root_node_id, main_engine, human_model,
                    branch_depth, opponent_branch_threshold, sub_branch_threshold,
                    max_total_nodes, max_line_length, notes, tags_json, is_active,
                    created_at, updated_at
                ) VALUES (
                    'rep', 'Keep this tree', 'white', :fen, 'root', 'stockfish', 'maia3',
                    12, 0.1, 0.3, 1000, 24, 'My notes', '[]', 1,
                    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                )
            """), {"fen": STARTING_FEN})
            conn.execute(text("""
                INSERT INTO opening_nodes (
                    id, repertoire_id, parent_id, uci, is_mainline,
                    is_user_prepared_move, is_enabled, priority, source,
                    created_at, updated_at
                ) VALUES (
                    :id, 'rep', :parent, :uci, 1, :prepared, 1, 0, 'manual',
                    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                )
            """), [
                {"id": "root", "parent": None, "uci": None, "prepared": 0},
                {"id": "child", "parent": "root", "uci": "e2e4", "prepared": 1},
            ])
        command.upgrade(cfg, "head")
        tables = set(inspect(engine).get_table_names())
        assert "engine_settings" not in tables and "app_settings" not in tables
        repertoire = PrepForgeRepository(engine).load_repertoire("rep")
        assert repertoire.name == "Keep this tree" and repertoire.notes == "My notes"
        assert repertoire.root_node.children[0].move.uci == "e2e4"
        assert repertoire.root_node.children[0].is_user_prepared_move
        with engine.connect() as conn:
            assert not conn.exec_driver_sql("PRAGMA foreign_key_check").all()
    finally:
        engine.dispose()
        get_settings.cache_clear()
