# PrepForge Backend Context Library

> Neutral factual index of the server at commit `e1a9ce1d1bc374a8b8dde26a32c5e2ff0c3ad5dc`
> (origin/main, 2026-09-29). All line numbers refer to that commit. Statements are
> observations of code and tests as they exist. No findings, severity, intent, or
> recommendations are included.

**Scope**: `src/prepforge_chess/**` (FastAPI app, routers, services, storage),
`migrations/**`, backend tests in `tests/**`. Frontend is not covered here (see
`frontend-library.md`); API consumers are referenced only where contracts matter.

**Module layout**:

| Layer | Path | Role |
|---|---|---|
| App composition | `src/prepforge_chess/api/` | `main.py` (create_app), `deps.py`, `middleware.py`, `models.py` (ORM identity/team tables), `security.py`, `db.py`, `config.py`, `static.py`, `observability.py` |
| Routers | `src/prepforge_chess/api/routers/` | auth, google_auth, lichess, workspace, train, teams, analyze, settings, billing, clientlog, legal |
| Domain services | `src/prepforge_chess/services/` | training, training_smart, scheduler, progress, streak, repertoire_matching, repertoire_export, opening_builder, opening_generation, pgn_import, lichess_fetch, lichess_oauth, google_oauth, classification, browser_compute, brilliant, analysis, analysis_view, analysis_report, maia, engine, engine_paths, stockfish_download, app_settings, dashboard_recommendations, training_view, workspace_view, game_navigation, replay_engine, replay_maia, device |
| Domain models | `src/prepforge_chess/core/models.py` | dataclasses: Game 126, MoveRecord 107, Position 96, Repertoire 191, OpeningNode 154, TrainingProgress 210, TrainingSession 221, AnalysisResult 143, EngineEvaluation 66; enums Color/MoveSource/MoveClassification/GameResult/TrainingMode |
| Storage | `src/prepforge_chess/storage/` | `sa_tables.py` (SQLAlchemy Core tables), `repositories.py` (`PrepForgeRepository` 105), `codec.py` (FEN/UCI/PGN encodings), `database.py` (connect/apply_schema) |
| Migrations | `migrations/` + `alembic.ini` | Alembic versions (used when persisted fields change; e.g. `test_migration_lichess_primary.py`) |

## 1. Architecture

### 1.1 FastAPI app composition

- `api/main.py` `create_app()` (53); `_lifespan` (42) configures logging/Sentry.
  Middleware order: GZip → `SecurityHeadersMiddleware` (`api/middleware.py:75`,
  CSP from `build_csp` 56) → `CSRFMiddleware` (`api/middleware.py:91`,
  double-submit `pf_csrf` cookie vs `X-CSRF-Token` header; exempt: Stripe billing
  webhook + clientlog) → CORS. Static assets + index served by
  `register_static` (`api/static.py:256`; `_render_index` 206 injects asset-base
  script + document CSP, `_maia3_asset_base`/`_engine_asset_base` 117/121).
- **DI** (`api/deps.py`): `current_user_optional` (21; session cookie →
  `AuthSession` → `User`), `current_user` (45), `require_pro` (51; `Plan` gate),
  `get_repository` (60; `PrepForgeRepository` over the shared engine),
  `current_owner` (69; `user.id` string used as `owner_user_id`).
- **DB session/engine** (`api/db.py`): `make_engine` (21), `get_engine` (71),
  `get_db` (80, `Session` per request); `Base` declarative base (17) for ORM
  identity tables only. `api/config.py` `Settings` (21) carries env config
  (DB URL, session/CSRF secrets, OAuth creds, Stripe, `PREPFORGE_SERVER_ENGINE_ENABLED`).
- **Auth/crypto helpers** (`api/security.py`): `hash_password`/`verify_password`
  (48/52, argon2-style via passlib), `new_session_token`/`hash_session_token`
  (71/76, tokens stored hashed), `encrypt_token`/`decrypt_token` (88/93, Fernet
  for linked-account OAuth tokens).

### 1.2 Router inventory (entrypoints only)

| Router | Endpoints (symbol @ line) |
|---|---|
| `routers/auth.py` | register 103, login 128, logout 158, me 175, providers 185; session cap `_enforce_session_cap` 74, cookie `_set_session_cookie` 52 |
| `routers/google_auth.py` | login 44, callback 73 (`services/google_oauth.py`) |
| `routers/lichess.py` | status 106, set_primary 121, login 167, callback 176, unlink_one 250, unlink 274, explorer_proxy 330, compare GET 506 / POST 529, latest 544, mark_seen 615 |
| `routers/workspace.py` | dashboard 108, list_repertoires 238, build_load 286, share_repertoire 314, delete_repertoire 345, set_repertoire_active 362, create_repertoire 442, create_share_link 508, shared_repertoire 521, fork_shared_repertoire 550, fork_repertoire 576, build_rename 612, build_add_move 633, build_add_moves 698, build_delete_nodes 740, build_apply_plan 784, build_action 841, build_annotations 898, build_export 923, import_repertoire 982, import_repertoire_pgn 1021 |
| `routers/train.py` | start 81, record_miss 130, smart_start 247, smart_summary 322, smart_move 359, smart_sync 425, smart_skip 456, skip 468, hint 480, move 537 |
| `routers/teams.py` | create_team 143, list_teams 160, join_preview 181, join_team 206, team_detail 242, add_member 330, remove_member 375, update_member_role 406, create_invite 438, revoke_invite 470, update_team 504, delete_team 523 |
| `routers/analyze.py` | analyze_prepare 128, analyze_classify_save 206, list_analyses 311, recall_analysis 320, board 356, board_move 374 |
| `routers/settings.py` | get_settings 58, update_settings 77 (`_settings_payload` 43) |
| `routers/billing.py` | billing_status 70, create_checkout 84, create_portal 114, stripe_webhook 163 (`_apply_event` 141, idempotent via `StripeEvent`) |
| `routers/clientlog.py` | client_log 67 (CSRF-exempt structured client error log) |
| `routers/legal.py` | terms 51, privacy 56 |

