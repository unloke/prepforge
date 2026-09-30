# PrepForge Chess 全方位改進審查報告（2026-09-27）

> 範圍：UI、資料庫互動、演算法處理、功能設計、視覺效果、用戶體驗簡潔化。
> 本報告只做審查與建議，**不含任何產品程式修改**。所有量化結論都附上量測方法，可重現。
> 基準：branch `main`，285 commits，568 專案檔，177 測試檔。
> 前一份審查：`docs/fullstack-improvement-audit-2026-09-25.md`（2 天前）。本報告會明確標示
> **哪些舊項目已結案、哪些仍開放**，並聚焦新發現。

---

## 0. 執行摘要

### 0.1 這個專案目前的工程水準

老實說，這已經不是「需要被檢查」的專案，而是一個**有明確設計紀律的產品**。以下不是客套，是有證據的：

| 面向 | 證據 |
|---|---|
| 前後端演算法合約 | `classification.py` 與 `coach/features.js` 對同一組 win-probability 閾值互相錨定，連 sigmoid 常數 `0.00368208` 都有交叉註解，並有雙端 golden fixture（`tests/fixtures/classification_golden.json`） |
| 資料層 | `list_repertoires` 已批次化為 O(1) statement；`_save_moves_batched` 處理跨後端參數上限；`IS DISTINCT FROM` 避免無謂寫入；`mutate_user_setting` 用列鎖防丟失更新 |
| 演算法方法論 | Brilliant 三層 gate 是在 23 局人工標註集上做 feature AUC 選出來的（`trap_gap` AUC≈0.97，廢棄的 sound check AUC≈0.5），不是拍腦袋 |
| 無障礙 | 棋盤 roving tabindex + 方向鍵走棋、eval chart 鍵盤可操作、88 個 button 全部有可存取名稱、axe 已進 CI |
| 安全 | CSP 用 sha256 hash 授權單一 inline script 而非放行 `unsafe-inline`；CSRF double-submit；session 只存 hash；OAuth token Fernet 加密 + 版本前綴；wheel 結構性排除 ONNX |
| 資料驗證 | 演算法有 golden fixture、statement-count 回歸測試、PostgreSQL service container 跑 migration |

### 0.2 本次審查新發現的高價值問題（依影響排序）

| # | 問題 | 影響 | 量化 |
|---|---|---|---|
| **N1** | `/train/smart/move` 每次都重新 hydrate 整棵 repertoire 樹 | 訓練中每落一子都付全樹成本 | 2000 節點樹 **247 ms/次**，一次 12 卡 session ≈ 3 s 純浪費 |
| **N2** | `hydrate_opening_tree` 每節點建 2 個 `chess.Board` | 全站最大 CPU 熱點 | FEN parse/serialize 佔 **71%**；改成單 board push/pop 實測 **247 → 69 ms（3.6×）** |
| **N3** | 淺色主題多組語意色未達 WCAG AA | 標籤、badge、教練狀態字、棋盤座標不可讀 | 實測 9 組配色 **FAIL**（最低 1.98:1） |
| **N4** | `PREPFORGE_TOKEN_KEY` 未列入 `render.yaml` 與 `DEPLOYMENT.md` | 照 blueprint 部署會**開機即 crash** | `require_production_secret()` 丟 RuntimeError |
| **N5** | uvicorn 只開 `--proxy-headers`，未設 `FORWARDED_ALLOW_IPS` | Render 後所有使用者共用同一個 rate-limit 桶 | uvicorn 預設 `127.0.0.1,::1` |
| **N6** | Privacy Policy 承諾「可要求匯出或刪除帳號資料」但**沒有任何對應 endpoint** | 法遵落差 + 無 GDPR 刪除 | 隱私頁文字 vs `auth.py` 只有 register/login/logout/me |
| **N7** | Terms of Service 寫「GPL-3.0-or-later」，`LICENSE` 與 `pyproject.toml` 是 **AGPL-3.0** | 法律頁事實錯誤 | 兩處檔案直接對照 |
| **N8** | Scout 對 Lichess 429 只丟錯誤訊息，無退避重試；且 localStorage 快取用「筆數上限」而非「容量上限」 | 重複打 API 更容易再觸發 429；大帳號快取靜默失效 | `CACHE_CAP = 8` 筆，單筆可能數 MB，5 MB quota |
| **N9** | `GET /api/dashboard` 每次都做 `SELECT ... FOR UPDATE` 寫入 | 讀端點變寫端點，行鎖競爭 | `workspace.py:183` → `mutate_user_setting` |
| **N10** | 主 bundle 已貼在 gate 上限（298,033 / 299,000 B；CSS 152,741 / 154,000 B） | gate 會變成雜訊，隨便加個小功能就紅 | 99.7% / 99.2% 預算使用率 |
| **N11** | 無 `positions` / `engine_evaluations` / `games` 的清理路徑，也無刪除遊戲的 UI | 資料單調成長 + 使用者無資料自主權 | 刪 repertoire 只 cascade `opening_nodes` |
| **N12** | SRS 間隔是線性 `+1 分/次`，上限 10 天 | 「Mastered」每 10 天必回，與 spaced repetition 目的相反 | `update_spaced_repetition` score `min(10, score+1)` |

### 0.3 舊審查已結案的項目（不再重複建議）

| 舊編號 | 項目 | 現況 |
|---|---|---|
| U3 | 棋盤無法鍵盤走棋 | ✅ 已做（`app.js:2403` roving tabindex + 方向鍵 + Enter/Space 走子） |
| U4 / V1 | eval chart 顏色硬編碼、`preserveAspectRatio="none"` 線寬失真 | ✅ 已做（改 class token、`vector-effect="non-scaling-stroke"`） |
| V2 | 圖表無 tooltip / 無目前 ply 游標 | ✅ 已做（`eval-chart-tooltip` + `eval-chart-cursor` + hover 指示線） |
| U7 | axe 零引用 | ✅ 已做（`tests/e2e/test_axe_baseline.py` 進 CI） |
| F3 | Dashboard 推薦是靜態文案 | ✅ 已做（`dashboard_recommendations.py` 依 due/weak/mistake 訊號排序） |
| D1 | `list_repertoires` N+1 | ✅ 已做 |
| D5 | 無 PostgreSQL 驗證 | ✅ 已做（CI `postgres` job，PG 18 service container） |

---

## 1. UI（使用者介面）

### 1.1 現況亮點

- `BoardController`（`app.js:2222` 起）是本專案最成熟的元件：roving tabindex、方向鍵幾何（含翻面方位）、Enter/Space 走子、拖曳 + 點擊 + 右鍵畫箭頭三種輸入、升變選擇器共用同一條解析路徑 `_handleSquareActivation`。
- 88 個 `<button>` 全部有可存取名稱（icon-only 皆帶 `aria-label`）——這是我實測 `index.html` 得到的結論，不是假設。
- Modal 系統 `activateModal` 會把背景 `body.children` 設 `inert`，並在 teardown 統一移除 keydown（`app.js:2994/3091`），不會有孤兒監聽。
- 狀態列依 severity 切 `role="alert"` / `role="status"` 與 `aria-live`，且 error 不自動消失（`setStatus` 僅對非 error 掛 timer）。這個決定是對的。

### 1.2 問題

#### U-1（P1）`app.js` 11,704 行仍是巨型組裝檔

`docs/stability-perf-plan.md` #5 與 ROADMAP P3 都列了這項，方向已對（`views/*`、`controllers/account.js` 已抽出），但剩下的部分仍是 feature controller 混在全域。

- 量測：11,704 行 / 20 條 top-level import / 全域 `appState` + 散落 `document.getElementById`。
- 連帶效應：主 bundle 已貼在 gate 上限（N10），根因就是這支檔案同時承擔啟動組裝、Build local-first sync、Lichess 輪詢、toast/modal/palette 三套 UI 基礎設施、Train 遊戲對局。
- 建議：下一波抽 `ToastStack`（`app.js:948`，自成類別、邊界乾淨，最容易切）、`BoardController`、`buildPending`/flush timer 的 local-first sync 模組、Lichess poll 監看。每抽一支就重跑 `npm run lint:js && npm test`，並在 `check-bundle-size.mjs` header 記錄 delta。

#### U-2（P2）HTML 組裝仍大量依賴 `innerHTML` 字串模板

views 層已建立工廠注入模式（`views/*.js` 接收依賴），但組裝字串仍散落。既有 `escapeHtml` 紀律降低了 XSS 風險，但每新增一個欄位都是一次「記得呼叫 escape」的機會成本。

