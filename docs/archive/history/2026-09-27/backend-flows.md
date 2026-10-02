# PrepForge Backend Flows（核心端到端流程）

> 產生自 `origin/main`（2026-09-27）。只描述現況。索引與區域細節見 [backend-map.md](backend-map.md)。
> 每條 flow：觸發 → call chain（檔案）→ 持久化寫入 → 回應/輸出 → 相關 invariants。

---

## Flow 1：Smart Train session（local-first 卡片訓練）

**觸發**：SPA Train 檢視 → `POST /api/train/smart/start`（`mixed` 可跨 repertoire）。

1. `api/routers/train.py:smart_start` → `_owned_repertoire`（單一 rep 時；ownership gate 與 workspace 共用）。
2. `services/training_smart.py:SmartTrainingService.start_or_resume[_mixed]` → 載入 repertoire tree（`repositories.load_repertoire`）+ `training_progress`。
3. `services/scheduler.py:build_session_plan`（必要時 `mix_plans`）→ `SessionPlan`：weak→due→new→polish 卡片池，常數 `WEAK_SHARE=0.6`、`DEFAULT_SESSION_SIZE=12`、`DEFAULT_NEW_CAP=4`。
4. 卡片以 `encode_card`（`kind:repertoire_id:first:last`）編碼存進 `training_sessions.line_order`（`repositories.save_training_session`）。
5. 回應：`smart_prompt_to_json` + **`session_card_bundle`（整組卡片含 expected move / run-in / hint / reply）**、queue composition、health bookend（`_smart_summary_payload` → `compute_health`）。

**session 進行（client 離線自跑）**：client 以 bundle 內資料逐卡作答、自行計分（`attempt` 編號）；reveal 後照抄的 move 不計分。

**flush**：`POST /api/train/smart/sync`（`SmartTrainingService.sync_progress`）：

1. 驗證批次（≤ `MAX_SYNC_ATTEMPTS=500`；每筆必帶 `attempt_uuid`）。
2. 每筆 attempt 在**單一交易**內：`repositories.record_attempt_receipt`（`(session_id, attempt_uuid)` ON CONFLICT DO NOTHING）→ `training.record_attempt`（mistakes/mastered 記帳）→ `update_spaced_repetition`（SR 公式）→ upsert `training_progress` + `training_sessions`。
3. queue/card_index 隨 flush 一起持久化（格式錯誤的卡丟棄不落地）。
4. 回應 `applied` 數 + `day_streak`（僅新 attempt 時刷新；見 `streak`）。

**收尾**：`GET /api/train/smart/summary` → 重新算 health（並刷新 `repertoires.health_json` 快取）+ `due_forecast` + 權威 `day_streak`。

**Invariants**：exactly-once receipts（重試同 payload = no-op；同 UUID 異 payload = 409 級 `ValueError`）；SR 只在 `attempt == 1` 寫入；streak 經 `mutate_user_setting` 原子前進（client 本地日期 ±1 天 clamp）。

**寫入**：`training_sessions`、`training_progress`、`train_attempt_receipts`、`repertoires.health_json`、`user_settings:training_streak`。

---

## Flow 2：Build mutation → Build payload（含 health 快取刷新）

**觸發**（三種寫入型態，全部 owner-gated）：

### 2a. 單步手動 move

`POST /api/build/add-move`（`api/routers/workspace.py:build_add_move`）：

1. `_owned_repertoire` gate → `repositories.load_repertoire`。
2. `services/opening_builder.py:OpeningBuilderService.add_move`：python-chess 驗證合法性 → 新 node（`is_prepared = parent.side_to_move is repertoire.color`、`is_mainline = parent 無 enabled child`）。
3. 持久化：`repositories.save_changed_nodes` / `update_opening_nodes`（只寫 diff）→ `opening_nodes`（+ 必要時 `positions`/`engine_evaluations`）。
4. 回應：`workspace_view.build_workspace_payload`（全量 Build 視圖 + `summary`）。

### 2b. Local-first 批次 flush