### 1.3 Service/domain modules (by concern)

- **Training (line-based)**: `services/training.py` — `TrainingService` (108),
  `create_training_session` 68, `resume_or_create_session` 90, `record_attempt`
  474, `update_spaced_repetition` 507.
- **Training (smart/SRS)**: `services/training_smart.py` — `SmartTrainingService`
  (131): `start_or_resume` 169, `start_or_resume_mixed` 245, `current_prompt` 408,
  `skip_card` 414, `session_card_bundle` 531, `sync_progress` 624-837,
  `submit_move` 838-928, `_requeue_card` 929. `services/scheduler.py` —
  `build_session_plan` 243, `mix_plans` 431, `encode_card`/`decode_card` 92/100.
  `services/progress.py` — `node_mastery` 48, `mastery_map` 81, `due_node_ids` 97,
  `compute_health` 171. `services/streak.py` — `advance` 55 (idempotent per day),
  `as_view` 82.
- **Repertoire**: `services/opening_builder.py` `OpeningBuilderService` (199);
  `services/opening_generation.py` `generate_from_position` 179,
  `merge_existing_node` 122; `services/repertoire_matching.py`
  `match_game_to_repertoire` 65, `match_game_against_repertoires` 134,
  `select_deepest_match` 125; `services/repertoire_export.py`
  `RepertoireExportService` (86).
- **Lichess ingest/compare**: `services/lichess_fetch.py` —
  `fetch_explorer_json` 35 (with `ExplorerRateLimitedError` 31),
  `fetch_recent_pgns` 112, `fetch_latest_games_meta` 192,
  `newest_game_across` 263, `determine_user_color` 427,
  `compare_recent_games` 436, `compare_many_identities` 479,
  `record_departure_misses` 551-615, `_build_summary` 617.
  OAuth: `services/lichess_oauth.py` (build_authorize_url 52, exchange_code 82,
  fetch_account 100).
- **Games import/dedupe**: `services/pgn_import.py` `PgnImportService` (37).
- **Analyze/classification**: `services/analysis.py` `AnalysisService` (160),
  `services/classification.py` `classify_move` 88 (cp→win-chance 58/71/83),
  `services/browser_compute.py` `classify_precomputed_game` 99,
  `services/brilliant.py` `BrilliantAnalyzer` 79, `services/analysis_view.py`
  `analysis_result_to_payload` 47, `services/analysis_report.py`
  `AnalysisReportBuilder` 44.
- **Engines/Maia (server-side)**: `services/engine.py` (`UciEngine` 166,
  `StockfishEngine` 319, `MockEngine` 62), `services/maia.py`
  (`Maia3Adapter` 65, `ensure_maia3` 237), `services/stockfish_download.py`
  (`install_stockfish` 62), `services/app_settings.py` (`AppSettingsService` 76,
  `stockfish_status` 156). app.js comment records that the public flow runs
  engines in the browser; server install endpoints remain for a future admin
  mode (`PREPFORGE_SERVER_ENGINE_ENABLED`).
- **Views/serialization**: `services/workspace_view.py`
  `build_workspace_payload` 74; `services/training_view.py`
  `prompt_to_json` 25, `smart_prompt_to_json` 62;
  `services/dashboard_recommendations.py` `build_recommendations` 36.

### 1.4 DB access layer

- `storage/database.py`: `connect_database` (22; enables FK pragma on SQLite),
  `apply_schema` (47), `initialize_database` (60).
- `storage/sa_tables.py`: SQLAlchemy Core `Table` objects —
  `games` 36 (owner_user_id 51, lichess_id 49), `positions` 58 (fen unique),
  `engine_evaluations` 65 (UniqueConstraint(engine,depth,nodes,time_ms) 81),
  `moves` 84 (PK game_id+ply, eval FKs), `analysis_results` 101,
  `repertoires` 118 (owner_user_id 122, visibility/team fields),
  `opening_nodes` 146, `training_sessions` 177, `training_progress` 204
  (UniqueConstraint uq_training_progress_owner 229),
  `engine_settings` 236, `app_settings` 250.
- `storage/repositories.py` `PrepForgeRepository` (105): `_upsert` (85) is
  dual-dialect (SQLite `INSERT OR REPLACE`-style vs Postgres `ON CONFLICT`);
  key write methods inventoried in §4. `storage/codec.py`: `canonicalize_fen` 37,
  `move_signature` 238 (dedupe key), `replay_uci`/`rebuild_moves` 193/204,
  `hydrate_opening_tree` 314, `export_pgn` 267.
- ORM identity/team tables (`api/models.py`): `User` 58 (plan 66-ish field),
  `LinkedAccount` 84 (encrypted token, is_primary), `Team` 111, `TeamMember` 134,
  `TeamInvite` 153 (code hash), `UserSetting` 183, `TrainAttemptReceipt` 204
  (exactly-once receipts), `StripeEvent` 222 (webhook idempotency), `AuthSession` 236.

### 1.5 Transaction strategy / Postgres-specific paths

- Repository methods that take a `Connection` (`write_training_progress` 1274,
  `write_training_session` 1182, `write_user_setting` 143) run inside a caller-
  managed transaction; their `lock_*` counterparts (`lock_user_setting` 162,
  `lock_training_session` 1234, `lock_training_progress` 1311) perform
  SELECT-FOR-UPDATE style locking before mutation (Postgres row locks; SQLite
  serializes at the file level).
- `record_attempt_receipt` (264) uses `ON CONFLICT DO NOTHING` on
  `TrainAttemptReceipt` — the idempotency token for smart-training syncs.