建議：把重複出現的片段（repertoire 列表列、move pill、chip、badge）抽成純函式模板模組，輸入一律結構化物件而非字串，讓漏 escape 在型別上就不可能發生。

#### U-3（P2）設定頁的資訊密度過高

`view-settings` 靜態就有 **17 個 button、1 個 select、3 個 input**，切成 Appearance / Engine / Maia3 / Playing strength / Board / Connections / About 七張卡。其中「Playing strength」一張卡裡就有：深度滑桿、Maia rating 滑桿、Maia auto switch、Maia analysis switch、四個 `ⓘ` popover。

問題不在資訊量本身（都是必要的），而在**同層級並列**：一個從沒開過 Maia analysis 的使用者，會在同一個視野裡同時看到「Stockfish 深度」「Maia 強度」「Maia 自動」「Maia 分析」四個互相干擾的旋鈕。

建議：把「Maia 相關」四項收進一個 `<details>`「Maia3 進階」群組（該區在 Maia 尚未下載時本來就多數無效），主層只留 Stockfish 深度 + 一個「啟用 Maia 教練」開關。同時把四個 `ⓘ` 圖示的說明文字合併成 Settings 頁底部的「這些設定在做什麼」單一說明區。

#### U-4（P2）375px 視窗下頂欄 7 個 tab 的處理仍是硬塞

`.topbar` 設了 `flex-wrap: wrap`（`styles.css:212`），所以不會爆版，但會折行成兩排——在 375px 這代表品牌列 + 7 個 tab + 狀態列 + Ctrl K + Lichess chip 佔掉大量垂直空間，且 `Ctrl K` 在行動裝置上沒有對應（沒有觸控入口）。

建議：≤640px 時把 Teams / Settings 收進一個「⋯」menu（Games / Scout 保留，因為它們是 Scout 動線的一部分）；`.palette-open` 在觸控裝置改為純圖示按鈕並加 `aria-label`。

#### U-5（P3）Modal 仍是自製而非原生 `<dialog>`

`showInputModal` / `activateModal` 手寫 focus trap、背景 inert、Escape 處理。原生 `<dialog>` + `showModal()` 由瀏覽器接管焦點圈閉（含 inert 語意）與 top layer 堆疊，能刪掉約 60 行關鍵盤陷阱的程式碼，也順帶解決「自製 modal 在 `overflow:hidden` 下的捲動鎖」這類邊界 bug。風險是 backdrop click 與動畫需要重寫，屬可控範圍。

---

## 2. 資料庫互動

### 2.1 現況亮點

- `list_repertoires` 已為 O(1) statement；`_load_evaluations` 一次撈回所有引用評估；`list_owner_repertoire_listings` 只取 metadata 不載樹。
- `GET /api/dashboard` 的六個 COUNT 已合併為單一條件聚合（`workspace.py:129`），且 `tally()` closure 讓意圖清楚。
- `positions.fen` 存完整 6 欄 FEN 並 unique（不是短雜湊），`engine_evaluations` 以 `UNSET_SEARCH_LIMIT = -1` 讓 UNIQUE 在 SQLite 與 PG 都 NULL-safe——這是很成熟的跨後端權衡。
- `train_attempt_receipts` 用 `ON CONFLICT DO NOTHING` 達成 exactly-once，配合 client 重送同一 UUID，local-first sync 的語意是對的。

### 2.2 問題

#### D-1（P1）訓練熱路徑每次重載全樹 — 本次最大發現

**證據鏈**：

1. `api/routers/train.py:369` 每個請求都 `SmartTrainingService(repo, owner).submit_move(...)` **新建實例**。
2. `SmartTrainingService.__init__` 的註解明寫「A service instance is created fresh per request」，所以 `_rep_cache` 只在單一請求內有效。
3. `submit_move`（`training_smart.py:832-836`）開頭就是 `self._load_repertoire_or_raise(...)` → `repository.load_repertoire()` → `_repertoire_from_rows` → `hydrate_opening_tree`（**整棵樹**）。

**實測**（SQLite，2000 節點樹，量測腳本見附錄 A）：

```
load_repertoire: 2 statements, 248.6 ms
load_repertoire: 2 statements, 245.6 ms
smart/start:    5 statements, 255.2 ms
submit_move:    median 4 statements, median 252 ms
```

一次 12 卡 session（`DEFAULT_SESSION_SIZE = 12`，每卡平均 3 個 target）若走 per-move endpoint，就是 **12+ 次全樹 hydrate ≈ 3 s** 的純伺服器 CPU。其中絕大部分用在重建馬上就會被丟掉的物件。

**建議（三選一，可疊加）**：

- **(a) 進程內短 TTL 快取**：以 `(repertoire_id, updated_at)` 為 key 的 LRU，TTL 30–60 s。`repertoires.updated_at` 已在每次寫入時更新（`save_repertoire` 的 `update_cols` 含 `updated_at`），所以天然可做失效判斷。這是最小改動、收益最大。
- **(b) 把 session 的 grading 判定下推到 client**：`/smart/start` 回傳的 prompt 已經包含 `expected_node_id` 與 `expected_move_uci`（`SmartPrompt` 註解明說「這是你自己的 repertoire，不是有秘密的測驗」），所以 correct/incorrect 判定本來就能在 client 做。server 只需要在 flush 時驗證並寫 SRS——而這正是 `/smart/sync` 已經在做的事。把 per-move endpoint 收斂成 sync-only，一次 session 的 DB 成本從 O(cards) 降到 O(1)。
- **(c) 窄化查詢**：`submit_move` 實際只需要 `(session, expected node, card targets, sibling children)`。可以加一個只回傳單一節點鏈的 repository 方法（`load_node_chain(repertoire_id, node_ids)`），成本從 O(整樹) 降到 O(depth)。

建議先做 (a)（一天內可完成、風險低），再評估 (b)（會改變 grading 的信任模型，需要想清楚 server 端要保留多少驗證）。

#### D-2（P1）`hydrate_opening_tree` 每節點建兩個 `chess.Board`

**證據**（cProfile，2000 節點樹 × 3 次，附錄 B）：

```
  ncalls  tottime  cumtime  函式
   6000    0.017    2.484  codec.py:300(walk)
   5997    0.022    1.876  codec.py:151(replay_uci)      ← 75% 的時間在這
  12000    0.009    1.145  chess/__init__.py:1697(__init__)   ← 每節點 2 個 Board
  11997    0.009    1.034  chess/__init__.py:2523(fen)        ← 每節點 2 次序列化
  11982    0.336    0.985  chess/__init__.py:1123(_set_board_fen)  ← 39% 累計
  11997    0.252    0.822  chess/__init__.py:1092(board_fen)       ← 32% 累計
   5997    0.002    0.149  chess/__init__.py:2981(san)            ← 只有 6%
```

**結論：71% 的 hydrate 時間花在 FEN 的解析與序列化，而不是任何棋理邏輯。** 三處冗餘：

1. `replay_uci(node.fen, uci)` 內部 `chess.Board(fen)` 解析一次 → `board.fen()` 匯出 `fen_before` → push → 再 `board.fen()` 匯出 `fen_after`。
2. `walk()` 接著又 `chess.Board(child.fen)` 一次，只為了 `_color_from_board` 取 `board.turn`——而 `replay_uci` 裡那顆 board 剛 push 完，turn 就在手上。
3. SAN（`board.san()`）會觸發合法著法生成，但只佔 6%。

**實測原型收益**（附錄 C，同樣 2000 節點、相同輸入、相同輸出契約）：

```
current (replay_uci)        246.7 ms
push/pop                    69.3 ms      ← 3.6×
```

**建議**：把 `walk()` 改成攜帶單一 `chess.Board` 的 DFS，`board.push(move)` 往下、`board.pop()` 往上；`side_to_move` 在 push 之前從 `board.turn` 取；`san` 用 `board.san_and_push()` 一次完成。`fen_before` 若呼叫端不需要可延後 lazily 產生。

這是**單一函式、行為不變、有 golden fixture 保護**的改動，卻同時改善 Build 載入、repertoire 列表、訓練每一步。建議列為本輪第一優先。

#### D-3（P2）`GET /api/dashboard` 有寫入副作用，且寫入方式是行鎖

`workspace.py:107` 的 dashboard 是 `GET`，但 `_weekly_recap` 會呼叫 `repo.mutate_user_setting(owner, _RECAP_SNAPSHOT_KEY, _roll)`，後者（`repositories.py:167`）在 Postgres 上對 `user_settings` 做 `SELECT ... FOR UPDATE`。

