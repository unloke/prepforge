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
    uci_blob TEXT NOT NULL DEFAULT '',
    white TEXT,
    black TEXT,
    result TEXT NOT NULL DEFAULT '*',
    event TEXT,
    site TEXT,
    played_at TEXT,
    lichess_id TEXT,
    tags_json TEXT NOT NULL DEFAULT '{}',
    owner_user_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_games_owner ON games(owner_user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_games_owner_lichess
    ON games(owner_user_id, lichess_id);

-- Shared position catalog. Identity is the full 6-field FEN; never a short hash.
CREATE TABLE IF NOT EXISTS positions (
    id INTEGER PRIMARY KEY,
    fen TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS engine_evaluations (
    id INTEGER PRIMARY KEY,
    position_id INTEGER NOT NULL,
    engine TEXT NOT NULL,
    depth INTEGER NOT NULL,
    nodes INTEGER NOT NULL,
    time_ms INTEGER NOT NULL,
    score_cp INTEGER,
    mate_in INTEGER,
    best_move_uci TEXT,
    pv TEXT NOT NULL DEFAULT '',
    wdl_win INTEGER,
    wdl_draw INTEGER,
    wdl_loss INTEGER,
    FOREIGN KEY (position_id) REFERENCES positions(id),
    UNIQUE (position_id, engine, depth, nodes, time_ms)
);

CREATE TABLE IF NOT EXISTS moves (
    game_id TEXT NOT NULL,
    ply INTEGER NOT NULL,
    uci TEXT NOT NULL,
    engine_eval_before_id INTEGER,
    engine_eval_after_id INTEGER,
    best_move_uci TEXT,
    best_move_eval_id INTEGER,
    classification TEXT NOT NULL DEFAULT 'unknown',
    comment TEXT,
    tags_json TEXT,
    source TEXT NOT NULL,
    PRIMARY KEY (game_id, ply),
    FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
    FOREIGN KEY (engine_eval_before_id) REFERENCES engine_evaluations(id),
    FOREIGN KEY (engine_eval_after_id) REFERENCES engine_evaluations(id),
    FOREIGN KEY (best_move_eval_id) REFERENCES engine_evaluations(id)
);

CREATE INDEX IF NOT EXISTS idx_moves_game_ply ON moves(game_id, ply);

CREATE TABLE IF NOT EXISTS analysis_results (
    id TEXT PRIMARY KEY,
    game_id TEXT NOT NULL,
    analyzed_at TEXT NOT NULL,
    engine TEXT NOT NULL,
    depth INTEGER,
    summary_json TEXT NOT NULL DEFAULT '{}',
    critical_ply TEXT NOT NULL DEFAULT '',
    FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
);

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
    health_json TEXT,
    FOREIGN KEY (user_profile_id) REFERENCES user_profiles(id)
);

CREATE INDEX IF NOT EXISTS idx_repertoires_owner ON repertoires(user_profile_id);
CREATE INDEX IF NOT EXISTS idx_repertoires_team ON repertoires(team_id);

CREATE TABLE IF NOT EXISTS opening_nodes (
    id TEXT PRIMARY KEY,
    repertoire_id TEXT NOT NULL,
    parent_id TEXT,
    uci TEXT,
    engine_evaluation_id INTEGER,
    maia_probability REAL,
    is_mainline INTEGER NOT NULL DEFAULT 0,
    is_user_prepared_move INTEGER NOT NULL DEFAULT 0,
    is_enabled INTEGER NOT NULL DEFAULT 1,
    priority REAL NOT NULL DEFAULT 0,
    comment TEXT,
    tags_json TEXT,
    arrows_json TEXT,
    circles_json TEXT,
    tactical_warning TEXT,
    strategic_idea TEXT,
    typical_plan TEXT,
    source TEXT NOT NULL DEFAULT 'manual',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (repertoire_id) REFERENCES repertoires(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_id) REFERENCES opening_nodes(id) ON DELETE CASCADE,
    FOREIGN KEY (engine_evaluation_id) REFERENCES engine_evaluations(id)
);

CREATE INDEX IF NOT EXISTS idx_opening_nodes_repertoire_parent
    ON opening_nodes(repertoire_id, parent_id);

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

CREATE INDEX IF NOT EXISTS idx_training_sessions_rep_mode_updated
    ON training_sessions(repertoire_id, mode, updated_at);

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

CREATE INDEX IF NOT EXISTS idx_training_progress_rep_user
    ON training_progress(repertoire_id, user_profile_id);

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

CREATE TABLE IF NOT EXISTS user_sessions (
    token_hash TEXT PRIMARY KEY,
    user_profile_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    FOREIGN KEY (user_profile_id) REFERENCES user_profiles(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_profile ON user_sessions(user_profile_id);