- Postgres-specific regression tests exist for concurrency and SQL behaviour:
  `tests/test_training_smart.py::test_postgres_concurrent_attempt_receipt` (566),
  `::test_postgres_interleaved_attempts_never_lose_an_update` (679),
  `::test_postgres_concurrent_sync_different_uuids_do_not_lose_updates` (774),
  `::test_postgres_interleaved_session_updates_never_lose_one` (890),
  `::test_postgres_concurrent_sync_session_state_keeps_every_update` (984),
  `tests/test_lichess_departure_misses.py::test_postgres_concurrent_record_departure_misses_count_once` (256),
  `tests/test_build_sql_counts.py::test_list_repertoires_statement_count_postgres` (119),
  `tests/test_build_route_sql.py::test_build_route_sql_counts_postgres` (117),
  `tests/test_repositories.py::test_list_repertoires_postgres` (617),
  `tests/test_api_db_config.py` (FK-on-for-concurrent-connections 30,
  psycopg pinning 77), `tests/test_migration_lichess_primary.py::
  test_upgrade_backfills_is_primary_true_postgres` (148).

### 1.6 External services

| Service | Client code | Used by |
|---|---|---|
| Lichess OAuth | `services/lichess_oauth.py` | `routers/lichess.py` login/callback (token stored encrypted on `LinkedAccount`) |
| Lichess public API | `services/lichess_fetch.py` (PGN export, NDJSON games, explorer) | compare/latest/mark_seen, explorer_proxy (in-memory 24h/500-entry cache per code path), Scout enrichment |
| Google OAuth | `services/google_oauth.py` | `routers/google_auth.py` |
| Stripe | `routers/billing.py` (`_stripe` 40) | checkout/portal/webhook (webhook idempotent via `StripeEvent`) |
| Stockfish/Maia artifacts | `services/stockfish_download.py`, `services/maia.py` | server engine install paths (admin mode) |

## 2. Domain map

### 2.1 users/auth
- **Files**: `routers/auth.py`, `routers/google_auth.py`, `api/security.py`,
  `api/models.py` (User 58, AuthSession 236, LinkedAccount 84).
- **Tables**: ORM `users`, `auth_sessions`, `linked_accounts`.
- **Read entrypoints**: `me` (auth.py:175), `current_user_optional` (deps.py:21).
- **Write entrypoints**: `register` 103 / `login` 128 / `logout` 158
  (`_open_session` 90, `_close_session` 147, `_purge_expired` 64).
- **Invariants in code/tests**: passwords hashed (`security.hash_password` 48);
  session tokens stored hashed (`hash_session_token` 76); session count capped
  (`_enforce_session_cap` 74); Google link (`google_auth.callback` 73) attaches a
  user identity via `services/google_oauth.py`.

### 2.2 repertoires
- **Files**: `routers/workspace.py`, `services/opening_builder.py`,
  `services/workspace_view.py`, `storage/repositories.py`.
- **Tables**: `repertoires` (sa_tables.py:118).
- **Read entrypoints**: `list_repertoires` 238, `build_load` 286,
  `dashboard` 108 (health via `services/progress.py::compute_health` 171),
  `shared_repertoire` 521 (token-based).
- **Write entrypoints**: `create_repertoire` 442, `build_rename` 612,
  `delete_repertoire` 345, `set_repertoire_active` 362, `import_repertoire` 982,
  `import_repertoire_pgn` 1021 (via `PgnImportService`), `fork_repertoire` 576,
  `fork_shared_repertoire` 550 (`_reassign_ids` 412 → fresh node ids),
  `share_repertoire` 314 / `create_share_link` 508 (`_share_signature`/
  `mint_share_token`/`parse_share_token` 474/483/488 — HMAC over repertoire id).
- **Invariants**: `_owned_repertoire` (66) 404/403s non-owner mutations;
  `_readable_repertoire` (75) admits owner + team-shared + share-token reads;
  `_strip_readonly_build_payload` (91) removes mutating fields from read-only
  payloads; `_enforce_repertoire_quota` (46) caps creation; delete-nodes is
  idempotent per node id (`tests/test_api_build_actions.py::
  test_delete_nodes_is_idempotent_per_id:204`).

### 2.3 repertoire nodes/moves (opening tree)
- **Files**: `routers/workspace.py` (build_*), `services/opening_generation.py`,
  `storage/repositories.py`, `storage/codec.py`.
- **Tables**: `opening_nodes` (sa_tables.py:146).
- **Read**: `build_load` 286 → `workspace_view.build_workspace_payload` 74.
- **Write**: `build_add_move` 633 / `build_add_moves` 698 →
  `update_opening_nodes` (repositories 744) / `save_changed_nodes` 765;
  `build_delete_nodes` 740 → `delete_opening_nodes` 1159;
  `build_apply_plan` 784 (generation plan from
  `opening_generation.generate_from_position` 179); `build_action` 841
  (enable/disable/mark-prepared); `build_annotations` 898.
- **Invariants**: parent-ref resolution `_load_node_or_400` (396); tmp→real id
  mapping returned as `id_map` (frontend local-first sync);
  `hydrate_opening_tree` (codec 314) rebuilds the tree from rows.

### 2.4 training progress (SRS per node)
- **Files**: `services/training_smart.py`, `services/progress.py`,
  `storage/repositories.py`.
- **Tables**: `training_progress` (sa_tables.py:204, unique
  uq_training_progress_owner (owner_user_id, repertoire_id, node_id) line 229);
  receipts in ORM `train_attempt_receipts` (api/models.py:204).
- **Read**: `load_training_progress` (repositories 1356),
  `list_training_progress` 1400, `due_node_ids`/`mastery_map` (progress 97/81).
- **Write**: `write_training_progress` 1274 (caller-transaction) /
  `lock_training_progress` 1311 (locked read-modify-write);
  `record_attempt_receipt` 264 (ON CONFLICT DO NOTHING).