即使 mutator 回傳相同值而不寫入（程式有這個最佳化），**開頭那次列鎖仍然發生了**。結果：

- 每個 dashboard 讀取都變成一個寫交易 → 無法走 read replica、與同表的訓練 streak 寫入共享連線池。
- 同一使用者若同時開兩個分頁（或分頁 + 行動端 App），會在 `user_settings` 上互相排隊。

**建議**：把週快照改成「首次開啟 Train 時寫入」或一個每日排程（專案已有 `.github/workflows/keep-warm.yml` 這種排程基礎設施），讓 `GET /api/dashboard` 恢復為純讀。`recap.weekly_snapshot` 的語意本來就是「週初的快照」，由週初第一次動作觸發完全等價。

#### D-4（P2）兩套時間欄位型別並存

| 表 | 型別 |
|---|---|
| `users.created_at` / `auth_sessions.created_at` / `stripe_events.processed_at` | `DateTime(timezone=True)` |
| `games.created_at` / `played_at` / `repertoires.updated_at` / `training_progress.due_at` / `user_settings.updated_at` | `Text`（ISO-8601 字串） |

identity 表用真正的時間型別，domain 表用文字。專案註解說這是「跨後端一致的合理權衡」（字串序比較在 SQLite 與 PG 都成立），這個判斷本身沒錯——但**兩套並存**造成：

- 開發者寫新查詢時無法從型別一眼看出該用 `<=` 還是 `to_timestamp()`。
- `training_progress.due_at` 是 dashboard 熱路徑的篩選條件（`due_at <= now_iso`），在 PG 上是**無索引的文字範圍掃描**。隨著使用者樹變大，dashboard 會愈來愈慢，且症狀是「慢慢變慢」而非「突然壞掉」，難以定位。

**建議**：(1) 在 `docs/ARCHITECTURE.md` 明確寫下規則——「domain 表時間用 ISO-8601 UTC text，identity 表用 timestamptz」不是疏忽而是刻意選擇，並註明 `due_at` 的查詢模式；(2) 加一個 `Index("idx_training_progress_due", "due_at")`，讓 dashboard 的到期篩選有落腳點；(3) 若要徹底解，把 `due_at` 單獨遷移為 `DateTime`（domain 其他欄位可維持文字，不必全動）。

#### D-5（P2）`positions` / `engine_evaluations` 沒有任何清理路徑

- `positions` 是全域（不帶 owner）_catalog，隨匯入與分析單調成長。
- `engine_evaluations` 透過 `opening_nodes.engine_evaluation_id` 與 `moves.*_eval_id` 被引用，但**刪除 repertoire 時只有 `opening_nodes` cascade**（`delete_repertoire` 只刪 repertoire 一列，FK `ondelete="CASCADE"` 負責節點），評估列本身留下成為孤兒。
- 使用者**完全無法刪除已匯入的遊戲**——API 沒有 delete-game endpoint，UI 也沒有。

**建議**：
- 加一個維護性 GC job（可放在既有的排程 workflow）：刪除 `engine_evaluations` 中 `position_id` 不再被 `opening_nodes` 或 `moves` 引用、且 `updated_at` 超過 N 天的列；再刪除 `positions` 中無任何引用的列。
- 加「刪除單局遊戲」endpoint 與 UI 入口（同時解決 N11 的使用者資料自主權）。
- 這兩件事都應寫成 migration + 一個可重複執行的 job，而不是一次性腳本。

#### D-6（P3）評估去重 key 含 `time_ms`

`UNIQUE(position_id, engine, depth, nodes, time_ms)` 意味著「同一引擎、同一深度，但這次剛好花了 7312ms、上次花了 7298ms」會是兩列。瀏覽器端的 `time_ms` 來自實際量測，幾乎不可能重複。

**影響**：評估快取命中率隨機衰減；`engine_evaluations` 表膨脹速度遠高於必要。

**建議**：把「評估身分」收斂為 `(position_id, engine, depth)`（或以 `nodes` 為主鍵），`time_ms` 降級為「首次寫入時記錄的參考值」或獨立統計表。這需要一個 migration（合併既有重複列 + 改約束），建議與 D-5 的 GC 一起做。

#### D-7（P3）`user_settings.value_json` 是 `String(4000)`

`api/models.py:200` 用 `String(4000)` 而非 `Text`。目前存的值（週快照、streak、主題）都很小，但這是一個**沒有明確錯誤訊息的失敗模式**：一旦某個設定物件變大，PG 會丟 `value_syntax_error` 或 SQLite 會靜默接受（SQLite 不強制長度）——同一份程式在兩個後端行為不同。

建議改為 `Text`，並在設定寫入處加一個明確的長度檢查與可讀錯誤訊息。

---

## 3. 演算法處理

### 3.1 現況亮點

- 分類以 **win-probability loss** 為軸、對齊 Lichess 的 winningChances 切點（0.05 / 0.10 / 0.15），並註解了換算推導。門檻不是抄的，是推的。
- Brilliant 的三層 gate 有 feature AUC 佐證，且明確記錄了「被放棄的 sound check 為什麼放棄」——這是極少數專案會做的取捨記錄。
- Scout 統計基礎紮實：Wilson interval、MAD→σ、recency half-life、明確的 `SCOUT_SCORING_VERSION = 9`。
- `selectPreparationRoutes`（`scout-preparation-value.js`）是精確的樹上 knapsack DP（prefix antichain + slot budget），不是貪婪近似——這在「挑 12 條路線」這種問題上顯然更對。
- 瀏覽器端算棋、伺服器只驗證與持久化的邊界乾淨，`analyze.py::_brilliant_analyzer_from_client` 對不可信任 payload 有嚴格 schema。

### 3.2 問題

#### A-1（P1）SRS 間隔是線性的，上限 10 天

`services/training.py:507-533`：

```python
if correct:
    score = min(10.0, progress.spaced_repetition_score + 1.0)
    interval_days = max(1, int(round(score)))
    due_at = timestamp + timedelta(days=interval_days)
else:
    score = max(0.0, progress.spaced_repetition_score * 0.5)
    due_at = timestamp + timedelta(minutes=10)
```

實際行為：一個連續答對 10 次的 move，間隔會是 1 → 2 → 3 → … → 10 天，然後**永遠停在 10 天**。

兩個問題：

1. **上限 10 天違反 spaced repetition 的目的**。遺忘曲線（SMB-2 / FSRS / Anki）在這個區間是對數增長的；10 天後一個已經穩定的 move 仍會每 10 天回來一次。對一個有 500 個 prepared move 的 repertoire，等於每天被強迫複習 ~50 個已掌握的 move。
2. **難度完全沒被記錄**。答對一個「想了 20 秒才找到」的 move 與「秒答」的 move 拿到**完全相同**的 +1。這是 SM-2 最核心的兩個輸入之一（`q` 難度因子），目前缺席。

而且 `is_mastered` 的條件是 `score >= 7.0 and correct_attempts >= 3`（`training.py:532`），對應 `node_mastery` 的 help 文字「Recalled correctly 3+ times with no recent misses — reviews now arrive days apart」——**「days apart」實際上最多 10 天**，UI 文案與實際行為有落差。

**建議**（依投入分級）：

- **小改（半天，收益明顯）**：把 score 改成乘法增長 `score = min(30.0, score * 1.8 + 0.5)`，間隔 `int(round(score))` → 上限 30 天。這一改就能讓「mastered」的語意成立。**注意**：這會改變所有既有使用者的到期時間，需要一個 migration 或一個 `scoring_version` 欄位讓舊進度沿用舊公式。
- **中改**：把「答對花費時間」納入評分。client 端已有 `startedAt`/`answeredAt`（blitz 模式是 10 秒/手），伺服器端 `SmartMoveBody` 可以多收一個 `elapsed_ms`，用它調整 `q`。
- **大改（中期）**：改用 FSRS。開源、可離線、有一個標準 benchmark 可驗證。`TrainingProgress` 已有 `attempts` / `correct_attempts` / `last_reviewed_at`，足夠從歷史重建初始穩定度。

不論走哪條路，**先把 magic number 收進一個具名 config 物件**（現在散在 `training.py`、`scheduler.py`、`training_smart.py` 三處），並加一個「間隔倍率」設定項。

#### A-2（P2）`node_mastery` 用終身正確率判定 weak，與 Scout 的 recency 加權不一致

`services/progress.py:55`：

