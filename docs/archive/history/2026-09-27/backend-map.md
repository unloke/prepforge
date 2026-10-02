# PrepForge Backend Map（客觀導航圖）

> 產生自 `origin/main`（2026-09-27，含 #84 audit round）。只描述現況，不含 bug 追蹤或改善建議。
> 目標：後續模型可依本索引直接開啟少數相關檔案，不需重掃整個 repo。
> 伴隨文件：[backend-flows.md](backend-flows.md)（端到端 flow）、`backend-map.json`（機器可讀索引）。

---

## 0. 總覽

- **語言／框架**：Python 3.13、FastAPI、SQLAlchemy（Core Table + 少量 ORM）、Alembic、python-chess。前端 SPA 在 `web-src/`（Vite），引擎（Stockfish WASM、Maia3 ONNX）跑在瀏覽器。
- **進入點**：`src/prepforge_chess/api/main.py` → `create_app()` 組裝 middleware（GZip → SecurityHeaders → CSRF → CORS）+ 11 個 router + `/healthz` + `/api/csrf` + `register_static`。
- **分層**：
  - `api/routers/*` — HTTP 面（驗證、ownership gate、payload 驗證）。
  - `services/*` — 領域邏輯（training、scheduler、matching、builder、export…）。
  - `storage/*` — 持久化（`repositories.PrepForgeRepository`、`sa_tables`、`codec`）。
  - `core/*` — 純資料模型（`core/models.py`）與 python-chess 包裝（`core/chess_core.py`）。
- **資料庫**：單一 SQLAlchemy engine（`api/db.py:get_engine`），dev/test 用 SQLite（WAL、每連線 `PRAGMA foreign_keys=ON`），prod 用 Postgres（pool 10/20）。ORM（identity）與 Core（domain）共用同一 engine。
- **Schema 權威**：Alembic（`migrations/`）是唯一的 production schema 生命週期；`storage/database.py` 只建一次性 SQLite（CLI/單元測試），不做 runtime `create_all` 修補。守門測試：`tests/test_sa_tables.py`。
- **身分／ownership**：`users.id` 是所有 SaaS/domain 資料的 canonical owner（`api/deps.py:current_owner`）。無 profile bridge；domain table 的 `owner_user_id` 直接存 `users.id`。Lichess 是 `linked_accounts`（非 identity）。

### 目錄速查

| 路徑 | 內容 |
| --- | --- |
| `src/prepforge_chess/api/` | FastAPI app、middleware、deps、ORM models、routers |
| `src/prepforge_chess/services/` | 領域服務（training、scheduler、matching、builder、lichess_fetch、export…） |
| `src/prepforge_chess/storage/` | `repositories.py`（1608 行，全部 SQL）、`sa_tables.py`（domain schema）、`codec.py`（緊湊編碼） |
| `src/prepforge_chess/core/` | `models.py`（dataclass 領域模型）、`chess_core.py`、`pgn.py` |
| `migrations/` | Alembic 版本（production schema 權威） |
| `tests/` | pytest（backend 單元/API 測試）；`tests/e2e/` 有 smoke（部分為 .mjs） |
| `web-src/` | SPA（含全部 `scout-*.js`、瀏覽器引擎）；其 `*.test.js` 由 vitest 跑 |
| `scripts/`、`research/` | 研究/基準腳本（scout-* 為研究用 .mjs）；**不屬於 product runtime** |

---

## 1. Training / Scheduler

### 主要檔案

| 檔案 | 角色 |
| --- | --- |
| `src/prepforge_chess/services/scheduler.py` | 純函式卡片排程（無 DB、無引擎）：tree + `TrainingProgress` → `SessionPlan` |
| `src/prepforge_chess/services/training_smart.py` | `SmartTrainingService`（Train v2，`TrainingMode.SMART` 卡片 session） |
| `src/prepforge_chess/services/training.py` | `TrainingService`（legacy 走線模式）+ 純函式 `record_attempt` / `update_spaced_repetition` |
| `src/prepforge_chess/services/progress.py` | 純函式：mastery 狀態、`compute_health`、`due_forecast`、`mastery_map` |
| `src/prepforge_chess/services/streak.py` | 純函式每日 streak（`user_settings` key `training_streak`） |
| `src/prepforge_chess/services/training_view.py` | prompt/line → JSON 序列化 |
| `src/prepforge_chess/api/routers/train.py` | `/api/train/*`（legacy + smart 兩套） |

### 入口 function / class

- `scheduler.build_session_plan(root, color, progress_by_id, ...)` → `SessionPlan`；`scheduler.mix_plans(...)`（mixed session 交錯排程）。卡片編碼：`encode_card` / `decode_card`（`kind:first:last` 或 `kind:repertoire_id:first:last`）。
- `SmartTrainingService.start_or_resume` / `start_or_resume_mixed` / `current_prompt` / `session_card_bundle` / `submit_move` / `skip_card` / `sync_progress` / `counts`。
- `TrainingService.start_or_resume_session` / `training_lines` / `current_prompt` / `submit_move` / `skip_current_line`。
- 共用純函式：`training.record_attempt`（mistakes/mastered 記帳 + SR）、`training.update_spaced_repetition`（SR 公式）、`streak.advance/resolve_day/as_view`、`progress.compute_health`。

### 核心 call chain