- **Invariants**: exactly-once attempt application keyed by `attempt_uuid`
  (`SmartTrainingService.sync_progress` 624-837; concurrency asserted by
  `test_postgres_concurrent_attempt_receipt` and the four interleaved-update
  tests in `tests/test_training_smart.py`);
  `submit_move` (838-928) writes spaced-repetition state only when `attempt==1`
  (`update_spaced_repetition` in services/training.py:507);
  `_requeue_card` (929) re-queues with a gap (`REQUEUE_GAP`).

### 2.5 training sessions
- **Files**: `routers/train.py`, `services/training.py`, `services/training_smart.py`,
  `services/scheduler.py`.
- **Tables**: `training_sessions` (sa_tables.py:177).
- **Read**: `_owned_session` (train.py:55), `load_training_session` 1210,
  `load_latest_training_session` 1217.
- **Write**: `save_training_session`/`write_training_session` 1178/1182,
  `lock_training_session` 1234; `smart_sync` (train.py:425) persists
  `card_index`/`queue` + attempts in one call.
- **Invariants**: session updates never lose one under concurrency
  (`test_postgres_interleaved_session_updates_never_lose_one`,
  `test_postgres_concurrent_sync_session_state_keeps_every_update`); queue cards
  are encoded/validated (`scheduler.encode_card`/`decode_card` 92/100).

### 2.6 games / import / dedupe
- **Files**: `services/pgn_import.py`, `services/lichess_fetch.py`,
  `storage/repositories.py`, `storage/codec.py`, `routers/analyze.py`.
- **Tables**: `games` (36), `moves` (84), `positions` (58).
- **Read**: `load_game` 614, `find_game_id_by_lichess_id` 674, `list_games` 695.
- **Write**: `save_game`/`save_game_batched` 284/569; import entrypoints
  `import_repertoire_pgn` (workspace 1021), analyze's
  `_import_pgn_for_analysis` (analyze.py:48).
- **Invariants**: dual dedupe — by `lichess_id` and by `move_signature`
  (codec 238; `existing_move_signature_ids` repositories 1372);
  ownership claimed on first save and verified thereafter via
  `claim_or_verify_game` (1140) — asserted in `tests/test_api_analyze.py`
  (`test_analyses_isolated_between_users`) and `tests/test_pgn_import.py`.

### 2.7 departure / miss processing
- **Files**: `services/lichess_fetch.py` (`record_departure_misses` 551-615),
  `services/repertoire_matching.py`, `routers/lichess.py` (`_run_compare` 408),
  `routers/train.py` (`record_miss` 130).
- **Tables**: `training_progress` (miss entries), `games` (compared games).
- **Read**: `match_game_against_repertoires` (matching 134),
  `select_deepest_match` 125, `_departure_result` 32.
- **Write**: `record_departure_misses` — single transaction, per-game ingest
  marker `DEPARTURE_INGESTED_KEY`, cap 300; `train.record_miss` (130) for
  client-recorded coach misses.
- **Invariants**: miss counting is once-per-game under concurrency
  (`test_lichess_departure_misses.py::
  test_postgres_concurrent_record_departure_misses_count_once:256`; 5 tests in
  that file total).

### 2.8 Scout (backend inputs only)
- **Files**: `routers/lichess.py::explorer_proxy` (330),
  `services/lichess_fetch.py::fetch_explorer_json` (35), workspace read/write
  endpoints (prep write-back).
- **Tables**: none dedicated; Scout reads repertoires (`build_load`) and writes
  via `build_add_moves` when the user saves a line.
- **Invariants**: explorer proxy rate-limit passthrough
  (`ExplorerRateLimitedError` 31 → client-visible retry hint); the rest of Scout
  computation is browser-side (see frontend library).

### 2.9 Analyze
- **Files**: `routers/analyze.py`, `services/browser_compute.py`,
  `services/classification.py`, `services/brilliant.py`, `services/analysis_view.py`.
- **Tables**: `analysis_results` (101), `moves` classifications, `engine_evaluations` (65).
- **Read**: `list_analyses` 311, `recall_analysis` 320,
  `load_latest_analysis_result` (repositories 1491).
- **Write**: `analyze_classify_save` (206) → `classify_precomputed_game`
  (browser_compute 99) → `save_analysis_result` (repositories 1415);
  `analyze_prepare` (128) imports the PGN and returns server-known metadata
  (brilliant config via `_brilliant_analyzer_from_client` 66).
- **Invariants**: server-side compute is classification-only (evals arrive from
  the browser); analyses isolated per owner (asserted
  `test_analyses_isolated_between_users`); board helpers `board`/`board_move`
  (356/374) are stateless legality utilities.

### 2.10 Teams / sharing
- **Files**: `routers/teams.py`, `api/models.py` (Team 111, TeamMember 134,
  TeamInvite 153), `storage/repositories.py` (sharing methods).
- **Tables**: ORM `teams`, `team_members`, `team_invites`; `repertoires`
  visibility/team columns.
- **Read**: `list_teams` 160, `team_detail` 242,
  `list_team_shared_repertoires`/`list_repertoires_shared_to_team`
  (repositories 1053/1085), `user_team_ids` (teams.py:55).
- **Write**: `create_team` 143, `update_team` 504, `delete_team` 523
  (→ `unshare_all_for_team` 1109), `add_member` 330, `remove_member` 375,
  `update_member_role` 406, `create_invite` 438 / `revoke_invite` 470,
  `join_team` 206; repertoire sharing `share_repertoire` (workspace 314) →
  `set_repertoire_sharing` (repositories 1041).
- **Invariants**: role gates `_require_member`/`_require_manager` (72/80;
  `_MANAGER_ROLES` = owner/admin); invite code stored hashed
  (`_hash_invite_code` 110; raw URL returned only at mint);
  join is idempotent (`test_api_teams.py::test_join_is_idempotent:314`);
  members are identified by linked Lichess username (`add_member` body).