```python
if progress.attempts >= 2 and ratio < 0.5:
    return MASTERY_WEAK
```

`ratio = correct_attempts / attempts` 是**終身累積**。這代表：某個 move 早期錯了 2 次、之後連續答對 30 次，`ratio` 會是 32/34 = 0.94 而跳出 weak——看似沒問題，但一個錯 4 次中 3 次（0.25）、之後答對 20 次的 move，會停在 20/24 = 0.83 還要再答對 8 次才越過 0.5。在那之前它每個 session 都佔用 `WEAK_SHARE = 0.6` 的名額（`scheduler.py:66`），也就是說**一個早已答對的 move 會持續排擠 due / new 素材**。

更根本的是**專案內部不一致**：Scout 端用 recency half-life（`SCOUT_RECENCY_HALF_LIFE_DAYS = 90`）與 MAD 加權，Train 端用終身比例。同一個產品裡對「這個訊號還有多少權重」有兩套答案。

**建議**：把 `ratio` 換成「最近 N 次（N=10）或帶衰減的加權正確率」，並讓 `weak` 排序也用同一個分數（現在 `scheduler.py:292` 的 `accuracy()` 又是一個獨立的實作）。抽成 `progress.effective_accuracy(progress, now=...)` 單一函式，三個呼叫點共用。

#### A-3（P2）`polish` 池沒有任何節流

`build_session_plan`（`scheduler.py:299-330`）的配額邏輯是 `weak ≤ 60% → due → new ≤ 4 → polish → weak 補滿`。`polish` 無上限，而 polish 裡裝的就是 mastered / learning 節點。在 A-1 的線性 SRS 下，這代表 mastered 素材會不斷湧入 polish 池，擠掉 new。

`new_cap = 4` 對一個有 200 個未練 move 的 repertoire 意味著**要 50 個 session 才輪完一次**——每天練的話是 50 天後才會重新看到第一張新卡。

**建議**：
- 讓 `polish` 有明確的「保底份額」（例如至少 2 張、至多 50%），確保每個 session 都碰到一些已掌握的東西（維持手感）但不會壟斷。
- `new_cap` 應該依 repertoire 大小自適應（`max(4, session_size // 3)` 之類），而不是固定 4。
- 在 `session_plan` 的 counts 裡回報「距離輪完所有 new 素材還有幾張」，讓 UI 顯示——這是使用者能理解的具體目標（`counts` 已經有 `targets` 欄位，加一個成本極低）。

#### A-4（P2）前後端分類合約仍靠註解鎖定

`classification.py` 的 `ClassificationConfig` docstring 用大段文字解釋 `excellent_loss = 0.02` 與 `web-src/coach/features.js` 的 `BRILLIANT_MAX_CANDIDATE_WIN_DELTA = 2` 必須同步。這是**自覺的技術債**，註解寫得很好，但：

- 兩邊沒有任何自動化機制保證它們一致。
- `coach/classification-golden.test.js` 只在 JS 側跑，`tests/test_classification_golden.py` 只在 Python 側跑——**沒有任何一個測試同時跑兩邊並比對結果**。

**建議**：加一個跨語言 golden 測試。作法不需要引入工具鏈：`tests/fixtures/classification_golden.json` 已經存在且雙端都在讀，讓 pytest 呼叫 `node -e "..."` 執行 `classifyMoveRich` 走同一份 fixture，逐 ply 斷言兩邊的 classification 字串完全相等。任何一邊改閾值而沒改另一邊，CI 立刻紅。

**這是本報告中投入產出比最高的一項**：成本約 1 小時，保護的是產品最核心的正確性聲譽（同一局棋在 Coach 與報告裡給出不同標籤，是使用者最不會原諒的 bug）。

#### A-5（P2）`MoveClassification` enum 有不可達狀態

`models.py` 定義了 `BOOK` / `MISSED_WIN` / `MISSED_TACTIC`，但 `classify_move` 不產 `BOOK`；`MISSED_WIN` 由 `analysis.py` / `browser_compute.py` 事後補判；`MISSED_TACTIC` 在 Python 端**沒有任何產生路徑**（需確認瀏覽器端是否也無）。

不可達的 enum 成員會讓 API 消費者寫出永遠不會發生的分支。

**建議**：要嘛補上（`BOOK` 有 `coach/bookline.js` 的資料可用作候選），要嘛收斂 enum。個人傾向**收斂**——因為一個誠實的 enum 比一個有 aspirational 成員的 enum 更好維護。

#### A-6（P3）前端分類與 brilliant 的門檻常數散落三處以上

`WC_SIGMOID_SCALE = 0.00368208` 在 `classification.py`、`coach/features.js`、`views/analyze.js` 三處（註解互相錨定）。`evalChartYOf` 的 win% 映射在 `analyze.js` 另有一套。Scout 端有 `SCOUT_SCORING_VERSION` 這種明確的版本常數是好的示範，但只覆蓋 Scout。

**建議**：比照 `SCOUT_SCORING_VERSION` 的作法，為分類/教練層加一個 `CLASSIFICATION_SCORING_VERSION`，並在 A-4 的跨語言測試中一併斷言它兩邊一致。這樣下次改閾值時，版本號的差異會強制你更新 golden fixture，而不是靠註解提醒。

---

## 4. 功能設計

### 4.1 現況亮點

Analyze → Build → Train 的移交動線完整（分析結果一鍵轉 repertoire、Train 的 handoff 提示）。Teams 有角色、邀請連結、分享/複製。計費有 Free/Pro quota 統一入口。訓練端有 Smart queue / Line rehearsal / Play vs human / Feeling Lucky 四種模式。

### 4.2 問題

#### F-1（P0）帳戶無法復原

`api/routers/auth.py` 只有五個端點：`register` / `login` / `logout` / `me` / `providers`。

- 沒有 email 驗證 → 可以用不存在的 email 註冊佔用名稱。
- 沒有忘記密碼 / 重設流程 → **email+password 是主登入途徑，忘記密碼即永久鎖死**。Google OAuth 是唯一旁路，而 OAuth 是選用的（`google_oauth_enabled` 預設 False）。
- 沒有帳號刪除（見 F-2）。

這是 SaaS 上線阻斷項。**若只做一件事，先做這個。**

最小可用版本：註冊時寄驗證信（`email-validator` 已在依賴裡，email 傳送需要一個 provider）＋ `/forgot-password` 產生單次 token ＋ `/reset-password` 消費。若 email 傳送基礎設施成本過高，至少先提供一條「聯絡管理員」的救援路徑，並在註冊頁明確告知——比什麼都不做然後使用者被卡住好。

#### F-2（P0）隱私政策承諾了不存在的功能

`api/routers/legal.py` 的 `_PRIVACY` 寫：

> You may request export or deletion of your account data.

但全專案**沒有任何 account export 或 delete 的 endpoint**（`auth.py` 已確認）。這不只是功能缺口——這是**公開承諾與實作的落差**，在歐盟 GDPR  territory 下是實際的法律風險。

**建議**（與 D-5 一起做）：

- `DELETE /api/account` → 密碼確認 → 級聯刪除 `users`（FK 已 `ondelete="CASCADE"` 串好 users → sessions / linked_accounts / team_members / user_settings），並處理 domain 表（`games` / `repertoires` 的 `owner_user_id` 沒有 FK 到 users，見 D-5 需要補）。
- `GET /api/account/export` → 打包 JSON（帳號、repertoires、訓練進度、分析摘要）。
- 兩者都要計入 `train_attempt_receipts` 的清理（它有 `session_id` 但沒 owner 欄位，見 D-8）。

#### F-3（P0）Terms of Service 的授權條款寫錯

`_TERMS` 寫「The software is open source under **GPL-3.0-or-later**」，但：

- `LICENSE` 第 1 行：`GNU AFFERO GENERAL PUBLIC LICENSE Version 3`
- `pyproject.toml`：`license = { text = "AGPL-3.0-or-later" }`

AGPL-3.0 與 GPL-3.0 是**不同的授權**，差異在於網路服務條款（AGPL 第 13 條）。在一份公開的法律頁上寫錯自己的授權條款，是需要律師確認的嚴謹度問題。

**建議**：改成 AGPL-3.0-or-later，並請律師審閱（ROADMAP P2 已列「Legal pages 需 formal review before paid launch」，這應該是 review 的第一個檢查項）。

#### F-4（P1）`PREPFORGE_TOKEN_KEY` 不在部署清單裡 → 照文件部署會開機失敗

`api/config.py:130` 的 `require_production_secret()`：