`POST /api/build/add-moves`（rate limit 30/min）：SPA 在本地樂觀渲染、閒置時 flush `{tempId, parentRef, uci}` 批次（≤500）→ `OpeningBuilderService.add_moves_batch`（all-or-nothing、重驗證合法性與 parentage、強制 MANUAL source、重算 flags）→ 回傳 payload 附 **`id_map`（tempId → 真實 node id）** 供 client 對帳。

### 2c. Build-Generate apply-plan（browser-compute）

生成 recursion（Stockfish + Maia3）在**瀏覽器**執行並組出 plan → `POST /api/build/generate/apply-plan`（rate limit 10/min）：

1. `build_apply_plan` 驗 plan 形狀 → `_owned_repertoire`。
2. `OpeningBuilderService.apply_generation_plan`：plan 只能帶 `GENERATED_STOCKFISH`/`GENERATED_MAIA3` 來源（不得偽造 MANUAL/IMPORTED_PGN）；上限 `MAX_PLAN_CHANGES=2000`、`MAX_PLAN_DEPTH=64`、`MAX_PLAN_PV_LENGTH=64`；server 不跑引擎，只重驗證 + 落地 browser 算好的 eval（White-POV）。
3. 回應 `build_workspace_payload`（含 `summary`）。

**共通收尾**：`build_workspace_payload`（`services/workspace_view.py`）——`tree_report` 純走訪 + `mastery_map` + `compute_health`，並**順手刷新 `repertoires.health_json` 快取**（diff `IS DISTINCT FROM` 才寫）。每個 Build mutation 都經此函式，快取因此保持同步（無 TTL）。

**Invariants**：server 零引擎運算；批次/plan 皆有 DoS 上限；`delete_opening_nodes` 先清 `training_sessions.current_node_id` 參照；node 操作（`POST /api/build/action`）與 annotations 同樣回傳 payload（annotations 只回傳箭頭/圓圈）。

**寫入**：`opening_nodes`、`repertoires`（rename/set-active/`health_json`）、`positions`、`engine_evaluations`；批次刪除時 touch `training_sessions`（清參照）。

---

## Flow 3：Lichess compare → repertoire matching → train（play→train loop）

**觸發**：Games/Scout 的 Source Composer（共用選擇）→ `GET|POST /api/lichess/compare`（可帶 `account_ids` / 任意 `usernames`）。

1. `api/routers/lichess.py:_run_compare`：整理 linked usernames（primary 優先）+ 外部 usernames；`_COMPARE_COUNT_MAX=50`。
2. `services/lichess_fetch.py:compare_recent_games`（單一帳號）或 `compare_many_identities`（多帳號：平分額度、bounded concurrency、單帳號失敗不阻塞、game id 去重、標 `source_account`）→ 抓 Lichess 公開 PGN。
3. `ChessCore.import_pgn_games` 解析 → `services/repertoire_matching.py:match_game_against_repertoires`（walk enabled children；僅比對 owner 的 active repertoires）→ `RepertoireMatchResult`（`matched_plies`、`departure_reason`、`expected_node_id`）。
4. `_build_summary` → `GameMatchSummary`（每局：user_color、in_repertoire、departure_*、expected_move_*、`move_san_history`）。
5. **回饋訓練**：`lichess_fetch.record_departure_misses`——只處理 `user_left_preparation` 且帶 `expected_node_id` 的局：`training.update_spaced_repetition(correct=False)` 後把 `due_at` 改為立即（下一個 session 就出現）→ `repositories.save_training_progress`；已處理 game id 記入 `user_settings:lichess.departure_misses_ingested`（cap 300，重跑不重複計數）。
6. 回應：games 陣列（含 `training_recorded`、`source_account`）+ `misses_recorded` + `sources`。

**Invariants**：對手新招不記 miss；比對 owner-scoped；departure 語意四值（見 map §2）。

**寫入**：`training_progress`、`user_settings:lichess.departure_misses_ingested`（僅有新 miss 時）。

---

## Flow 4：Analyze classify-save（browser-compute 分析持久化）