- 開課：`POST /api/train/smart/start` → `SmartTrainingService.start_or_resume[_mixed]` → `scheduler.build_session_plan`（讀 repertoire tree + `training_progress`）→ `save_training_session`（卡片存進 `training_sessions.line_order`）→ `current_prompt` + `session_card_bundle` →（router 附上 health/due bookend：`_smart_summary_payload`）。
- 答題（server 端）：`POST /api/train/smart/move` → `SmartTrainingService.submit_move` → `training.record_attempt` → `repository.save_training_progress` + `save_training_session`；僅 `attempt == 1` 寫 SR。
- 答題（local-first flush）：`POST /api/train/smart/sync` → `SmartTrainingService.sync_progress` → 每個 attempt 走 `repository.record_attempt_receipt`（同交易內寫 receipt + `training_progress` + `training_sessions`）。
- Legacy：`POST /api/train/start|move|skip|hint|record-miss` → `TrainingService`（python-chess 只做合法性）。
- streak：graded endpoint 內 `train._touch_streak` → `repository.mutate_user_setting(owner, "training_streak", ...)`（原子 read-modify-write）。

### 讀寫 state / tables

| 表／state | 讀 | 寫 |
| --- | --- | --- |
| `training_sessions` | ✓（resume、`_owned_session`） | ✓（`save_training_session`；`line_order_json` 存編碼卡片） |
| `training_progress` | ✓（SR 排程、health） | ✓（`save_training_progress`） |
| `train_attempt_receipts` | ✓（idempotency 檢查） | ✓（`record_attempt_receipt`，同交易） |
| `repertoires` | ✓（tree、`is_active`） | ✓（`set_repertoire_health` — 快取 badge 更新） |
| `opening_nodes` | ✓（tree walk） | — |
| `user_settings` | ✓ | ✓（`training_streak`、（lichess）departure keys） |

### Cross-module dependencies

- `scheduler` → `progress.node_mastery`（weak/due/new 判定）。
- `training_smart` → `scheduler`（decode/encode card）、`training.record_attempt/update_spaced_repetition`、`repositories`（含直接引用 repo 私有 helper `_upsert`/`_json_dump`… 做同交易寫入）。
- `routers/train.py` → `workspace._owned_repertoire`（ownership gate 與 workspace 共用）、`progress.compute_health/due_forecast`、`streak`、`training_view`。
- `lichess_fetch.record_departure_misses` → `training.update_spaced_repetition`（play→train loop，見 §2/§4）。

### API routes（prefix `/api/train`）

| Method | Path | Handler | 備註 |
| --- | --- | --- | --- |
| POST | `/start` | `start` | legacy 開課 |
| POST | `/move` | `move` | legacy 答題 |
| POST | `/skip`、`/hint`、`/record-miss` | `skip`/`hint`/`record_miss` | legacy |
| POST | `/smart/start` | `smart_start` | `mixed=true` 時跨 repertoire |
| GET | `/smart/summary` | `smart_summary` | session 結束 bookend + 權威 `day_streak` |
| POST | `/smart/move` | `smart_move` | server 端單步 |
| POST | `/smart/sync` | `smart_sync` | local-first 批次 flush（exactly-once） |
| POST | `/smart/skip` | `smart_skip` | 跳卡 |

### 對應 tests

- `tests/test_scheduler.py`（純排程規劃）、`tests/test_training_smart.py`（卡片 session 契約）、`tests/test_training.py`（legacy + SR）、`tests/test_api_train.py`（endpoint 面）、`tests/test_streak.py`、`tests/test_progress.py`、`tests/e2e/test_train_keyboard_smoke.py`。

### 重要 invariants / contracts

- **Grading contract（Train v2）**：client 回報 `attempt` 編號，server 只對 `attempt == 1` 寫 SR 進度——重試與 reveal 後照抄不計入正確率。第二次答錯的卡在同 session 內重排（requeue），取代 legacy 的 session 尾 recovery round。
- **Exactly-once sync**：`(session_id, attempt_uuid)` 唯一；同 payload 重試 = no-op，同 UUID 不同 `(node_id, correct)` = `ValueError`（409 級）。receipt 插入 + SR + session 更新在同一交易，streak 只對新 attempt 前進。批次上限 `MAX_SYNC_ATTEMPTS = 500`、`MAX_SYNC_QUEUE = 500`；queue 中格式錯誤的卡直接丟棄不落地。
- **SR 公式**（`update_spaced_repetition`）：對 → `score = min(10, score+1)`、`due_at = now + round(score) days`；錯 → `score *= 0.5`、`due_at = now + 10 min`；`is_mastered = score ≥ 7.0 且 correct_attempts ≥ 3`。
- **卡片編碼不改 schema**：卡片存於既有 `training_sessions.line_order`；root→last_target 路徑在 tree 中唯一，故 `first:last`（+ optional repertoire_id）足以重建 run-in、中間 prompts 與對手回應。`decode_card` 同時接受單/多 repertoire 兩種編碼（legacy session 相容）。
- **Scheduler 常數**：`DEFAULT_SESSION_SIZE=12`、`DEFAULT_NEW_CAP=4`、`DEFAULT_MAX_TARGETS_PER_CARD=3`、`WEAK_SHARE=0.6`（weak 最多佔 60%，其餘 due→new→polish 補滿）、`RUN_IN_PLIES=3`。
- **Prompt 自帶答案**：`SmartPrompt` 刻意包含 expected move 與 hint 文字（自家 repertoire、非測驗），client 因此可離線跑 retry/teach 流程。
- **Streak 日期**：client 送本地日期，server 只做 ±1 天 skew clamp（壞時鐘不能造/毀 streak）；read→advance→write 是 row-locked 原子 mutation（與 dashboard recap snapshot 併發不失效）。
- **Session 歸屬**：`training_sessions` 無 owner column——ownership 經 repertoire 閘（`_owned_session` 解 session → repertoire → owner）。

---

## 2. Repertoire matching

### 主要檔案