```python
if self.is_production and self.token_key == "dev-insecure-change-me":
    raise RuntimeError("PREPFORGE_TOKEN_KEY must be set ...")
```

這在 `create_app()` 開頭呼叫，而 `app = create_app()` 在 module level——所以是**匯入即崩潰**，不是第一個請求才崩潰。

但：

- `render.yaml` 的 `envVars` 清單裡**沒有** `PREPFORGE_TOKEN_KEY`（只有 `PREPFORGE_SECRET_KEY`）。
- `docs/DEPLOYMENT.md` 的必填環境變數表（第 32–42 行）裡也**沒有**。

結論：**任何照 `render.yaml` blueprint 或 `DEPLOYMENT.md` 環境變數表設定的人，部署到 production 會直接起不來**，錯誤訊息才會告訴他們缺什麼。

**建議**：把 `PREPFORGE_TOKEN_KEY` 加進 `render.yaml`（`sync: false`）與 `DEPLOYMENT.md` 表格（標為必填，說明用途是加密 linked-account OAuth token）。這是一個 5 分鐘的修正，卻擋住一次完整的部署失敗。

順帶：`render.yaml` 註解掉的 HF asset base 兩個變數也該在 `DEPLOYMENT.md` 對應（那邊有列，推薦級），保持兩份文件一致。

#### F-5（P1）Render proxy 下 rate limit 可能是全域共用一個桶

`Dockerfile` 的 CMD：

```
uvicorn ... --proxy-headers
```

`api/ratelimit.py` 的註解寫「Run uvicorn with --proxy-headers (Phase 3) so request.client.host reflects it」——但 **`--proxy-headers` 本身不夠**。uvicorn 的 `ProxyHeadersMiddleware` 只信任 `forwarded_allow_ips` 內的來源（`uvicorn/config.py:363` 實測預設值為 `"127.0.0.1,::1"`），Render 的 proxy 不是 localhost，所以 `X-Forwarded-For` 會被**忽略**，`request.client.host` 維持 proxy 的 IP。

**後果**：slowapi 的 `get_remote_address` 對所有使用者回傳同一個值 → 全站共用一個 rate-limit 桶。`/api/lichess/explorer/{db}`（120/min）、`/api/build/annotations`（60/min）、登入（10/min）都會變成「一個使用者用滿，全站被擋」。

**建議**：

1. 在 Dockerfile CMD 加 `--forwarded-allow-ips '*'`（Render 是可信的單一跳）或設定 `FORWARDED_ALLOW_IPS` 環境變數。
2. 更穩健的做法：`key_func` 改為優先取已驗證 session 的 user id，匿名請求才 fallback 到 IP。這樣 rate limit 對「登入使用者」自然變成 per-user，對匿名仍是 per-IP。
3. 加一個整合測試或在部署後用 `/healthz` 對照 `X-Forwarded-For` 實際生效一次。

**請務必先在 production 實測確認**（`curl` 一個本機 `/healthz` 帶上自訂 `X-Forwarded-For`，觀察 log 的 client host），因為這個結論是從 uvicorn 預設值推出的，實際 Render 拓撲可能已有 `FORWARDED_ALLOW_IPS` 注入。但無論結論如何，**明確寫出來**比留一個註解提到「Phase 3」安全得多。

#### F-6（P2）Scout 對 Lichess 429 沒有退避重試

`scout.js:1710,1738` 偵測到 429 就 `throw new Error(SCOUT_ERR_RATE_LIMIT)`，使用者看到一句「rate limited」。Lichess 的匿名公開 API 限制是每 IP 60/min、6000/hr；連續 scout 多個對手很容易觸發。

**建議**：

- 讀 `Retry-After` header，若有則在 UI 上顯示倒數並自動續傳（不是直接重試——要尊重伺服器的指示）。
- 若無 `Retry-After`，用指數退避（1s / 2s / 4s，上限 3 次），並在第 2 次起提示「Lichess 暫時限流，已在背景重試」。
- 把 `doFetch` 包一層共用的 retry policy，explorer / games / stream 三個端點共用。

#### F-7（P2）Scout 快取用「筆數上限」，大帳號會靜默失效

`scout.js:171-173`：

```js
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_CAP = 8;
```

快取存在 `localStorage`（`scout.js:1681`）。抓的是 NDJSON 且**保留原始 `clocks` 陣列**（註解說明需要 sub-second think time），一局棋的 NDJSON 含 `mainLine` + `clocks` 輕鬆 10–30 KB。200 局 ≈ 2–6 MB／個對手，8 個對手 ≈ 16–48 MB，**遠超 localStorage 約 5 MB 的 quota**。

而 `store.setItem` 被包在 `try {} catch (_) {}` 裡（`scout.js:1723`）→ `QuotaExceededError` 被吞掉 → **快取從來沒寫成功過，但沒有任何指標顯示這件事**。結果是每次 scout 都重新打 Lichess → 更容易再觸發 F-6 的 429，形成負向迴圈。

**建議**：

1. 改用 IndexedDB（專案已有 Maia 權重的 IndexedDB 快取 `maia3-weight-cache.js`，模式可直接沿用）。
2. 或保留 localStorage 但改為**容量驅動** eviction（序列化後量 `JSON.stringify(...).length`，超過 ~4 MB 就從最舊開始砍），並把「本週已省下 N 次 Lichess 請求」顯示在 Scout 結果頁——讓使用者看見快取在運作。
3. 兩者都該加一個「快取寫入失敗」的 console warn / clientlog 事件，讓這個失敗模式可觀察。
4. 順帶：只快取**衍生特徵**而不是原始對局資料（原始 `mainLine` 在特徵算完後就沒用了），體積可以降一個數量級。

#### F-8（P2）`train_attempt_receipts` 沒有 owner 欄位，阻礙帳號刪除

`api/models.py:213-219` 的 `train_attempt_receipts` 主鍵是 `(session_id, attempt_uuid)`，沒有 `user_id`。帳號刪除（F-2）時無法直接定位這個使用者的收據，只能靠 `training_sessions → repertoires → owner_user_id` 逐層 join，而已刪除的 session 會讓收據變成孤兒。

**建議**：加 `user_id` 欄位並 backfill（`user_id` 來自 session → repertoire 的 owner）。這是 F-2 的前置依賴，早做比較省事。

#### F-9（P2）Analyze 的 `classify-save` 是單一大 payload，失敗即全廢

`analyze.py:206` 的 `ClassifySavePayload` 接受最多 `MAX_ANALYSIS_POSITIONS` 個 position dict 加同樣數量的 `maia_assessments`。瀏覽器端算完整局再一次送出。中途失敗（行動網路斷線、tab 被關）就整段重算——而 Stockfish 跑了可能兩分鐘。

Build 與 Train 都有 local-first sync + 重試，Analyze 沒有，**三個流程的韌性不一致**。

**建議**：分段落盤——瀏覽器端每 N 手（建議 100 ply）打一次 checkpoint 端點（`POST /analyze/classify-save` 支援部分 payload + `partial: true`），最後一次才寫 `analysis_results` 摘要。中斷時恢復到最後一個 checkpoint。

---

## 5. 視覺效果

### 5.1 現況亮點

- 設計 token 完整且雙主題獨立調校：`--bg / --panel / --line / --accent / --danger / --warn / --good / --brilliant / --inaccuracy / --missed / --inert / --chip`，連棋盤座標都有專用變數（`--coord-on-light` / `--coord-on-dark`）。
- 深色主題是**重新調校**而非反相（註解明說），這是正確的做法。
- 動畫節制且有 `prefers-reduced-motion` 處理（6 處），且刻意保留「帶資訊的動畫」並註解原因——這是刻意的取捨，不是遺漏。
- 評估圖譜的 step-after 懸崖敘事 + 45–55% 平穩帶 + 形狀（虛線）而非顏色標示當前 ply，視覺設計成熟。

### 5.2 問題

#### V-1（P1）淺色主題多組語意色未達 WCAG AA — 本次最大視覺問題

我用 WCAG 2.1 相對亮度公式對 design token 逐一計算（附錄 D）。**淺色主題 9 組實測 FAIL**：