**觸發**：Analyze 檢視在瀏覽器跑完 Stockfish（每 position eval）+ 可選 Maia3（move assessments / trap_gap）→ `POST /api/analyze/classify-save`。

1. `api/routers/analyze.py:analyze_classify_save` → `repositories.claim_or_verify_game(game_id, owner)`（unowned 認領、他人持有 → 404）。
2. 驗證 `positions` payload（非空、每筆帶 fen）→ `_brilliant_analyzer_from_client` 驗證 `maia_assessments`（≤1000 筆；`human_probability`/`win_chance_after` ∈ [0,1]、`trap_gap` ∈ [-1,1]，皆須 finite）→ `BrilliantAnalyzer(ReplayMaia(...))`。
3. `repositories.load_game` → `services/browser_compute.py:classify_precomputed_game`：套用預算 evals → `classification.classify_move`（唯一分類真相）+ Brilliant 偵測 → `AnalysisResult`（summary、critical_ply）。
4. 持久化：`repositories.save_game_batched`（單交易批次寫 `positions`/`engine_evaluations`/`moves`/game 更新）→ `save_analysis_result`。
5. 回應：`analysis_result_to_payload` + `server_timings_ms`（ownership/validate/classify/save 分段計時）。

**Invariants**：無任何 server 端引擎/模型運算；分類與 engine-driven 路徑（`services/analysis.py`）共用同一 `classify_move`/`BrilliantAnalyzer`；browser 沒給 trap_gap 的 move 不會被標 brilliant。

**寫入**：`games`（更新）、`moves`、`positions`、`engine_evaluations`、`analysis_results`。

---

## Flow 5：遊戲匯入與歸屬（PGN paste / Lichess 導入）

**觸發**：`POST /api/analyze/prepare`（`_import_pgn_for_analysis`）或其他匯入入口 → `services/pgn_import.py:PgnImportService.import_text(pgn_text, options, owner_user_id)`。

1. `ChessCore.import_pgn_games`（`source=IMPORTED_PGN`）→ 失敗收斂為 `errors`。
2. 去重（owner-scoped）：`repositories.find_game_id_by_lichess_id(lichess_id, owner)` → `existing_move_signature_ids(owner)`（signature = UCI 序列）；batch 內重複也跳過，**回報既有 id**（供 re-analysis）。
3. `repositories.save_game(game, owner_user_id=owner)`：games upsert（`owner_user_id` 為 coalesce-fill——重存不改派）+ moves 刪重建（僅 `move_needs_row` 的 per-ply 註記）+ positions/evals。
4. 回應 `PgnImportResult`（imported/skipped/errors/warnings）；prepare 路徑取第一個 game id 續做分析。

**Watcher 歸屬（My last game）**：`GET /api/lichess/latest` → `_links_for`（primary 優先）→ `lichess_fetch.newest_game_across`（每帳號抓最新局、bounded concurrency、game id 去重、完成時間最新者勝）→ 比對 `user_settings:lichess.last_seen_game_id` 產出 `is_new`；`POST /api/lichess/seen` 記錄已確認局。

**Invariants**：owner fill-only；同 lichess_id/同 signature 兩個 user 各留一份；`is_primary` 每 provider 恰一（`POST /api/lichess/primary` → `_demote_others`）。

**寫入**：`games`、`moves`、`positions`、`engine_evaluations`；`user_settings:lichess.last_seen_game_id`（seen）。

---

## Flow 6：Repertoire 匯入（package / tree PGN）

**觸發**：`POST /api/repertoires/import`（`.prepforge.json` package）或 `/repertoires/import-pgn`（tree PGN，variations → branches）。

1. `_enforce_repertoire_quota`（Free plan 上限 `settings.free_repertoire_limit`，超標 402）。
2. `services/repertoire_export.py:RepertoireExportService.import_package_json` / `import_tree_pgn`：驗證 `PACKAGE_KIND="prepforge_repertoire_package"`、`PACKAGE_SCHEMA_VERSION=1`、id/tag/name/comment 驗證規則。
3. package 路徑 `_reassign_ids`（全新 repertoire/node id——匯入者自己的副本，不跨租戶覆寫）。
4. `repositories.save_repertoire(repertoire, owner_user_id=owner)`（建立即歸屬）。
5. 回應：`build_workspace_payload`（新樹的 Build 視圖 + summary）。