| 檔案 | 角色 |
| --- | --- |
| `src/prepforge_chess/services/repertoire_matching.py` | 純函式 matcher（98 行）：game moves × repertoire tree |
| `src/prepforge_chess/services/lichess_fetch.py` | 抓 Lichess 公開 PGN + 呼叫 matcher + 匯總 `GameMatchSummary` |
| `src/prepforge_chess/api/routers/lichess.py` | `/api/lichess/compare|latest`（呼叫方） |

### 入口 function / class

- `match_game_to_repertoire(moves, repertoire, user_color)` → `RepertoireMatchResult`。
- `match_game_against_repertoires(moves, repertoires, user_color)`（先過濾 `rep.color == user_color`）。
- `select_deepest_match`（按 `matched_plies` 最深勝出）。
- 消費端：`lichess_fetch.compare_recent_games` / `compare_many_identities` / `_summarize_fetched` / `_build_summary` / `record_departure_misses`。

### 核心 call chain

`GET|POST /api/lichess/compare` → `_run_compare`（router）→ `lichess_fetch.fetch_recent_pgns`（公開 API）→ `ChessCore.import_pgn_games` → `match_game_against_repertoires`（walk tree，僅 enabled 子節點）→ `_build_summary`（含 `expected_node_id`）→ `record_departure_misses`（回饋到 `training_progress`）→ JSON（每局帶 `source_account`）。

### 讀寫 state / tables

- 讀：`repertoires` + `opening_nodes`（`repository.list_repertoires(owner_user_id=...)`，僅 `is_active`）。
- 寫（僅 departure 分支）：`training_progress`（`save_training_progress`，錯題 + 立即到期）、`user_settings` key `lichess.departure_misses_ingested`（已匯入 id 清單，cap 300）。

### Cross-module dependencies

- `repertoire_matching` 只依賴 `core/models`（純函式、無 DB）。
- `lichess_fetch` → `repertoire_matching`、`training.update_spaced_repetition`、`repositories`。
- `routers/lichess.py` → `lichess_fetch`（見 §4）。

### API routes

- `/api/lichess/compare`（GET/POST）— 見 §4 表。

### 對應 tests

- `tests/test_repertoire_matching.py`、`tests/test_lichess_fetch.py`、`tests/test_api_lichess_games.py`（network mocked）。

### 重要 invariants / contracts

- **Departure 語意**：`departure_reason` ∈ `user_left_preparation`（輪到使用者且無匹配子節點）/ `opponent_unprepared_branch`（輪到對手）/ `game_stayed_in_preparation` / `no_repertoire_for_color`。
- **只有 `user_left_preparation` 會記成 recall miss**（對手新招不算 miss）；`expected_node_id` 指向「該下卻沒下」的 repertoire 節點，miss 以 `due_at = last_reviewed_at` 落地（下一個 session 就出現）。
- **Idempotent per game**：`lichess.departure_misses_ingested` 記錄已處理的 lichess game id（cap 300），重跑 compare 不重複計數；有記錄的 summary 設 `training_recorded=True`。
- **匹配只走 enabled 子節點**；expected child 選法：第一個 `is_mainline`，否則第一個 enabled child。
- **Owner-scoped**：只跟該 owner 的 repertoires 比對（`list_repertoires(owner_user_id=...)`）。

---

## 3. Opening tree / persistence（Build）

### 主要檔案

| 檔案 | 角色 |
| --- | --- |
| `src/prepforge_chess/services/opening_builder.py` | `OpeningBuilderService`（1381 行）：tree mutation + tree report；Maia-free（含 CLI 用 `generate_from_node`） |
| `src/prepforge_chess/services/opening_generation.py` | 純生成邏輯（`generate_from_position`、threshold、`GeneratedNodeChange`）與 Engine/Maia/ChessCore Protocol |
| `src/prepforge_chess/services/workspace_view.py` | `build_workspace_payload`：tree → Build 視圖 JSON（mastery + health 快取刷新） |
| `src/prepforge_chess/services/repertoire_export.py` | `RepertoireExportService`：package JSON / tree PGN 匯出匯入 |
| `src/prepforge_chess/api/routers/workspace.py` | `/api/repertoires/*`、`/api/build/*`（1034 行） |
| `src/prepforge_chess/storage/repositories.py` | `save_repertoire`、`update_opening_nodes`、`save_changed_nodes`、`delete_opening_nodes`、`_save_opening_node` |
| `src/prepforge_chess/storage/sa_tables.py` | `repertoires`、`opening_nodes` schema |

### 入口 function / class

- `OpeningBuilderService`：`create_repertoire`、`add_move`、`add_moves_batch`（local-first flush）、`apply_generation_plan`、`set_as_mainline`、`mark_prepared`、`disable_branch`/`enable_branch`、`add_comment`/`add_tag`/`set_annotations`、`delete_node`/`delete_nodes_batch`、`rename_repertoire`、`set_repertoire_active`、`remove_repertoire`、`tree_report`。（`generate_from_node` 僅 CLI `cli.py` 與測試呼叫。）
- `workspace_view.build_workspace_payload`（每個 Build mutation 的回應都經過它）。
- `RepertoireExportService`：`export_package_json`、`export_mainline_pgn`、`export_node_path_pgn`、`import_package_json`、`import_tree_pgn`。

### 核心 call chain