| 用途 | 前景 / 背景 | 比值 | 需求 | 判定 |
|---|---|---:|---:|---|
| `--label` 次要標籤（`styles.css` 22 處，10–12px） | `#8a8478` / `#ffffff` | **3.72** | 4.5 | FAIL |
| `--warn` badge 文字（replay-chip、train review 標題） | `#c98439` / 8% 底 | **2.84** | 4.5 | FAIL |
| `--good` badge 文字 | `#4a8964` / 12% 底 | **3.61** | 4.5 | FAIL |
| `--brilliant` 精妙標記 | `#2f7fe0` / `#ffffff` | **4.01** | 4.5 | FAIL |
| `--missed` 漏失標記 | `#8a6db5` / `#ffffff` | **4.26** | 4.5 | FAIL |
| `--accent` 當文字色 | `#d18b3f` / `#faf9f7` | **2.67** | 4.5 | FAIL |
| `--inaccuracy` 當文字色 | `#e0b15f` / `#ffffff` | **1.98** | 4.5 | FAIL |
| 棋盤座標（淺格） | `#786040` / `#f0d9b5` | **4.31** | 4.5 | FAIL |
| 棋盤座標（深格） | `#f7ecd8` / `#b58863` | **2.69** | 4.5 | FAIL |
| 使用者箭頭 vs 淺格 | `#c47c30` / `#f0d9b5` | **2.44** | 3.0 | FAIL |

**深色主題基本全部通過**（唯一 FAIL 是 `--line-strong` 2.59 作為邊框，屬非文字 UI 元素）。所以問題集中在淺色主題的語意色選值。

需要說明的兩點，避免誤判：

- `.btn.primary` 實際用的是 `--accent-dark`（`styles.css:1269`），白字對 `#8a4d17` = **6.66 通過**。所以「白字在琥珀色按鈕上看不清」**不是**問題——這個我特地驗過。
- `--inaccuracy` 目前可能只用於點/條的填色而非文字（填色不受 4.5:1 規範，屬 3:1 非文字 UI）。實際上線前應逐一確認哪些 token 有文字用途，避免為了修正一個沒用到的值而改壞視覺語言。

**建議**：我已算出各 token 達標所需的最小調整（附錄 E），例如：

| Token | 現值 → 建議 | 調整 | 調整後比值 |
|---|---|---|---|
| `--label` | `#8a8478` → `#79746a` | −12% 亮度 | 4.65 |
| `--warn` | `#c98439` → `#a16a2e` | −20% | 4.55 |
| `--good` | `#4a8964` → `#46815e` | −6% | 4.60 |
| `--brilliant` | `#2f7fe0` → `#2b75ce` | −8% | 4.63 |
| `--missed` | `#8a6db5` → `#8469ae` | −4% | 4.55 |
| `--accent`（文字用） | `#d18b3f` → `#9f6a30` | −24% | 4.59 |

`--warn` 與 `--accent` 的調整幅度較大，會明顯改變品牌暖琥珀的視覺性格。**建議做法**：新增一組 `--*-text` 變數（`--warn-text` / `--accent-text` / `--label-text`）只給文字用，保留原色給填色與邊框。這樣能達標又不犧牲視覺語言，代價是多一組 token。

`visual-system.test.js` 已經在驗證 REQUIRED_TOKENS 存在——**把對比度檢查加進這個測試**是自然的落點（把附錄 D 的計算 port 成 JS，斷言每個語意色對其背景達 4.5），如此後續新增 token 會自動被檢查。

#### V-2（P2）棋盤座標在兩種格色上都不足

座標是使用者辨認棋盤方位的主要線索，也是最常被忽略的可存取性點。淺格 4.31（差 0.19）、深格 2.69（差近 2 倍）。

深格要達標幾乎不可能靠「把字變亮」——`#f7ecd8` 已經很淺了。**可行方案**：座標加 1px 深色 text-shadow / outline（雕刻感反而更符合棋盤實體的視覺語言），或把座標移到棋盤框外（在 a11e 上更乾淨）。這是設計取捨，建議由設計決定後再實作。

#### V-3（P2）`styles.css` 8,085 行、28 個 `@media` 用 9 種不同斷點

斷點實際值：`520 / 560 / 600 / 640 / 680 / 720 / 760 / 1020 / 1100 / 960 / 959`。

問題不是斷點多，而是**沒有 token 化**：`640px` 出現 5 次、`720px` 4 次，而 `520/560/600` 三個值只差 20–40px卻各自對應不同的元件行為。在 610px 這個寬度，會有兩條規則同時生效或都不生效，取決於它們的 `min/max` 方向。

**建議**：定義 `--bp-sm: 640px` / `--bp-md: 800px` 兩個 token 並統一使用，順手把 `959/960` 這種互補對收斂成單一 `min-width: 960px`。同時把 `styles.css` 切成 `tokens.css` / `base.css` / `layout.css` / `components.css` / `views.css` 五個 partial（Vite 原生支援 CSS `@import`），讓 V-1 的 token 變更可以獨立 review。

#### V-4（P3）字級固定 14px，數字欄位未用等寬數字

`styles.css:56` 的 `font-size: 14px` 是 `:root` 級設定，這表示**使用者放大瀏覽器字級時，rem-based 的尺寸會跟著放大，但 px-based 的不會**——專案混用兩者會造成局部破版。

而 stats 欄（`#train-stat-correct` / `train-accuracy` / dashboard metrics / eval readout）都是會跳動的數字，用等寬數字（`font-variant-numeric: tabular-nums`）能讓數值變化時不左右抖動。

**建議**：(1) 檢查專案內 px / rem 的使用比例，若有明顯偏斜就統一到 rem；(2) 對 `.ts-value`、`.metric-value`、`.strength-readout`、eval readout 這類數字加上 `font-variant-numeric: tabular-nums`（一條 CSS 規則，四個地方受益）。

#### V-5（P3）`app.js:9212` 還有一處硬編碼色票

```js
const colors = ["#d18b3f", "#4a8964", "#b9722a", "#c4524d", "#e6c34a"];
```

這是全 `web-src` 非測試檔中**唯一**殘留的 6 位 hex 陣列（我掃過全部 `.js`）。移到 CSS 變數或加一個 lint 規則禁止 JS 檔出現 hex，這一項就收乾淨了。

---

## 6. 用戶體驗簡潔化

### 6.1 現況亮點

- Command palette（Ctrl+K）、skip link、`data-testid` 全面鋪設。
- Undo toast：破壞性操作先在 UI 生效，undo 視窗內零伺服器請求，離開前才 commit——這是很好的互動模型。
- 狀態列依 severity 分級，error 不自動消失。
- 空狀態即首次引導（Backend 依真實訊號排序，見舊 F3 已結案）。
- Maia 46MB 下載是 opt-in，且 Settings 說明清楚——把下載成本交給使用者決定是正確的。

### 6.2 問題

#### X-1（P1）頂欄在 375px 是主要的資訊密度問題

見 U-4。補充一個量化：`view-train` 靜態就有 **18 個 button、2 個 select、2 個 input**，其中 `train-setup` 同時呈現三種模式（Smart queue / Line rehearsal / Play vs human）＋ Blitz 開關＋ repertoire 下拉，`train-play-setup` 又疊在下面（雖然 `hidden`，但 DOM 與 tab 順序仍在）。

**建議**：

1. 訓練模式改成**分頁或下拉**而非三顆並列的 toggle button——三個模式是同一個概念的三個值，用 `role="tablist"` 或 radio group 語意會比三顆 `is-active` 的 button 更清楚（也讓螢幕閱讀器知道這是「選擇」不是「三個動作」）。
2. 確認 `hidden` 的 panel 真的不在 tab 順序中（`hidden` 屬性預設會從 tab 順序移除，但要確認沒有用 CSS `display:flex` 覆蓋掉 `[hidden]`——這是經典 bug，建議加一個回歸測試）。
3. 375px 下把次要 tab 收進「⋯」。

#### X-2（P1）三種訓練模式的差異對新使用者不可見

`Smart queue` / `Line rehearsal` / `Play vs human` 三顆按鈕**沒有任何說明文字**。新使用者無法在不試玩的情況下知道該選哪個。而這三個模式對應的訓練行為差異很大：

- Smart queue：跨 repertoire 的 SRS 排程（預設，正確選擇）
- Line rehearsal：單一 repertoire 順序複習
- Play vs human：對著 Lichess explorer / 自己的 repertoire 下一盤

**建議**：在模式選擇旁加一行 `title` / 一個 `ⓘ` popover，或在選中後於 banner 顯示一句「你正在用 SRS 排程：最急的卡優先」——讓使用者在**當下**理解系統在做什麼。`index.html` 的 `train-help` details 已經解釋了五種卡牌狀態，內容是好的，問題只是**發現成本太高**（要展開才知道）。

#### X-3（P2）錯誤訊息沒有重試入口