### 2.11 Settings / preferences
- **Files**: `routers/settings.py`, `services/app_settings.py`,
  `storage/repositories.py` (user settings), `api/models.py` (UserSetting 183).
- **Tables**: ORM `user_settings` (+ `app_settings`/`engine_settings` Core
  tables for engine prefs).
- **Read**: `get_settings` (settings.py:58) → `_settings_payload` 43
  (server_engine_enabled flag, maia_rating, stockfish_depth);
  `owner_maia_rating`/`owner_stockfish_depth` (app_settings 51/59).
- **Write**: `update_settings` (77) → `mutate_user_setting` (repositories 196)
  under `lock_user_setting` (162).
- **Invariants**: values clamped (`clamp_stockfish_depth` 31,
  `clamp_maia_rating` 42); streak state (`services/streak.py::advance` 55)
  idempotent within a day (asserted `tests/test_streak.py:50` and
  `tests/test_api_train.py::test_streak_is_idempotent_within_a_day_and_extends_next_day:593`).

---

## 3. Identity / ownership map

Identity sources: (a) **session cookie** → `AuthSession.token_hash` → `User`
(`current_user_optional`, deps.py:21); `current_owner` = `user.id` string used as
`owner_user_id`. (b) **Linked Lichess accounts** (`linked_accounts` rows,
encrypted OAuth token, `is_primary`) — external player identity for
import/compare. (c) **Team membership** (`team_members.role`). (d) **Share
tokens** (HMAC over repertoire id, `workspace.py:474-500`).

| Write path | Auth identity | Target owner | External identity | Team context | Permission check location |
|---|---|---|---|---|---|
| build_add_moves / build_delete_nodes / build_action / build_annotations | session user | repertoire.owner_user_id | — | read-only if shared to a team | `_owned_repertoire` (workspace.py:66) before any mutation |
| build_rename / delete_repertoire / set_repertoire_active | session user | repertoire.owner_user_id | — | — | `_owned_repertoire` |
| create_repertoire / import_* / fork_repertoire | session user | new row owner = caller | — | — | `_enforce_repertoire_quota` (46) |
| fork_shared_repertoire / shared_repertoire (token) | none required (token is the credential) | new row owner = caller (fork) | — | or share-token holder | `parse_share_token` (488) verifies HMAC; read payload stripped (91) |
| share_repertoire | session user | repertoire.owner_user_id | — | target team_id must exist | `_owned_repertoire`; visibility set to team/private |
| smart_sync / smart_move / smart_start / start / move / skip / hint | session user | progress/session.owner_user_id | — | — | `_owned_session` (train.py:55); smart service `_owner_or_raise` (training_smart.py:970) |
| record_miss | session user | caller | game reference optional | — | body-scoped to caller |
| compare / compare_post / latest / mark_seen | session user | caller | `linked_accounts` usernames / explicit `usernames` in body | multiple account_ids | `_link_for_account` (lichess.py:301); writes (departure misses) keyed to caller's training_progress |
| explorer_proxy | session user | — | Lichess public DB (masters/lichess) | — | `_linked_token` (318) when an account token is available |
| unlink / set_primary | session user | caller's linked_accounts | account id | — | `_links_for` (72) scoped by user_id |
| team create/update/delete/member/invite | session user | team | `lichess_username` identifies the added member (must be a linked account) | `_require_manager`/`_require_member` (teams.py:80/72); delete owner-only | `_membership` (64) |
| join_team | session user | team | invite code (hashed lookup `_hash_invite_code` 110) | joins as member | `_live_invite` (114); idempotent |
| update_settings | session user | caller | — | — | `mutate_user_setting` scoped by user_id |
| analyze_prepare / analyze_classify_save | session user | game claimed to caller (`claim_or_verify_game`, repositories 1140) | optional Lichess fetch (`fetchMyLichessGame` flow) | — | claim-or-verify owner gate; analyses isolated per owner |
| stripe_webhook | none (signature) | `User` via Stripe customer id | Stripe customer | — | `_set_plan_by_customer` (billing.py:133); idempotent via `StripeEvent` |

Notes (facts): `add_member` resolves the target user through their linked
Lichess username; team-shared repertoires grant read access via
`_readable_repertoire` (workspace.py:75); the compare response embeds
`source_account` per game so multi-account compares stay attributable.

## 4. Persistent write map