- 單步加手：`POST /api/build/add-move` → `_owned_repertoire` → `OpeningBuilderService.add_move`（算 `is_prepared`/`is_mainline` flags）→ `save_changed_nodes`/`update_opening_nodes` → `build_workspace_payload`。
- 批次加手（local-first flush）：`POST /api/build/add-moves` → `add_moves_batch`（all-or-nothing，回傳 `id_map` tempId→real id）→ `build_workspace_payload`。
- Build-Generate：**生成 recursion 在瀏覽器跑完**（Stockfish + Maia3），瀏覽器組 plan → `POST /api/build/generate/apply-plan` → `apply_generation_plan`（server 只重新驗證合法性/parentage、重算持久化 flags、落地）→ `build_workspace_payload`。
- Node 操作：`POST /api/build/action` → 依 `action` 分派到 builder 各方法 → `build_workspace_payload`。
- 匯出：`POST /api/build/export` / `GET /api/repertoires/export-pgn` → `RepertoireExportService`（純序列化）。
- 匯入：`POST /api/repertoires/import|import-pgn` → `RepertoireExportService.import_*` →（package 走）`_reassign_ids`（全新 id）→ `repository.save_repertoire(owner_user_id=owner)` → `build_workspace_payload`。

### 讀寫 state / tables

| 表 | 讀 | 寫 |
| --- | --- | --- |
| `repertoires` | ✓（`load_repertoire`、quota `count_repertoires`） | ✓（create/fork/import、rename、set-active、sharing、`health_json`） |
| `opening_nodes` | ✓（tree walk、`_repertoire_from_rows`） | ✓（`update_opening_nodes`、`save_changed_nodes`、`_save_opening_node`、`delete_opening_nodes`） |
| `engine_evaluations` | ✓（node 掛 eval） | ✓（經 `_save_engine_evaluation`，apply-plan 帶入 browser 計算的 eval） |
| `positions` | ✓ | ✓（`_ensure_position`，full-FEN 唯一 catalog） |
| `training_progress` | ✓（mastery overlay） | —（build 不寫） |
| `training_sessions` | — | ✓（間接：`delete_opening_nodes` 先清 `current_node_id` 參照） |

### Cross-module dependencies

- `opening_builder` → `opening_generation`（常數/協定/merge 邏輯）、`services/engine`（`EngineAdapter`/`MockEngine`）、`services/maia`（`MaiaAdapter`，僅 CLI 生成路徑）、`core/chess_core`、`repositories`。
- `workspace_view` → `opening_builder.tree_report`（純走訪）、`progress.mastery_map/compute_health`。
- `routers/workspace.py` → `workspace_view`、`opening_builder`、`repertoire_export`、`api/config.Settings`（quota：`free_repertoire_limit`）、`routers.teams.user_team_ids`（team 共享讀取）、`dashboard_recommendations`（`/dashboard`）。
- `routers/train.py` 與 workspace 共用 `_owned_repertoire` / `_readable_repertoire`。

### API routes（prefix `/api`）

| Method | Path | 備註 |
| --- | --- | --- |
| GET | `/build/load` | Build 視圖 payload |
| POST | `/build/add-move` | 單步手動 |
| POST | `/build/add-moves` | local-first 批次（rate limit 30/min，≤500 筆） |
| POST | `/build/delete-nodes` | 批次刪子樹（rate limit 30/min，≤200 筆） |
| POST | `/build/generate/apply-plan` | browser 生成 plan（rate limit 10/min） |
| POST | `/build/action` | node action（set_mainline/mark_prepared/disable_branch/delete/add_comment/add_tag/add_training_queue/mark_critical） |
| POST | `/build/annotations` | arrows/circles（rate limit 60/min，每類 ≤64） |
| POST | `/build/rename` | 改 repertoire 名 |
| POST | `/build/export` | json package / pgn |
| GET | `/repertoires` | dashboard 列表（metadata + `health_json` 快取 badge） |
| POST | `/repertoires/create`、`/repertoires/fork`、`/repertoires/delete`、`/repertoires/set-active` | 生命週期 |
| POST | `/repertoires/share`、`/repertoires/share-link` | team 共享 / 分享連結（HMAC token） |
| GET | `/shared/{token}`、POST `/shared/{token}/fork` | 只讀分享（`_strip_readonly_build_payload`） |
| GET | `/repertoires/export-pgn` | PGN 下載 |
| POST | `/repertoires/import`、`/repertoires/import-pgn` | package / tree PGN 匯入 |
| GET | `/dashboard` | 計數器 + streak + recap + recommendations |

### 對應 tests

- `tests/test_opening_builder.py`、`tests/test_opening_generation_v2.py`、`tests/test_repertoire_export.py`、`tests/test_api_workspace.py`、`tests/test_api_build_actions.py`、`tests/test_api_build_generate.py`、`tests/test_build_route_sql.py`（SQL 次數）、`tests/test_build_sql_counts.py`、`tests/test_dashboard_recommendations.py`。

### 重要 invariants / contracts