`setStatus`（`app.js:2826`）是一個純文字狀態列。分析失敗、PGN 匯入失敗、Build 同步失敗——使用者看到一句話，然後要自己判斷「現在該做什麼」。

`toast` 系統其實**已經有 actions 機制**（`Toast` 類別的 `actions` 陣列，Undo toast 就在用），`setStatus` 卻沒有複用它。

**建議**：讓可重試的錯誤走 toast + 「Retry」按鈕（重用既有 `Toast.actions`），不可重試的留在 status 列。長任務（分析、匯入）的進度與失敗也應該留在畫面上直到使用者關閉——目前非 error 訊息 6 秒自動消失是對的，但**長任務失敗不該自動消失**，而這點程式已經做對了（`closeBtn.hidden = !isError`，error 不掛 timer）。所以只需要補「Retry 動作」。

#### X-4（P2）Scout 的錯誤文案沒有說明「下一步」

`SCOUT_ERR_RATE_LIMIT` 拋出後，使用者看到「rate limited」但不知道要等多久、能不能重試、資料是不是白抓了。F-6 的修正會一併解決這個（倒數 + 自動續傳 + 背景重試提示）。

#### X-5（P2）沒有 i18n，且中文使用者的字型環境未考慮

全專案字串硬編在 `index.html` 與 JS 中（`grep i18n` 僅 `scout-stats` 命中，且那是數字格式化不是翻譯）。`font-family` 是 `"Inter", "Segoe UI", ui-sans-serif, system-ui, -apple-system, sans-serif`——**沒有 CJK fallback**。

這代表：即使現在只服務英文使用者，系統預設語言若是中文，瀏覽器仍會用 `sans-serif` fallback 渲染 UI 中的任何非 ASCII 字元（目前有 `&middot;` `&rarr;` `&#8943;` `&ldquo;` 等符號，會落到系統字型）。在 Windows 上這會是微軟正黑體，在 macOS 上是苹方，兩者都不是 Inter 的設計語言。

**建議**（分兩階段）：

- **短期（半天）**：在 `font-family` 後加 CJK 栈（`"Noto Sans TC", "PingFang TC", "Microsoft JhengHei", "Noto Sans CJK TC"`），成本極低、零風險。同時把 `&middot;` / `&rarr;` / `&#8943;` 這些 entity 換成 SVG icon 或 CSS 偽元素，避免字型依賴。
- **長期**：若目標市場含中文圈，抽出 string catalog（先 en + zh-TW）。這是較大的工程，不建議在產品驗證前投入。

**注意**：本報告本身假設了繁體中文讀者能接受這個專案的介面是英文。若產品定位是國際市場，X-5 長期項可以再擱置。

#### X-6（P2）Dashboard 的「今日」卡片與推薦卡片資訊重疊

`index.html` 有 `dashboard-today`（每日 recap 卡片）與後端回的 `recommendations` 兩個區塊。當使用者有 due reviews 時，兩者都在講同一件事（「今天有 5 張卡到期」）。

**建議**：當 `recommendations[0].id === "train-due"` 且 `due_reviews > 0` 時，合併成單一卡片，recap 專注在「這一週你做了什麼」，推薦專注在「現在該做什麼」。資訊架構上，**「狀態」與「行動」是兩件事，不該搶同一個位置**。

#### X-7（P3）空狀態已經很好，但缺少「完成」的慶祝

空狀態的引導做得好（有真實訊號驅動的 next actions）。但反方向——使用者第一次完成一次訓練 session、完成 5 張 master、連續 7 天 streak——除了 `streakPop` / `confetti` 動畫之外，沒有**持續的、非彈出式的**成果可見性。

`health_json` 快取已經存在於 `repertoires`（`a1b2c3d4e5f6_repertoires_health_json_cache`），dashboard 也有 `weekly_recap` 快照。資料都在，缺的是呈現。

**建議**：在 Dashboard 加一條低調的進度軌（例如「本週：練了 42 張 · 8 張首次答對 · 3 張從 weak 升為 mastered」），資料已由 `_weekly_recap` 提供，只需要呈現。**這是留存成本最低的提升**，因為它完全建立在既有資料上。

---

## 7. 跨領域：工程衛生

> 這些不屬於六個範疇中的任一個，但會影響所有改進的速度。

#### E-1（P1）53 個殘留 git worktree，佔 7.4 GB

`git worktree list` 回報 53 個 worktree，`.claude/` 目錄 7.4 GB。這些是 agent 迭代的產物（`.gitignore` 已忽略 `.claude/`，所以不影響 repo 乾淨度，但影響**本機**）。

影響：`rg` / `grep` 預設會掃到它們（我在本次審查中就誤讀了 worktree 內的舊版 `repositories.py` 直到加了路徑過濾）；備份、同步、磁碟掃描都被拖慢；且**舊版原始碼躺在磁碟上**有讓後續 agent 或人讀到舊程式碼的風險（本次就發生了）。

**建議**：`git worktree prune` + 刪除 `.claude/worktrees/`。一次性五分鐘，之後每次 agent 迭代結束就清。

#### E-2（P2）主 bundle 預算使用率 99.7%，gate 即將失效

`src/prepforge_chess/web/static/assets/` 現況：

| 資產 | 大小 | gate 上限 | 使用率 |
|---|---:|---:|---:|
| `index-*.js` | 298,033 B | 299,000 B | **99.7%** |
| `index-*.css` | 152,741 B | 154,000 B | **99.2%** |

`scripts/check-bundle-size.mjs` 的 header 註解除了「intentional a11y growth, not a loosened gate」——那個判斷當時是對的，但**現在的狀態是任何一個小功能都會觸發紅燈**，而團隊在連續被 gate 紅幾次之後的反應幾乎必然是「再調高一點」。那時 gate 就真的失效了。

**建議**：

1. 先做 U-1（抽 `ToastStack` 等），把主 chunk 實際降下來——這會創造預算空間。
2. 在預算有餘裕後，把上限定在「當前值 + 5%」而非逼近現值。
3. 考慮加一條**預警線**（例如 90% 時 warn 但不 fail），讓接近上限是可見的而非突然的。

`scout-*.js` 196 KB 是 lazy chunk，不影響首載，無需處理。

#### E-3（P2）Scout 研究程式碼仍與 production 共處 `web-src/`

`engineering-health-state-map.md` 已記錄：v15 / shadow-prep / census / harness 系列「無 app runtime import path，但尚未被正式宣告為目錄隔離的研究碼」。實測這些檔案合計逾 10,000 行：

`scout-v15-study.js` (1,864) + `scout-shadow-prep-p0.js` (1,322) + `scout-ref-df-census.js` (1,096) + `scout-v13-*` (2,635) + `scout-bias-*` (1,354) + `scout-route-audit.js` (488) ≈ 8,759 行。

**影響**：(a) 認知負擔——維護者要在 130+ 個檔案的目錄裡找「哪個是真的」；(b) `visual-system.test.js` 之類的全目錄掃描測試會掃到它們；(c) 未來若有人寫錯 import 路徑就會把研究碼拖進 production bundle。

**建議**：把這些移到 `research/`（該目錄已有 `vitest.research.config.mjs` 與 `npm run test:research` 的既有基礎設施），v12 這類已退役的直接刪除。`engineering-health-state-map.md` 說這需要「explicitly authorized source move」——**這份報告就是那份授權**。

#### E-4（P3）9 個除 migration 外的資料庫檔案留在 repo 根目錄

`dev.sqlite3` / `release.sqlite3` / `ci_alembic_multi.sqlite3` / `health_alembic.sqlite3` / `layout-verify.sqlite3` / `scout-v14-e2e.sqlite3` 等，已被 `.gitignore` 的 `*.sqlite3` 忽略（不影響 repo），但放在根目錄會與 `analysis_test.pgn`、`verification-results.json`、`coach-review-ratings.json` 等散落檔案一起增加「什麼是這個專案的檔案」的辨識成本。

**建議**：移到 `tmp/local/`（已 gitignore），並在 `.gitignore` 加一行 `/tmp/local/`。

---

## 8. 建議執行順序

我按「投入 × 收益 × 風險」排了順序，而不是按嚴重度。理由是：D-2（hydrate 優化）是一個函式的改動卻能讓 Build 載入、repertoire 列表、訓練每一步同時受益；A-4（跨語言 golden 測試）是一小時的工作卻保護產品最核心的正確性。這兩件事應該先做，而不是先做 P0 的 F-1。