| Operation | Function (caller) | Tables / fields | Transaction boundary | Lock / upsert / dedupe | Idempotency | Commit timing | Retry behavior |
|---|---|---|---|---|---|---|---|
| Smart training sync | `SmartTrainingService.sync_progress` 624-837 (`routers/train.py::smart_sync` 425; also `smart_move` 359) | `training_progress` (mastery/SRS fields), `training_sessions` (card_index, queue), `train_attempt_receipts` | one transaction per sync call; progress+session updated together | `lock_training_progress` 1311 / `lock_training_session` 1234; receipt insert `ON CONFLICT DO NOTHING` (264) | per-`attempt_uuid` exactly-once (receipt row) | end of request | frontend `train-sync.js` groups + retries with backoff; keepalive beacon on unload |
| Smart move (first attempt) | `submit_move` 838-928 | `training_progress` via `update_spaced_repetition` (training.py:507) only when `attempt==1`; `_requeue_card` 929 mutates session queue | same sync transaction | locked read-modify-write | attempt count dedupes | end of request | same client queue |
| Classic train move/skip/hint | `training.record_attempt` 474 (`routers/train.py::move` 537 / `skip` 468) | `training_progress`, `training_sessions` | per request | `lock_training_progress` | session-scoped | end of request | client-side only |
| Streak update | `streak.advance` 55 via `_touch_streak` (train.py:187) | `user_settings` streak state | within the training transaction | `mutate_user_setting` under `lock_user_setting` 162 | same-day advance is a no-op (tests: test_streak.py:50, test_api_train.py:593) | end of request | — |
| Departure misses | `record_departure_misses` (lichess_fetch.py:551-615; called from `_run_compare` 408) | `training_progress` miss entries | single transaction for the whole ingest | `DEPARTURE_INGESTED_KEY` marker per game; cap 300 | once per game (postgres count-once test:256) | end of compare request | compare re-runs skip ingested games |
| Game ingestion | `save_game_batched` (repositories 569; callers `PgnImportService`, compare fetch, `_import_pgn_for_analysis`) | `games`, `moves`, `positions`, `engine_evaluations` | one transaction per game batch | dedupe by `lichess_id` (674) + `move_signature` (codec 238 / `existing_move_signature_ids` 1372); `_ensure_position` (1603) reuses positions by fen | re-import of the same game is a no-op/refresh | end of request | — |
| Analysis save | `save_analysis_result` (repositories 1415; `analyze_classify_save` 206) | `analysis_results`, `moves.classification`, `engine_evaluations` | per request | `_analysis_result_id` derived (1721) | overwrite-by-derived-id | end of request | frontend re-runs the browser job |
| Repertoire node add | `build_add_moves` 698 → `update_opening_nodes` 744 | `opening_nodes` | per request (batch of moves) | upsert-style node update; tmp ids returned in `id_map` | delete idempotent per id (test_api_build_actions.py:204); add resolves `parentRef` | end of request; frontend flush queue retries (`flushBuildMoves`, `beaconFlushBuild`) | `reapplyPendingBuildNodes` on reconnect |
| Repertoire node delete | `build_delete_nodes` 740 → `delete_opening_nodes` 1159 | `opening_nodes` | per request | delete by id list | idempotent per id | end of request | same queue |
| Repertoire create/fork/import | `create_repertoire` 442 / `fork_repertoire` 576 / `import_repertoire*` 982/1021 → `save_repertoire` 703 | `repertoires`, `opening_nodes` | one transaction per repertoire | `_reassign_ids` (412) ensures fresh node ids | import dedupe by game signature (for game imports) | end of request | — |
| Sharing changes | `share_repertoire` 314 → `set_repertoire_sharing` 1041 | `repertoires.visibility/team_id` | per request | one-team-at-a-time semantics | repeat share/unshare idempotent | end of request | — |
| Team changes | `create_team`/`update_team`/`delete_team`/`add_member`/`remove_member`/`update_member_role`/`join_team`/`create_invite` | `teams`, `team_members`, `team_invites`; delete cascades via `unshare_all_for_team` 1109 | per request | invite code hash at rest (110) | join idempotent (test_api_teams.py:314) | end of request | — |
| Settings update | `update_settings` 77 → `mutate_user_setting` 196 | `user_settings` | per request (row-locked) | `lock_user_setting` 162 | repeat set is idempotent | end of request | — |
| Billing webhook | `_apply_event` (billing.py:141) | `stripe_events`, `users.plan` | per event | `StripeEvent` row | webhook idempotent (test_api_billing.py:170) | end of webhook | Stripe retries deliveries |
| Linked account changes | `lichess.callback` 176 / `unlink_one` 250 / `set_primary` 121 | `linked_accounts` (encrypted token, is_primary) | per request | `_demote_others` (99) keeps one primary | repeated link updates the row | end of request | — |

---

## 5. External-input call graphs

### 5.1 Lichess username / game path

```
input: {count, account_id|account_ids|usernames} (POST /api/lichess/compare)
  -> routers/lichess.py::compare_post (529) / compare GET (506)
  -> _run_compare (408)
     -> _link_for_account (301) / linked usernames
     -> services/lichess_fetch.py::compare_many_identities (479)
        -> fetch_recent_pgns (112)  [Lichess public PGN export]
        -> _split_multi_pgn (157) / _build_fetched_game (179)   [parse]
           (or fetch_latest_games_meta (192) + _parse_ndjson_games (237))
        -> _summarize_fetched (459)
           -> services/repertoire_matching.py::match_game_against_repertoires (134)
              -> match_game_to_repertoire (65) walk of repertoire tree
              -> select_deepest_match (125), _departure_result (32)
  -> services/lichess_fetch.py::record_departure_misses (551-615)   [persistent
     write: training_progress miss entries; single transaction;
     DEPARTURE_INGESTED_KEY marker; cap 300]
  -> response: {count, misses_recorded, sources[], games[...]} (per-game fields
     listed in frontend-library.md §2.4)

side path: GET /api/lichess/latest (544) -> fetch_latest_games_meta +
  newest_game_across (263) -> POST /api/lichess/seen (615, writes last-seen key)
side path: GET /api/lichess/explorer/{db} (330) -> fetch_explorer_json (35)
  [no persistent write; 24h/500-entry in-process cache; rate-limit error maps to
  ExplorerRateLimitedError (31)]
```

### 5.2 Training

```
queue/select: POST /api/train/smart/start (train.py:247)
  -> SmartTrainingService.start_or_resume_mixed (245) / start_or_resume (169)
     -> services/scheduler.py::build_session_plan (243) / mix_plans (431)
        (candidates from repertoire trees; encode_card (92) into session queue)
  -> smart_prompt_to_json (training_view 62) -> prompt card
attempt: POST /api/train/smart/sync (425) with attempts[] + card_index + queue
  -> SmartTrainingService.sync_progress (624-837)
     -> record_attempt_receipt (repositories 264)        [ON CONFLICT DO NOTHING]
     -> lock_training_progress (1311) -> write_training_progress (1274)
     -> lock_training_session (1234) -> write_training_session (1182)
  -> submit_move (838-928) on the live card:
     -> update_spaced_repetition (training.py:507) only when attempt==1
     -> _requeue_card (929) with REQUEUE_GAP on failure
  -> _touch_streak (train.py:187) -> streak.advance (55)  [idempotent/day]
classic variant: POST /api/train/start (81) /move (537) /skip (468) /hint (480)
  -> services/training.py::record_attempt (474) -> same progress/session writes
```