- **Server 在 Build mutation 路徑零引擎運算**：eval 由 browser 計算後隨 plan/節點帶入（White-POV `EngineEvaluation`）；server 只驗證、重算 flags、持久化。`generate_from_node`（server 端 Maia/引擎生成）僅存在於 CLI 路徑。
- **Untrusted plan 防護**：plan 只能帶 `GENERATED_STOCKFISH`/`GENERATED_MAIA3` 來源（`_PLAN_GENERATED_SOURCES`），不能偽造 MANUAL/IMPORTED_PGN authorship；上限 `MAX_PLAN_CHANGES=2000`、`MAX_PLAN_DEPTH=64`、`MAX_PLAN_PV_LENGTH=64`；批次 `MAX_ADD_MOVES_BATCH=500`、`MAX_DELETE_NODES_BATCH=200`、`MAX_BULK_MOVES=500`、`MAX_BULK_DELETE_NODES=200`。
- **持久化分類**：own-move（輪到 repertoire.color）= `is_user_prepared_move`；每個 parent 的第一個 enabled child = `is_mainline`（`_promote_opponent_mainline` 等保持此不變）。
- **Tree 持久化模型**：`opening_nodes` 存到達 UCI + parent，FEN 由 `root_fen` 走樹重建（`sa_tables` docstring）；`update_opening_nodes` 只寫 diff（`_changed_nodes` snapshot 比對）。
- **匯入去識別化**：package 匯入一律 `_reassign_ids`（全新 node/repertoire id）→ 匯入者自己的一份，不跨租戶覆寫；`_enforce_repertoire_quota` 對所有產生 repertoire 的 route 一致（Free plan 上限 `settings.free_repertoire_limit`，超標 402）。
- **唯讀分享不漏個資**：`_strip_readonly_build_payload` 移除 `health`/`summary`/每節點 `mastery`（share link / team read view 不得外洩 owner 訓練資料）。
- **Package contract**：`PACKAGE_KIND = "prepforge_repertoire_package"`、`PACKAGE_SCHEMA_VERSION = 1`；id/tag/name/comment 皆有 pattern/長度驗證（`_ID_PATTERN`、`_TAG_PATTERN`、`_NAME_MAX=200`、`_COMMENT_MAX=2000`）。
- **Delete 的 FK 安全**：`delete_opening_nodes` 先把 `training_sessions.current_node_id` 指到被刪節點者清成 NULL，再刪節點（避免 FK 違規）。
- **每 Build mutation 回傳全量 Build payload**（`build_workspace_payload`），順便刷新 `health_json` 快取（見 §6）。

---

## 4. Games attribution（對局歸屬）

「Games attribution」= 一局棋如何歸屬到 owner／linked account／source，以及去重與認領規則。

### 主要檔案

| 檔案 | 角色 |
| --- | --- |
| `src/prepforge_chess/services/pgn_import.py` | `PgnImportService.import_text`：paste PGN / Lichess 導入的正規化 + owner-scoped 去重 |
| `src/prepforge_chess/storage/repositories.py` | `save_game`/`save_game_batched`/`load_game`/`list_games`/`find_game_id_by_lichess_id`/`claim_or_verify_game`/`claim_repertoire` |
| `src/prepforge_chess/api/routers/lichess.py` | linked accounts（`is_primary`）、compare/latest/seen（`source_account` 歸屬） |
| `src/prepforge_chess/services/lichess_fetch.py` | `determine_user_color`、`newest_game_across`、`compare_many_identities`（每局標 `source` username） |
| `src/prepforge_chess/api/models.py` | `LinkedAccount`（`provider`、`provider_user_id`、`is_primary`） |
| `src/prepforge_chess/api/routers/analyze.py` | 分析前 `claim_or_verify_game`（認領 unowned game） |

### 入口 function / class

- `PgnImportService.import_text(pgn_text, options, owner_user_id)` → `PgnImportResult`（imported/skipped/errors/warnings）。
- `PrepForgeRepository.claim_or_verify_game(game_id, owner_user_id) -> bool`（fill-NULL 認領 + 驗證）、`claim_repertoire`（同語意）。
- `find_game_id_by_lichess_id(lichess_id, owner_user_id)`（owner-scoped 去重查詢）。
- `lichess_fetch.determine_user_color(white, black, username)`、`newest_game_across(usernames, ...)`、`compare_many_identities`。
- `routers/lichess.set_primary`（`_demote_others`：單一 primary）、`latest`（`is_new` 對照 `lichess.last_seen_game_id`）、`mark_seen`。

### 核心 call chain

- Paste/導入：`POST /api/analyze/prepare`（`_import_pgn_for_analysis`）或 Lichess import → `PgnImportService.import_text` → 去重（lichess_id → move-signature）→ `repository.save_game(game, owner_user_id=owner)`。
- 認領：`POST /api/analyze/classify-save` → `repo.claim_or_verify_game(body.game_id, owner)` → False 則 404。
- Watcher：`GET /api/lichess/latest` → `_links_for`（primary 優先）→ `newest_game_across`（bounded concurrency、依完成時間取最新、game id 去重）→ 每局帶 `source_account`；`POST /api/lichess/seen` 記 `lichess.last_seen_game_id`。

### 讀寫 state / tables

| 表／state | 讀 | 寫 |
| --- | --- | --- |
| `games` | ✓ | ✓（upsert；`owner_user_id` 為 coalesce-fill、`lichess_id`、`source`） |
| `moves` / `positions` / `engine_evaluations` | ✓ | ✓（`save_game` 刪重建、`save_game_batched` 批次） |
| `linked_accounts` | ✓ | ✓（link/unlink/set-primary） |
| `user_settings` | ✓（`lichess.last_seen_game_id`、`lichess.departure_misses_ingested`） | ✓ |

### Cross-module dependencies

- `pgn_import` → `core/chess_core.import_pgn_games`、`repositories`。
- `analyze.py` → `pgn_import`（prepare 匯入）、`browser_compute`（classify-save）、`repositories`。
- `routers/lichess.py` → `api/security.encrypt_token`（OAuth token 加密存放）、`lichess_fetch`。

### API routes

- `GET /api/lichess`（status）、`POST /api/lichess/primary`、`GET /api/lichess/login|callback`、`DELETE /api/lichess[/{account_id}]`、`GET /api/lichess/latest`、`POST /api/lichess/seen`、`GET|POST /api/lichess/compare`。Analyze 面見 §flows。

### 對應 tests