### 第一輪：低風險高收益（本週可完成）

| # | 項目 | 位置 | 預期收益 |
|---|---|---|---|
| 1 | **D-2** hydrate 改單 board push/pop | `codec.py:284` | 2000 節點 247→69 ms（實測 3.6×）；Build 載入 / 列表 / 訓練全受益 |
| 2 | **A-4** 跨語言分類 golden 測試 | 新增 `tests/test_classification_crosslang.py` | 1 小時，保護核心正確性 |
| 3 | **F-4** `PREPFORGE_TOKEN_KEY` 補進 render.yaml + DEPLOYMENT.md | 2 個檔案 | 擋住一次完整的部署失敗 |
| 4 | **F-3** Terms 的 GPL → AGPL | `legal.py` | 法律頁事實正確 |
| 5 | **E-1** 清理 53 個 worktree / 7.4 GB | git | 一次��；避免後續 agent 誤讀舊碼 |
| 6 | **V-5** 移除 `app.js:9212` 硬編 hex + lint 規則 | 1 行 + eslint | 視覺 token 收乾淨 |

### 第二輪：資料庫與訓練正確性（1–2 週）

| # | 項目 | 說明 |
|---|---|---|
| 7 | **D-1(a)** repertoire 短 TTL 快取 | 一天的改動，D-2 做完後收益更大 |
| 8 | **A-1** SRS 改乘法間隔 + 上限 30 天 | 需 `scoring_version` 欄位處理既有進度 |
| 9 | **A-2** `effective_accuracy` 統一三處實作 | 消除 weak 排擠 due/new 的結構性問題 |
| 10 | **A-3** polish 保底份額 + `new_cap` 自適應 + 「還剩幾張新卡」顯示 | 讓訓練排程可被使用者理解 |
| 11 | **D-3** dashboard 移出寫入 | 恢復純讀端點 |
| 12 | **D-4** `idx_training_progress_due` + 文件化時間型別規則 | 止住「慢慢變慢」的性能退化 |

### 第三輪：可存取性與視覺（2–3 週）

| # | 項目 | 說明 |
|---|---|---|
| 13 | **V-1** 新增 `--*-text` 語意文字色變數 | 保留填色色、加文字色，達標不傷品牌；**把對比度檢查加進 `visual-system.test.js`** |
| 14 | **V-2** 棋盤座標對比 | 需設計決策（shadow / 移出棋盤） |
| 15 | **V-3** 斷點 token 化 + CSS 拆 partial | |
| 16 | **X-5 短期** CJK font fallback + entity 換 icon | 半天 |
| 17 | **X-1 / X-2** 訓練模式語意化 + 模式說明 | |

### 第四輪：上線阻斷項（產品驗證前必須）

| # | 項目 | 說明 |
|---|---|---|
| 18 | **F-1** email 驗證 + 忘記密碼 | 上線阻斷 |
| 19 | **F-2 + D-5 + F-8** 帳號匯出/刪除 + GC job + `user_settings` 改 `Text` | 同一次 migration 群組做完最省事 |
| 20 | **F-5** 確認並修正 forwarded-allow-ips | **先實測確認**，再決定修法 |
| 21 | **F-7 / F-6** Scout 快取改 IndexedDB 或容量驅動 + 429 退避重試 | 兩者有因果關係，一併做 |
| 22 | **F-9** Analyze 分段 checkpoint | 與 Build/Train 的 local-first 體驗一致 |

### 可隨維護節奏做

- **U-1** 續拆 `app.js`（先 `ToastStack`，再 `BoardController`）
- **U-3** 設定頁資訊分層
- **E-2** bundle 預算（在 U-1 之後才有空間）
- **E-3** Scout 研究碼遷移
- **D-6** 評估去重 key
- **A-5 / A-6** enum 收斂與版本常數
- **X-3 ~ X-7** 錯誤重試、Dashboard 卡片合併、進度軌

---

## 9. 結語

這個專案最值錢的資產是**一致性紀律**：同一組閾值在前後端互相錨定、schema 由 Alembic 獨裁、CSP 用 hash 而非放行 `unsafe-inline`、wheel 結構性排除 ONNX、Brilliant 閾值用 feature AUC 選出來並記錄了被放棄的選項。上一輪審查的 P1 項目（鍵盤走棋、圖表主題色與 tooltip、axe gate、PostgreSQL 驗證）這次複驗**全部已結案**——團隊在兩天內清掉了那份清單。

因此本報告的新發現集中在幾個**性質不同**的類型：

1. **量得起來的效能浪費**（D-1、D-2）：不是「可能會慢」，是「實測 247 ms／次，其中 71% 花在 FEN 字串上，而且原型已證明能降到 69 ms」。
2. **文件與實作的落差**（F-2、F-3、F-4）：隱私政策承諾了不存在的功能、服務條款寫錯自己的授權、部署清單少了一個必填變數而照做會開機失敗。這三項都是零成本的修正，卻都是會真實傷害使用者的。
3. **設計值沒有被驗證**（V-1）：token 系統做得很完整，但完整度不等於達標——9 組淺色主題配色實測不過 WCAG AA。
4. **失敗模式不可觀察**（F-7、D-5、N11）：localStorage 配額溢出被 `catch` 吞掉、評估列變孤兒、使用者無法刪除自己的資料——這三件事發生時**沒有任何指標**會告訴你。

如果只能做一件事，我會選 **D-2**：它是一個函式的改動、有 golden fixture 保護、風險接近零，卻同時讓 Build 載入、repertoire 列表和訓練的每一手都變快三倍以上。

---

## 附錄：量測方法

本次所有數字都是本機實測，可重現。腳本放在 `tmp/`（已 gitignore）。

### 附錄 A — 訓練熱路徑 statement 與延遲

方法：以 SQLAlchemy `event.listen(engine, "before_cursor_execute")` 計數 statement，`time.perf_counter()` 計時，2000 節點 repertoire（`scripts/build-db-benchmark.py` 的 `make_tree` 同一手法），中位數取 3 次。

```
load_repertoire: 2 statements, 248.6 ms
load_repertoire: 2 statements, 245.6 ms
smart/start:    5 statements, 255.2 ms
submit_move:    median 4 statements, median 252 ms
```

### 附錄 B — hydrate 的 cProfile 歸因

方法：對 `repo.load_repertoire()` 跑 3 次後 `cProfile` + `pstats`（cumulative 排序）。

關鍵列（完整輸出見 `tmp/audit_hydrate_profile.py`）：

```
5997 calls  1.876s cumulative  replay_uci          (75%)
12000 calls 1.145s cumulative  chess.Board.__init__ (每節點 2 個)
11997 calls 1.034s cumulative  chess.Board.fen      (每節點 2 次)
11982 calls 0.985s cumulative  _set_board_fen       (39%)
11997 calls 0.822s cumulative  board_fen            (32%)
5997 calls  0.149s cumulative  Board.san            (6%)
```

`_set_board_fen` + `board_fen` = 71% 純 FEN 字串處理。

### 附錄 C — push/pop 原型對照

方法：以相同的 `nodes` dict 與 `arriving_uci` dict 餵給現行 `codec.hydrate_opening_tree` 與一個 push/pop 原型（`tmp/audit_hydrate_proto.py`），取 3 次中位數。

```
current (replay_uci)        246.7 ms
push/pop                    69.3 ms
```

兩者輸出 `root.fen` 相同。**注意：這是量測原型，不是建議的實作**——正式實作仍應以 `replay_uci` 的輸出契約（`MoveRecord` 的 `fen_before` / `ply` / `move_number` / `engine_eval_after`）為準做完整對齊，並讓既有 golden fixture 通過。

### 附錄 D — WCAG 對比度計算

方法：WCAG 2.1 相對亮度 `L = 0.2126R + 0.7152G + 0.0722B`（sRGB → linear），比值 `(L1+0.05)/(L2+0.05)`。以 `styles.css` 的 token 實際值為輸入（`tmp/audit_contrast.py`、`tmp/audit_contrast2.py`）。tinted 底色以 `color-mix(in srgb, C 12%, --panel)` 的等價結果計算。

### 附錄 E — 達標所需調整值

方法：對每個失敗 token 以 2% 步長嘗試明度縮放，取第一個達 4.5:1 的候選（`tmp/audit_contrast_fix.py`）。輸出見 V-1 表格。

**注意**：`--coord-on-dark` 與 `--inaccuracy` 的自動解（分別需要 −82% 與 −36% 明度）在視覺上不可接受，這兩項需要設計決策而非機械調整。