### 5.3 Shared repertoire

```
read (team share): GET /api/build/load (workspace.py:286)
  -> _readable_repertoire (75): owner OR team member OR share token
  -> _strip_readonly_build_payload (91)  [writable=false for non-owners]
read (link share): GET /api/shared/{token} (521) -> parse_share_token (488)
copy/fork: POST /api/repertoires/fork (576)  [team-shared copy]
        or POST /api/shared/{token}/fork (550)  [link-share fork]
  -> _reassign_ids (412)  [fresh repertoire + node ids]
  -> save_repertoire (repositories 703)
  -> resulting ownership: new row owner_user_id = caller; source unchanged
unshare: POST /api/repertoires/share with visibility=private (314)
team lifecycle: delete_team (523) -> unshare_all_for_team (repositories 1109)
```

## 6. API payload contracts (consumed surfaces)

Only endpoints the SPA (or other in-repo consumers) actually calls. Error shapes:
`api()` accepts both `{error}` and `{detail}`; auth failures 401, ownership
failures 403/404 (see per-router `_owned_*` guards), validation 422.

### 6.1 Workspace / repertoires
| Endpoint | Request | Response (used fields) | Permission semantics |
|---|---|---|---|
| GET `/api/dashboard?local_date=` | — | counters (games, repertoires, training_sessions, due_reviews, due_soon), streak{current,best,trained_today}, recap, recommendations[{id,title,detail,cta}] | per-user |
| GET `/api/repertoires` | — | `repertoires[]` (id, name, color, root_fen, notes, tags, is_active, team_id, visibility, health{mastery_pct,trainable,mastered,learning,due,weak,untrained}), `shared[]` | own + team-shared |
| GET `/api/build/load?repertoire_id=` | — | `repertoire_id, name, color, nodes[]` (id, parent_id, depth, san, uci, move_number, move_side, is_mainline, is_enabled, is_prepared, mastery, maia_probability), `selected_node_id, writable, shared, share_team_id, health, id_map, removed_node_ids, summary` | read-only payload stripped when not owner |
| POST `/api/build/add-moves` | `{repertoire_id, moves:[{tempId, parentRef, uci}]}` | `id_map`, `summary{added_nodes, updated_nodes, high_probability_unprepared}` | owner only (403/404 otherwise) |
| POST `/api/build/delete-nodes` | `{repertoire_id, node_ids[]}` | `removed_node_ids` | owner only; idempotent per id |
| POST `/api/build/annotations` / `/api/build/action` / `/api/build/rename` / `/api/build/export` | node/rename/export payloads | updated payload / exported PGN | owner only |
| POST `/api/build/generate/apply-plan` | plan from browser generation | summary | owner only |
| POST `/api/repertoires/create` (via create path), `/import`, `/import-pgn`, `/delete`, `/set-active`, `/share`, `/share-link`, `/fork` | per name | created/updated repertoire fields | owner only (share sets visibility=team/private) |
| GET `/api/shared/{token}` | — | read-only build payload | token = credential |

### 6.2 Train
| Endpoint | Request | Response (used fields) | Semantics |
|---|---|---|---|
| POST `/api/train/smart/start` | `{mixed, fresh}` | session bundle: cards[], counts, health, due_tomorrow, day_streak, session_id, repertoire_name, color | creates or resumes caller's session |
| POST `/api/train/smart/sync` | `{session_id, attempts:[{node_id, correct, attempt_uuid}], card_index, queue[], local_date}` | updated counts/summary | exactly-once per attempt_uuid; caller-owned session (`_owned_session`) |
| GET `/api/train/smart/summary` | — | summary + delta | caller-owned |
| POST `/api/train/smart/skip`, `/api/train/start`, `/move`, `/skip`, `/hint`, `/record-miss` | move/attempt payloads | next prompt / hint | caller-owned; record_miss body-scoped |

### 6.3 Games / Lichess
| Endpoint | Request | Response (used fields) | Semantics |
|---|---|---|---|
| POST `/api/lichess/compare` | `{count, account_id?, account_ids?, usernames?}` | `{count, misses_recorded, sources[], games[]}` — per game: lichess_id, white, black, result, user_color, in_repertoire, matched_plies, departure_ply, departure_move_uci, departure_reason, repertoire_id/name, move_san_history[], expected_move_uci/san, expected_node_id, last_matched_node_id, training_recorded, source_account | external usernames accepted; departure misses written under the caller |
| GET `/api/lichess/latest?light=1` / `/api/lichess/latest` | — | newest game meta | per linked identity |
| POST `/api/lichess/seen` | `{...}` | ok | stores last-seen marker |
| GET `/api/lichess` | — | `{accounts:[{id, username, is_primary}]}` | caller's links |
| POST `/api/lichess/primary`, DELETE `/api/lichess/{id}` | `{account_id}` | updated status | caller's links only |
| GET `/api/lichess/explorer/{masters|lichess}` | position params | explorer JSON | cached; rate-limit error surfaced |