- `tests/test_pgn_import.py`、`tests/test_api_lichess_games.py`（compare/latest/seen，network mocked）、`tests/test_api_lichess.py`（OAuth linking）、`tests/test_migration_lichess_primary.py`（`is_primary` backfill 的 typed-Boolean 契約）、`tests/test_api_analyze.py`（claim 路徑）、`tests/test_repositories.py`、`tests/test_storage_reload.py`。

### 重要 invariants / contracts

- **Owner 只填不改**：`save_game` upsert 以 `coalesce_cols=("owner_user_id",)`——重存永不改派既有 owner；`claim_*` 只填 NULL（first writer wins）。`claim_or_verify_game` 回傳 False（caller 視為 not-found）代表 game 不存在或屬他人。
- **Owner-scoped 去重**：同 lichess_id / 同 move-signature 的去重只在「該使用者自己」的既有局內查——兩個 user 匯入同一局各自保留一份（`find_game_id_by_lichess_id` docstring）。
- **Signature 去重**：`signature = " ".join(move.uci)`；batch 內重複也跳過，並回報既有 id（供 re-analysis 載入）。
- **LinkedAccount `is_primary`**：每個 provider 恰一個 primary（`_demote_others`），作為 My-last-game / compare / explorer 的預設來源；backfill migration 必須用 typed Boolean update（見 test_migration_lichess_primary 的雙方言教訓）。
- **`source_account` 歸屬**：compare/latest 的每局標記來源 linked username；多身分時 `compare_many_identities` 平分額度（`_COMPARE_COUNT_MAX = 50`）、bounded concurrency、單一帳號失敗不阻塞其他（partial degrade）、依 game id 去重。
- **External usernames**：compare 可帶任意公開 Lichess username（Games/Scout 共用的 Source Composer 選擇），但比對仍 owner-scoped（只比 caller 的 repertoires）。
- **`is_new` 判定**：`lichess.last_seen_game_id`（user_settings）對照最新局 id；`mark_seen` 才更新。

---

## 5. Scout backend contracts

Scout（對手偵察）**主要在瀏覽器執行**——抓 Lichess 公開 PGN、開局傾向彙總、自家 repertoire 評分全部 client-side（`web-src/scout.js` header）。後端只提供資料來源與契約邊界。

### 主要檔案

| 檔案 | 角色 |
| --- | --- |
| `web-src/scout.js` | 核心：抓公開 PGN export（CORS-open、無 token）、解析、per-colour trie |
| `web-src/scout-*.js`（40+ 檔） | probability、refutation、preparation-value、maia、engine scan、report…（各含 `*.test.js`） |
| `web-src/explorer.js` | 開局 explorer client（走後端 proxy，見下） |
| `src/prepforge_chess/api/routers/lichess.py` | `explorer_proxy`：Scout/Build 共用的 explorer 資料源 |
| `src/prepforge_chess/api/middleware.py` | CSP `connect-src` 契約（允許 `https://lichess.org` 直連） |
| `tests/test_scout_production_boundary.py` | product/research 邊界守門 |

### 後端契約（Scout 依賴的 server 面）

1. **直接 Lichess 公開 API**（無後端參與）：`web-src/scout.js` 以注入式 fetcher 抓 `lichess.org/api/games/user/{username}` 之類公開 PGN export。契約載於 CSP：`middleware._LICHESS_API_HOSTS` 放行 `https://lichess.org` 進 `connect-src`（AUTO Maia 強度也讀公開 profile rating）。移除即斷線。
2. **Explorer proxy**：`GET /api/lichess/explorer/{db_name}`（`masters` 或 player pool）。server 釘死 query params（不可當通用 proxy）、需 linked token、server-side LRU 快取（TTL 24h、cap 500）、upstream 429 → 429 pass-through、route rate limit 120/min。client 端 `web-src/explorer.js` 另有 localStorage 快取（`prepforge.explorer.cache.v1`、TTL 1 週、cap 150、429 後 60s cooldown）。
3. **Source Composer 共用契約**：Games 與 Scout 共用同一套來源選擇（`prepforge.scout_self` / `scout_source` / `scout_external` localStorage keys，`web-src/app.js`），resolve 後以 `usernames`/`account_ids` 呼叫 `GET|POST /api/lichess/compare`（見 §2/§4）。
4. **Repertoire 資料**：Scout 對「對手實際路線」評分使用者的 repertoire——tree 經 `/api/repertoires`、`/api/build/load` 等 workspace 端點取得（見 §3）。
5. **邊界守門**：`tests/test_scout_production_boundary.py` — `src/` 與 `web-src/` 內任何 `.py`/`.js` 不得含 `from research` / `import research` / `research/module_b` / `scripts/run_`。研究程式（`scripts/scout-*.mjs`、`research/scout-*`）與 product runtime 完全隔離。

### 入口（Scout JS 面，供定位）

- `web-src/scout.js`：`scoutFetchErrorMessage`、trie/`triePathKey`、`MAX_PLIES=16`、`ANALYZE_PLIES=24`。
- `scout-engine.js`：opt-in Stockfish 深掃（`SCOUT_ENGINE_DEPTH=12`、localStorage 快取 schema `ENGINE_CACHE_SCHEMA=3`、`prepforge.scout.engine.v3:*`，舊 v1/v2 前綴列入 `STALE_CACHE_PREFIXES` 清理）。
- `scout-maia.js` / `scout-maia-harness.js`：Maia3 ONNX（browser worker；權重自 CDN，CSP `_WEIGHT_CDN_HOSTS` 放行 huggingface/hf.co）。

### 對應 tests

- 邊界：`tests/test_scout_production_boundary.py`。E2E smoke：`tests/e2e/test_scout_smoke.py`、`tests/e2e/scout_refutation_smoke.mjs`。單元：`web-src/scout-*.test.js`（vitest）。研究基準（非 product）：`scripts/scout-*.mjs`。