**匯出**（對稱）：`POST /api/build/export`（json package / mainline PGN / node-path PGN）與 `GET /api/repertoires/export-pgn` — 純序列化，無寫入。

**Invariants**：所有產生 repertoire 的 route 一致走 quota；分享檢視（`GET /api/shared/{token}`、team share）經 `_strip_readonly_build_payload` 移除 health/summary/mastery；share token 為 HMAC 簽章（`mint_share_token`/`parse_share_token`）。

**寫入**：`repertoires`、`opening_nodes`（+ 匯入 evals）。

---

## Flow 7：Explorer proxy（Scout/Build 共用資料源）

**觸發**：SPA `web-src/explorer.js`（Build、Scout 皆用）→ `GET /api/lichess/explorer/{db_name}?fen=...&ratings=...`。

1. `api/routers/lichess.py:explorer_proxy`（rate limit 120/min）：`db_name` 白名單（masters / player pool）、query params 由 server 釘死（不可當通用 proxy）。
2. 進程內 LRU 快取命中（TTL 24h、cap 500）→ 直接回。
3. 未命中 → `_linked_token`（需要 linked Lichess account）→ `lichess_fetch.fetch_explorer_json`（Bearer token 僅 server 端）→ 429 → 429 pass-through（`ExplorerRateLimitedError`）、其他錯誤 → 502。
4. 回傳 upstream JSON；寫入 LRU。

**Client 端配套**：`web-src/explorer.js` localStorage 快取（TTL 1 週、cap 150）、同 key 單一 in-flight、429 後 60s cooldown。

**寫入**：無 DB 寫入（僅進程內快取）。

---

## Flow 8：Dashboard（計數、streak、recap 快照、推薦）

**觸發**：`GET /api/dashboard`（`api/routers/workspace.py:dashboard`）。

1. 單次 SQL 掃描（`repositories.engine.connect()`）：owner 的 games/repertoires/sessions 計數 + `training_progress` 六指標（open_mistakes、due_reviews、due_soon、reviews_7d、mastered_now、weak_now；ISO TEXT `due_at` **字典序**比較）。
2. streak：`streak.as_view(user_settings:training_streak, local_day)`。
3. Recap：`_weekly_recap` → `repositories.mutate_user_setting(owner, "recap.weekly_snapshot", _roll)`——同週保留基線、新週 reseed（原子 mutation，與 streak 併發不失效）→ 回 `mastered_delta`/`weak_delta`。
4. 推薦：`services/dashboard_recommendations.py:build_recommendations(DashboardSignals)`（純決策函式）。
5. 回應：計數 + streak + recap + recommendations。

**讀寫**：讀 `games`/`repertoires`/`training_sessions`/`training_progress`/`user_settings`；寫 `user_settings:recap.weekly_snapshot`（idempotent、每週一次實質變更）。

---

## 附：共通橫切面

- **Auth/ownership 鏈**（幾乎所有資料端點）：`current_user`（session cookie → `AuthSession.token_hash` SHA-256）→ `current_owner`（`users.id`）→ `get_repository`。
- **CSRF**：`CSRFMiddleware`（`pf_csrf` cookie + `X-CSRF-Token` header）；exempt：Stripe webhook（簽章驗證）、clientlog beacon（sendBeacon 無法帶 header）。
- **交易邊界**：repositories 每個 mutation 自帶 `engine.begin()`；唯一跨表單交易例外是 `training_smart.sync_progress` 的 per-attempt transaction（receipt + SR + session）。
- **Rate limits**（slowapi）：build/add-moves 30/min、build/delete-nodes 30/min、apply-plan 10/min、annotations 60/min、import 10/min、explorer 120/min。