### 6.4 Analyze / Teams / Settings / auth
| Endpoint | Request | Response (used fields) | Semantics |
|---|---|---|---|
| POST `/api/analyze/prepare` | `{pgn}` | `{game_id, engine, depth, positions[], moves[], brilliant{enabled, rating}}` | game claimed to caller |
| POST `/api/analyze/classify-save` | `{game_id, engine, depth, positions[{fen, …evals}], maia_assessments[]}` | saved summary | owner of game_id (`claim_or_verify_game`) |
| GET `/api/analyses`, `/api/analyses/{game_id}` | — | history list / one result | isolated per owner |
| GET/POST `/api/teams`, `/api/teams/{id}`, members, invite | team/member payloads | `{teams:[{id,name,role,member_count}]}`, detail `{name, role, members[], shared_repertoires[], invite{exists,expires_at}}`, invite `{url}` | manager gates; delete owner-only |
| GET/POST `/api/teams/join/{code}` | — | preview `{name, member_count, already_member}`; result `{joined, team}` | idempotent join |
| GET/POST `/api/settings` | `{stockfish_depth}` or `{maia_rating:'auto'\|number}` | `{stockfish_depth, maia_rating, server_engine_enabled}` | per-user |
| GET `/api/csrf` | — | token bootstrap | double-submit cookie |
| POST `/api/auth/register|login|logout`, GET `/api/auth/me`, GET `/api/auth/providers` | credentials | user + session cookie | session cap enforced |

---

## 7. Test coverage map

Only tests that exist in `tests/` at this commit. Columns: unit (pure service/
storage tests), integration (API via test client), postgres (tests that run
against a Postgres engine/dialect), e2e (Playwright `.mjs` driven by pytest),
concurrency regression (explicit multi-connection/interleaving tests).

| Flow | Unit | Integration (API) | Postgres | E2E | Concurrency regression |
|---|---|---|---|---|---|
| auth / sessions | — | `test_api_auth.py`, `test_api_google_auth.py` | — | — | session cap covered in test_api_auth.py |
| security headers / CSRF / static | — | `test_api_security.py`, `test_api_static.py`, `test_api_ops.py`, `test_deployment_contract.py` | — | — | — |
| repertoires CRUD / workspace | `test_opening_builder.py`, `test_storage_reload.py`, `test_storage_codec.py` | `test_api_workspace.py` | `test_repositories.py::test_list_repertoires_postgres` (617), `test_build_sql_counts.py::test_list_repertoires_statement_count_postgres` (119), `test_build_route_sql.py::test_build_route_sql_counts_postgres` (117) | — | — |
| build node ops | `test_opening_generation_v2.py` | `test_api_build_actions.py` (incl. `test_delete_nodes_is_idempotent_per_id` 204), `test_api_build_generate.py` | statement-count tests above | — | — |
| sharing / fork | `test_repertoire_export.py` | `test_api_workspace.py` (share/fork paths) | — | — | — |
| classic training | `test_training.py`, `test_progress.py`, `test_game_navigation.py` | `test_api_train.py` | — | `test_train_keyboard_smoke.py` + `train_keyboard_smoke.mjs` | — |
| smart training | `test_training_smart.py` (service), `test_scheduler.py` | `test_api_train.py` | `test_training_smart.py::test_postgres_concurrent_attempt_receipt` (566), `test_postgres_interleaved_attempts_never_lose_an_update` (679), `test_postgres_concurrent_sync_different_uuids_do_not_lose_updates` (774), `test_postgres_interleaved_session_updates_never_lose_one` (890), `test_postgres_concurrent_sync_session_state_keeps_every_update` (984) | — | same five postgres tests |
| streak | `test_streak.py` (idempotent-per-day 50) | `test_api_train.py::test_streak_is_idempotent_within_a_day_and_extends_next_day` (593) | — | — | — |
| games import / dedupe | `test_pgn_import.py`, `test_storage_codec.py` | `test_api_lichess_games.py` | — | — | — |
| departure / compare | `test_lichess_fetch.py`, `test_repertoire_matching.py` | `test_api_lichess.py`, `test_lichess_departure_misses.py` | `test_lichess_departure_misses.py::test_postgres_concurrent_record_departure_misses_count_once` (256) | — | same test |
| explorer / Scout boundary | `test_scout_production_boundary.py` | `test_api_lichess.py` (explorer proxy paths) | — | `test_scout_smoke.py` + `scout_smoke.mjs`, `test_scout_smoke.py::test_scout_refutation_smoke` + `scout_refutation_smoke.mjs` | — |
| analyze / classification | `test_analysis.py`, `test_analysis_report.py`, `test_analyze_classify_timing.py`, `test_classification*.py`, `test_brilliant.py` | `test_api_analyze.py` (incl. `test_analyses_isolated_between_users`) | — | `test_eval_chart_smoke.py` + `eval_chart_smoke.mjs` | — |
| teams / sharing | — | `test_api_teams.py` (incl. `test_join_is_idempotent` 314) | — | — | — |
| settings | `test_maia_adapter.py`, `test_device.py` | `test_api_settings.py` | — | — | — |
| billing | — | `test_api_billing.py` (incl. `test_webhook_is_idempotent` 170) | — | — | — |
| storage layer | `test_database.py`, `test_sa_tables.py`, `test_storage_datetime_persistence.py` | — | `test_api_db_config.py` (FK-on-for-concurrent-connections 30; psycopg pin 77), `test_postgres_backup.py` | — | FK concurrent-connections test |
| migrations | — | — | `test_migration_lichess_primary.py::test_upgrade_backfills_is_primary_true_postgres` (148) | — | — |
| a11y baseline | — | — | — | `test_axe_baseline.py` + `axe_baseline.mjs` | — |
| misc services | `test_chess_core.py`, `test_dashboard_recommendations.py`, `test_replay_maia.py`, `test_stockfish_engine.py`, `test_terminal_viewer.py` | — | — | — | — |

Notes (facts): e2e tests drive Playwright `.mjs` scripts through
`tests/e2e/e2e_harness.py`; `test_analyze_classify_timing.py` and
`test_classification_crosslang.py`/`test_classification_golden.py` pin
classification behaviour including cross-language golden values; the two
statement-count tests (`test_build_sql_counts.py`, `test_build_route_sql.py`)
assert SQL statement counts for build routes on Postgres.

---

*End of backend library. Machine-readable records: `backend-library.json`.*