### 重要 invariants / contracts

- **Scout 不經後端抓對局、不做數值運算**（`web-src/scout.js` docstring）；server 端唯一接觸點為 explorer proxy、compare、repertoire 讀取。
- **無 token 直連**：Scout 的 PGN 抓取不需要 proxy（middleware 註解明示）；一旦需要 token 的 API 就改走 server proxy（explorer 即是）。
- **快取皆 schema-versioned**：engine 快取 v3 + stale 前綴清理；explorer client 快取 v1。
- **Product 程式不得 import research Module B runners**（test 強制）。

---

## 6. Database mutation / caching / invalidation

### 主要檔案

| 檔案 | 角色 |
| --- | --- |
| `src/prepforge_chess/storage/repositories.py` | 全部 SQL：`_upsert`（conflict update + `coalesce_cols`）、`mutate_user_setting`、`record_attempt_receipt` |
| `src/prepforge_chess/storage/sa_tables.py` | domain schema（13 表） |
| `src/prepforge_chess/storage/codec.py` | 緊湊編碼（game uci_blob、PV、search-limit sentinel、WDL、position key） |
| `src/prepforge_chess/api/db.py` | engine/session（SQLite PRAGMA、Postgres pool） |
| `src/prepforge_chess/api/models.py` | ORM：users、linked_accounts、teams、user_settings、train_attempt_receipts、stripe_events、auth_sessions |
| `migrations/` | Alembic（production schema 權威） |

### Mutation patterns（repositories）

- **`_upsert(conn, table, values, conflict, update_cols, coalesce_cols)`**：統一 ON CONFLICT DO UPDATE；`coalesce_cols` 只填 NULL（owner 欄專用——不改派）。
- **`mutate_user_setting(user_id, key, mutator)`**：原子 read-modify-write（Postgres `FOR UPDATE` row lock）；不變則跳過寫入；mutator 回 None = 刪 key。streak 與 recap snapshot 共用同一 settings 事實，靠它避免 lost update。
- **`record_attempt_receipt(conn, ...)`**：在 caller 的交易內 `ON CONFLICT DO NOTHING` claim attempt（exactly-once primitive）。
- **`save_game` vs `save_game_batched`**：前者刪重建 moves（單局）；後者單交易批次寫 positions/evals/moves/analysis（chunk 400，避開 SQLite 999 / PG 65535 參數上限）。
- **Datetime 持久化**：domain 表 datetime 一律 ISO-8601 TEXT；dashboard 的 due 查詢用**字典序比較**（`due_at <= now_iso`）——格式是 load-bearing（`tests/test_storage_datetime_persistence.py`）。

### Caches & invalidation

| 快取 | 位置 | 寫入／失效 |
| --- | --- | --- |
| `repertoires.health_json`（denormalized health badge） | DB column（migration `a1b2c3d4e5f6`） | **寫**：`build_workspace_payload`（每個 Build mutation 都經過，diff `IS DISTINCT FROM` 才寫）+ `train._smart_summary_payload`（smart session 前後 bookend）。**讀**：`/api/repertoires`（list_owner_repertoire_listings）直接回，不做 per-row tree walk。失效＝重算即重寫，無 TTL。 |
| `recap.weekly_snapshot`（dashboard 每週基線） | `user_settings` key | `_weekly_recap` 以 `mutate_user_setting` 幂等 reseed（新週才換基線）；同 key 的原子 mutation 與 streak 互不覆蓋 |
| `lichess.departure_misses_ingested` | `user_settings` key | compare 記帳防重（cap 300）；只有新增 miss 時寫 |
| `lichess.last_seen_game_id` | `user_settings` key | `POST /api/lichess/seen` 寫；`latest` 的 `is_new` 對照 |
| Explorer proxy LRU | 進程內（`routers/lichess.py`） | URL 為 key、TTL 24h、cap 500；無主動失效 |
| Explorer client cache | localStorage（`web-src/explorer.js`） | TTL 1 週、cap 150、429 cooldown 60s |
| Scout engine scan cache | localStorage（`web-src/scout-engine.js`） | schema v3 key；啟動清理 v1/v2 stale 前綴 |
| Analysis per-position eval cache | `services/analysis.py`（`_PositionEvalCache`，engine-driven 路徑） | request 內 |

### 對應 tests

- `tests/test_repositories.py`（upsert/claim/settings）、`tests/test_storage_codec.py`、`tests/test_storage_reload.py`（跨 process round-trip）、`tests/test_storage_datetime_persistence.py`（TEXT datetime 字典序契約）、`tests/test_database.py`、`tests/test_sa_tables.py`（Alembic = 唯一 schema 權威的 drift guard）、`tests/test_api_db_config.py`、`tests/test_postgres_backup.py`、`tests/test_migration_lichess_primary.py`、`tests/test_build_sql_counts.py`（SQL 次數回歸）。

### 重要 invariants / contracts

