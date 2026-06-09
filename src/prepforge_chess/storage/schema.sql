PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS user_profiles (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    lichess_username TEXT,
    preferred_engine TEXT NOT NULL DEFAULT 'stockfish',
    default_analysis_depth INTEGER NOT NULL DEFAULT 16,
    settings_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS games (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    initial_fen TEXT NOT NULL,
    white TEXT,
    black TEXT,
    result TEXT NOT NULL DEFAULT '*',
    event TEXT,
    site TEXT,
    played_at TEXT,
    pgn TEXT,
    -- Not globally UNIQUE: multi-tenancy dedups Lichess games per owner, so two
    -- users may each hold their own row for the same lichess_id. Uniqueness is
    -- enforced per-owner by idx_games_owner_lichess (see _apply_multitenancy_migration).
    lichess_id TEXT,
    tags_json TEXT NOT NULL DEFAULT '{}',
    -- Multi-tenancy isolation root for owned games (see sa_tables / ROADMAP Phase 2).
    owner_user_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_games_owner ON games(owner_user_id);
-- Per-owner Lichess dedup. NULLs are distinct, so ownerless / non-Lichess rows
-- are never constrained.
CREATE UNIQUE INDEX IF NOT EXISTS idx_games_owner_lichess
    ON games(owner_user_id, lichess_id);

CREATE TABLE IF NOT EXISTS positions (
    id TEXT PRIMARY KEY,
    fen TEXT NOT NULL UNIQUE,
    side_to_move TEXT NOT NULL,
    move_number INTEGER NOT NULL,
    halfmove_clock INTEGER NOT NULL DEFAULT 0,
    fullmove_number INTEGER NOT NULL DEFAULT 1,
    legal_moves_json TEXT NOT NULL DEFAULT '[]',
    tags_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS engine_evaluations (
    id TEXT PRIMARY KEY,
    fen TEXT NOT NULL,
    engine TEXT NOT NULL,
    depth INTEGER,
    nodes INTEGER,
    time_ms INTEGER,
    score_cp INTEGER,
    mate_in INTEGER,
    best_move_uci TEXT,
    pv_json TEXT NOT NULL DEFAULT '[]',
    wdl_json TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (fen, engine, depth, nodes, time_ms)
);

CREATE TABLE IF NOT EXISTS moves (
    id TEXT PRIMARY KEY,
    game_id TEXT,
    ply INTEGER NOT NULL,
    move_number INTEGER NOT NULL,
    side_to_move TEXT NOT NULL,
    uci TEXT NOT NULL,
    san TEXT NOT NULL,
    fen_before TEXT NOT NULL,
    fen_after TEXT NOT NULL,
    engine_eval_before_id TEXT,
    engine_eval_after_id TEXT,
    best_move_uci TEXT,
    best_move_eval_id TEXT,
    classification TEXT NOT NULL DEFAULT 'unknown',
    comment TEXT,
    tags_json TEXT NOT NULL DEFAULT '[]',
    source TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
    FOREIGN KEY (engine_eval_before_id) REFERENCES engine_evaluations(id),
    FOREIGN KEY (engine_eval_after_id) REFERENCES engine_evaluations(id),
    FOREIGN KEY (best_move_eval_id) REFERENCES engine_evaluations(id)
);

CREATE INDEX IF NOT EXISTS idx_moves_game_ply ON moves(game_id, ply);
CREATE INDEX IF NOT EXISTS idx_moves_fen_before ON moves(fen_before);
CREATE INDEX IF NOT EXISTS idx_moves_uci ON moves(uci);

CREATE TABLE IF NOT EXISTS analysis_results (
    id TEXT PRIMARY KEY,
    game_id TEXT NOT NULL,
    analyzed_at TEXT NOT NULL,
    engine TEXT NOT NULL,
    depth INTEGER,
    summary_json TEXT NOT NULL DEFAULT '{}',
    critical_ply_json TEXT NOT NULL DEFAULT '[]',
    config_json TEXT NOT NULL DEFAULT '{}',
    FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS maia_predictions (
    id TEXT PRIMARY KEY,
    fen TEXT NOT NULL,
    move_uci TEXT NOT NULL,
    probability REAL NOT NULL,
    model TEXT NOT NULL DEFAULT 'maia3',
    rating_bucket TEXT,
    rank INTEGER,
    sample_size INTEGER,
    created_at TEXT NOT NULL,
    UNIQUE (fen, move_uci, model, rating_bucket)
);

CREATE INDEX IF NOT EXISTS idx_maia_predictions_fen ON maia_predictions(fen);

CREATE TABLE IF NOT EXISTS repertoires (
    id TEXT PRIMARY KEY,
    user_profile_id TEXT,
    name TEXT NOT NULL,
    color TEXT NOT NULL,
    root_fen TEXT NOT NULL,
    root_node_id TEXT,
    main_engine TEXT NOT NULL DEFAULT 'stockfish',
    human_model TEXT NOT NULL DEFAULT 'maia3',
    branch_depth INTEGER NOT NULL DEFAULT 12,
    opponent_branch_threshold REAL NOT NULL DEFAULT 0.10,
    sub_branch_threshold REAL NOT NULL DEFAULT 0.30,
    max_total_nodes INTEGER NOT NULL DEFAULT 1000,
    max_line_length INTEGER NOT NULL DEFAULT 24,
    notes TEXT,
    tags_json TEXT NOT NULL DEFAULT '[]',
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    team_id TEXT,
    visibility TEXT,
    FOREIGN KEY (user_profile_id) REFERENCES user_profiles(id)
);

CREATE INDEX IF NOT EXISTS idx_repertoires_owner ON repertoires(user_profile_id);
CREATE INDEX IF NOT EXISTS idx_repertoires_team ON repertoires(team_id);

CREATE TABLE IF NOT EXISTS opening_nodes (
    id TEXT PRIMARY KEY,
    repertoire_id TEXT NOT NULL,
    parent_id TEXT,
    move_id TEXT,
    fen TEXT NOT NULL,
    side_to_move TEXT NOT NULL,
    engine_evaluation_id TEXT,
    maia_probability REAL,
    is_mainline INTEGER NOT NULL DEFAULT 0,
    is_user_prepared_move INTEGER NOT NULL DEFAULT 0,
    is_enabled INTEGER NOT NULL DEFAULT 1,
    priority REAL NOT NULL DEFAULT 0,
    comment TEXT,
    tags_json TEXT NOT NULL DEFAULT '[]',
    arrows_json TEXT NOT NULL DEFAULT '[]',
    circles_json TEXT NOT NULL DEFAULT '[]',
    tactical_warning TEXT,
    strategic_idea TEXT,
    typical_plan TEXT,
    source TEXT NOT NULL DEFAULT 'manual',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (repertoire_id) REFERENCES repertoires(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_id) REFERENCES opening_nodes(id) ON DELETE CASCADE,
    FOREIGN KEY (move_id) REFERENCES moves(id),
    FOREIGN KEY (engine_evaluation_id) REFERENCES engine_evaluations(id)
);

CREATE INDEX IF NOT EXISTS idx_opening_nodes_repertoire_parent
    ON opening_nodes(repertoire_id, parent_id);
CREATE INDEX IF NOT EXISTS idx_opening_nodes_fen ON opening_nodes(fen);

CREATE TABLE IF NOT EXISTS opening_lines (
    id TEXT PRIMARY KEY,
    repertoire_id TEXT NOT NULL,
    name TEXT,
    node_ids_json TEXT NOT NULL,
    priority REAL NOT NULL DEFAULT 0,
    tags_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (repertoire_id) REFERENCES repertoires(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS generation_runs (
    id TEXT PRIMARY KEY,
    repertoire_id TEXT NOT NULL,
    root_node_id TEXT NOT NULL,
    config_json TEXT NOT NULL,
    summary_json TEXT NOT NULL,
    undo_log_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    FOREIGN KEY (repertoire_id) REFERENCES repertoires(id) ON DELETE CASCADE,
    FOREIGN KEY (root_node_id) REFERENCES opening_nodes(id)
);

CREATE TABLE IF NOT EXISTS training_sessions (
    id TEXT PRIMARY KEY,
    repertoire_id TEXT NOT NULL,
    mode TEXT NOT NULL,
    line_order_json TEXT NOT NULL,
    current_index INTEGER NOT NULL DEFAULT 0,
    current_node_id TEXT,
    mistakes_json TEXT NOT NULL DEFAULT '[]',
    mastered_nodes_json TEXT NOT NULL DEFAULT '[]',
    seed INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (repertoire_id) REFERENCES repertoires(id) ON DELETE CASCADE,
    FOREIGN KEY (current_node_id) REFERENCES opening_nodes(id)
);

CREATE TABLE IF NOT EXISTS training_progress (
    id TEXT PRIMARY KEY,
    user_profile_id TEXT,
    repertoire_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    correct_attempts INTEGER NOT NULL DEFAULT 0,
    last_reviewed_at TEXT,
    spaced_repetition_score REAL NOT NULL DEFAULT 0,
    due_at TEXT,
    is_mastered INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (user_profile_id) REFERENCES user_profiles(id),
    FOREIGN KEY (repertoire_id) REFERENCES repertoires(id) ON DELETE CASCADE,
    FOREIGN KEY (node_id) REFERENCES opening_nodes(id) ON DELETE CASCADE,
    UNIQUE (user_profile_id, repertoire_id, node_id)
);

CREATE TABLE IF NOT EXISTS training_mistakes (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    repertoire_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    expected_uci TEXT NOT NULL,
    played_uci TEXT NOT NULL,
    fen_before TEXT NOT NULL,
    mistake_count INTEGER NOT NULL DEFAULT 1,
    resolved_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES training_sessions(id) ON DELETE SET NULL,
    FOREIGN KEY (repertoire_id) REFERENCES repertoires(id) ON DELETE CASCADE,
    FOREIGN KEY (node_id) REFERENCES opening_nodes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS lichess_imports (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    requested_count INTEGER NOT NULL,
    imported_game_ids_json TEXT NOT NULL DEFAULT '[]',
    skipped_game_ids_json TEXT NOT NULL DEFAULT '[]',
    errors_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS practical_opening_matches (
    id TEXT PRIMARY KEY,
    game_id TEXT NOT NULL,
    user_color TEXT NOT NULL,
    repertoire_id TEXT,
    matched_plies INTEGER NOT NULL,
    last_matched_node_id TEXT,
    departure_ply INTEGER,
    departure_move_uci TEXT,
    departure_reason TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
    FOREIGN KEY (repertoire_id) REFERENCES repertoires(id) ON DELETE SET NULL,
    FOREIGN KEY (last_matched_node_id) REFERENCES opening_nodes(id)
);

CREATE TABLE IF NOT EXISTS engine_settings (
    id TEXT PRIMARY KEY,
    engine_name TEXT NOT NULL,
    executable_path TEXT,
    default_depth INTEGER,
    default_nodes INTEGER,
    default_time_ms INTEGER,
    options_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- Maps a browser cookie (token hash) to a user_profiles row. Legacy guest /
-- Lichess sessions live here (the multi-tenancy session table).
CREATE TABLE IF NOT EXISTS user_sessions (
    token_hash TEXT PRIMARY KEY,
    user_profile_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    FOREIGN KEY (user_profile_id) REFERENCES user_profiles(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_profile ON user_sessions(user_profile_id);