- **Alembic 唯一生產 schema 權威**：無 runtime `create_all`、無 `schema.sql` fixture（test_sa_tables 斷言 metadata 與 Alembic 一致）。
- **`user_settings` 一 fact 一 row**：streak、recap、lichess markers、分析偏好各自獨立 key——不同 key 的並發寫互不覆蓋；同一 key 的 RMW 走 `mutate_user_setting`。
- **Ownership 不可改派**：games/repertoires 的 owner 欄只填 NULL（`coalesce_cols`、`claim_*`）。
- **FK 安全**：SQLite 每連線重申 `PRAGMA foreign_keys=ON`（pool 新連線會重置）；WAL 一次設定；刪 opening_nodes 前先清 `training_sessions.current_node_id`。
- **Compact codec 契約**（`codec.py` docstring）：磁碟權威＝`initial_fen + uci_blob`（moves 只存不可重建的 per-ply 註記，`move_needs_row`）；position = 完整 6 欄 FEN（unique，非 hash）；eval key = `(position_id, engine, depth, nodes, time_ms)`，未設限以 `codec.UNSET_SEARCH_LIMIT` 儲存使 UNIQUE NULL-safe；opening node = `(parent, uci)` + repertoire `root_fen` 重建 FEN。SAN/FEN/PGN 皆讀取時衍生。

---

## 7. API routes 總表（backend 面）

| Prefix | Router 檔 | 主要 routes |
| --- | --- | --- |
| `/api/auth`、`/api/auth/google` | `auth.py`、`google_auth.py` | 註冊/登入/session、Google OAuth |
| `/api/lichess` | `lichess.py` | status、primary、login/callback、unlink、`explorer/{db}`、compare(GET/POST)、latest、seen |
| `/api` | `workspace.py` | dashboard、repertoires（list/create/fork/delete/set-active/share/share-link/export-pgn/import/import-pgn）、`shared/{token}`、build（load/add-move/add-moves/delete-nodes/generate/apply-plan/action/annotations/export/rename） |
| `/api` | `analyze.py` | analyze/prepare、analyze/classify-save、analyses、analyses/{game_id}、board、board/move |
| `/api/train` | `train.py` | start、move、skip、hint、record-miss、smart/{start,summary,move,sync,skip} |
| `/api` | `settings.py` | 使用者偏好（Stockfish 深度等） |
| `/api/teams` | `teams.py` | teams/成員/invite/repertoire 共享（share 到 team 為唯讀） |
| （billing） | `billing.py` | Stripe webhook（`WEBHOOK_PATH`，CSRF exempt、簽章驗證） |
| （ops/legal） | `clientlog.py`、`legal.py` | client error beacon（CSRF exempt）、legal 頁 |
| `/healthz`、`/api/csrf` | `main.py` | liveness、CSRF bootstrap |

Ownership 依賴鏈（幾乎所有資料端點）：`current_user`（session cookie → `AuthSession.token_hash`）→ `current_owner`（`users.id`）→ `get_repository`（`PrepForgeRepository(get_engine())`）。

---

## 8. Tests 對照表（依區域）

| 區域 | Tests |
| --- | --- |
| Training / scheduler | `test_scheduler.py`、`test_training.py`、`test_training_smart.py`、`test_api_train.py`、`test_streak.py`、`test_progress.py`、`e2e/test_train_keyboard_smoke.py` |
| Repertoire matching | `test_repertoire_matching.py`、`test_lichess_fetch.py`、`test_api_lichess_games.py` |
| Opening tree / persistence | `test_opening_builder.py`、`test_opening_generation_v2.py`、`test_repertoire_export.py`、`test_api_workspace.py`、`test_api_build_actions.py`、`test_api_build_generate.py`、`test_build_route_sql.py`、`test_build_sql_counts.py` |
| Games attribution | `test_pgn_import.py`、`test_api_lichess.py`、`test_api_lichess_games.py`、`test_api_analyze.py`、`test_migration_lichess_primary.py` |
| Scout contracts | `test_scout_production_boundary.py`、`e2e/test_scout_smoke.py`、`e2e/scout_refutation_smoke.mjs`、`web-src/scout-*.test.js` |
| DB mutation / caching | `test_repositories.py`、`test_storage_codec.py`、`test_storage_reload.py`、`test_storage_datetime_persistence.py`、`test_database.py`、`test_sa_tables.py`、`test_api_db_config.py`、`test_postgres_backup.py` |
| 相鄰（分析/brilliant 等） | `test_analysis.py`、`test_analysis_report.py`、`test_api_analyze.py`、`test_brilliant.py`、`test_classification*.py`、`test_replay_maia.py`、`test_maia_adapter.py`、`test_api_teams.py`、`test_api_settings.py`、`test_dashboard_recommendations.py` |

## 9. Tables 索引

| 表 | 定義處 | 主要讀寫者 |
| --- | --- | --- |
| `games` | `sa_tables` | `pgn_import`、`repositories`、`analyze`、`lichess`（latest 不落庫）、dashboard 計數 |
| `moves`、`positions`、`engine_evaluations` | `sa_tables` | `repositories._save_move_annotation/_save_engine_evaluation`、`codec` |
| `analysis_results` | `sa_tables` | `analyze_classify-save`、`list_analyzed_games`、`load_latest_analysis_result` |
| `repertoires` | `sa_tables` | builder/workspace/teams/train（health_json 快取） |
| `opening_nodes` | `sa_tables` | builder、training walk、matching walk |
| `training_sessions` | `sa_tables` | training/training_smart（line_order 存卡片編碼） |
| `training_progress` | `sa_tables` | training、scheduler、progress、lichess departure misses |
| `user_settings` | `api/models.UserSetting` | streak、recap、lichess markers、偏好 |
| `train_attempt_receipts` | `api/models.TrainAttemptReceipt` | training_smart.sync_progress（exactly-once） |
| `users`、`linked_accounts`、`auth_sessions` | `api/models` | auth、lichess linking（token 加密） |
| `teams`、`team_members`、`team_invites` | `api/models` | teams router（共享唯讀） |
| `stripe_events` | `api/models` | billing webhook（idempotency） |
| `engine_settings`、`app_settings` | `sa_tables` | engine 設定（app_settings 全域 key/value） |
