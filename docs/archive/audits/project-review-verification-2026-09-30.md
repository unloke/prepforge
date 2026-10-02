# PrepForge Chess 專案完整檢查報告（驗證版）

- 日期：2026-09-30
- 分支：`fix/ux-walkthrough-2026-09-30`，HEAD `e4c58ad`
- 範圍：UI、資料庫互動、演算法處理、功能設計、視覺效果、UX 簡潔化
- 性質：**只做報告，未修改任何產品程式碼**（僅新增 `tmp/diag-lib.mjs` 診斷腳本與本報告）
- 對象：重新核對 `docs/project-review-followup-2026-09-29.md`（R/D/A/F/U/V 系列）與 `docs/project-review-current-2026-09-30.md`（R/D/A/U/E/V 系列）兩份舊審查，並對目前程式碼逐項驗證

---

## 1. 摘要

### 1.1 整體結論

專案主體狀態良好：後端 689 測試全綠（12 skipped、5 deselected），前端 121 檔 / 1752 測試全綠，UI-v2 smoke **7/9** 通過。兩份舊審查報告的多數高優先項目已修復並驗證（詳見第 3 節），但仍有 **6 項開放問題**（含 4 項 P1），以及 **2 項本次新發現的迴歸**（皆為 UX walkthrough 修復波引入，直接導致 smoke 從 8/9 落到 7/9）。

### 1.2 優先順序一覽

| 優先 | 編號 | 問題 | 面向 |
|---|---|---|---|
| P1 | N-1 | Library smoke 全 viewport 失敗：`hydrateBuild` 汙染 `appState.build` 後 `syncViewHeads` 擲未捕獲 TypeError | UI / 錯誤韌性 |
| P1 | D-01 | 前端從不送 `base_revision`，樂觀鎖 409 衝突偵測永不觸發 | 資料庫互動 |
| P1 | F-01 | 忘記密碼重設郵件只有 `print()`，生產環境使用者收不到信 | 功能設計 |
| P1 | F-02 | `AuthSession` 無 `expires_at`，閒置 session 永不过期 | 功能設計 / 安全 |
| P1 | R-05 | outbox entry 無建立時間，`OFFLINE_RETRY_DAYS=30` 無法執行 | 資料庫互動 |
| P1 | R-02 | `mergeById` 實作 base 優先，與「incoming wins」文件矛盾 | 資料庫互動 |
| P2 | N-2 | Train smoke 全 viewport 失敗：setup 狀態 `#train-board-label` 空白 | UX 簡潔化 |
| P2 | A-01 | mixed session 逐 repertoire 向上取整，會突破全域 `session_size` 上限 | 演算法處理 |
| P3 | D-03a | `position_map` 對 duplicate FEN 靜默覆寫（有害路徑已被服務層攔截） | 資料庫互動 |

### 1.3 建議實施順序

1. **N-1**（修 `hydrateBuild` 驗證 + `syncViewHeads` 守衛）→ smoke 回到 9/9
2. **N-2**（補 setup 狀態的非冗餘 board label，或更新 smoke 契約）
3. **D-01**（前端送 `base_revision`，409 時走衝突 UI）
4. **F-01 / F-02**（接真實郵件寄送；session 加 `expires_at` 並於請求時檢查）
5. **R-05 / R-02**（outbox entry 加時間戳並落實 30 天重播上限；修正 `mergeById` 衝突方向）
6. **A-01**（mixed session 改為全域 budget 先算再分配，而非逐 rep 獨立取整）

---

## 2. 方法與驗證紀錄

### 2.1 執行結果

| 檢查 | 結果 |
|---|---|
| `npm test`（前端 vitest） | 121 檔 / 1752 測試全過（5.44s） |
| `.venv/Scripts/python.exe -m pytest -q`（後端） | 689 passed, 12 skipped, 5 deselected（112.74s） |
| `npm run smoke:ui-v2`（9 支 viewport smoke） | **7/9**：Library、Train 失敗，其餘 7 支（Repertoire/Games/Scout/Analyze/Teams/Settings/States）全過 |

### 2.2 smoke 失敗明細（新迴歸，詳見第 5 節）

- Library：3/3 viewport（desktop-1440 / laptop-1180 / mobile-390）`pageerror: Cannot read properties of undefined (reading 'filter')`
- Train：3/3 viewport `board label should be non-empty`（`#train-board-label` 為空字串）

### 2.3 驗證手段

- 以 bash `grep`/`sed`/`git show`/`git diff` 對照源碼與歷史提交（`code_search` 工具在本環境故障，改用 grep）。
- 以臨時 Playwright 診斷腳本（`tmp/diag-lib.mjs`，未納入測試套件）複製 Library smoke 的 fixture 伺服器並印出完整錯誤堆積，確認 `.filter` 拋錯點落在建置後 bundle 的 `syncViewHeads`（對應源碼 `web-src/app.js:3855-3872`）。
- 逐項重讀舊報告所列檔案位置，對目前 HEAD 重新核對。
- 證據邊界（與舊報告相同）：完整中斷/E2E、多分頁真實交錯、正式 DB 量測無法在本環境完成。

---

## 3. 已修復項目（重新驗證通過，不再列為問題）

以下舊報告項目經對目前程式碼逐項核對，**確認已修復**：

| 舊編號 | 項目 | 驗證證據 |
|---|---|---|
| 09-30 R-01 | outbox settled tombstone 會合併累積 | `web-src/sync-outbox.js` `mergeOutboxState` 對 settled 做聯集（base.settled ∪ settled），confirmed settled 不再复活 |
| 09-29 R-01 / 09-30 R-01 | rejected 永久保留 | `safeParse` 註解與實作：rejected 僅保留供檢查/匯出，永不靜默丟棄 |
| 09-29 A-01 / 09-30 A-01 | mastery/weak 矛盾 | `services/progress.py` `node_mastery`：weak 需同時滿足 ratio<0.5 且 score<`WEAK_SCORE_BELOW`，且有近期恢復邏輯；scheduler `recent_score` 註明同一訊號 |
| 09-29 A-02 | 有效分支計算 | `services/progress.py` `walk_effective`/`effective_children` 共用；`services/scheduler.py` `_collect_candidates` 剪除 disabled 子樹 |
| 09-29 F-01 | 分享連結撤銷/輪換/期限 | `api/routers/workspace.py`：`create_share_link`/`rotate_share_link`/`revoke_share_link` + `_share_link_live` 檢查 |
| 09-29 D-03 | 分析輸入驗證 | `api/routers/analyze.py` `validate_position_payload`：非數值 score、畸形 PV/UCI、越界 depth/nodes/mate、非物件項目皆回可讀 400，且在任何寫入之前 |
| — | generated_comment 與原註解分離 | `storage/repositories.py` moves 注解含獨立 `generated_comment`/`generated_meta` 欄位 |
| — | health 列表 live due SQL | owner-scoped recursive CTE 查詢 |
| 09-30 D-03「重複儲存」 | analyze route 雙寫 | **誤報**：`save_game_batched` 只寫 games/moves/evals（`repositories.py:598-642`），`save_analysis_result` 寫 `analysis_results` 表（`repositories.py:1925`），兩者互補（後者供 Analyze History 列表），非重複寫入 |

---

## 4. 仍開放的問題

### D-01（P1）前端從不送 `base_revision`，樂觀鎖形同虛設

- 證據：`grep -rn base_revision web-src/`（排除測試檔）**零命中**；後端 `api/routers/workspace.py:75` `_check_base_revision` 存在但客戶端永不送 `base_revision`，409 衝突分支永不觸發。
- 影響：多分頁/多裝置編輯同一 repertoire 時，後寫者靜默覆蓋先寫者，使用者無衝突提示。local-first 同步（R-02/R-04）的伺服器端安全網未接線。
- 建議：build flush 請求帶上本次 hydrate 時的 `revision`；收到 409 時走「重新拉取 + 本地 op 重放」的衝突流程（outbox 已有 reconcile 基礎）。

### F-01（P1）忘記密碼重設郵件只有 `print()`

- 證據：`api/routers/auth.py:319`（`print(`）與 :374-378，重設連結僅印到伺服器終端機。
- 影響：生產環境使用者忘記密碼時完全無法自救（除非管理員手動看日誌），是功能性區塊。
- 建議：接 SMTP/郵件服務（SendGrid/Postmark/Resend 皆可），`print` 僅保留為非產生環境的 dev fallback。

### F-02（P1）`AuthSession` 無 `expires_at`，閒置 session 永不过期

- 證據：`api/models.py:258` `AuthSession` 無 `expires_at` 欄位；`session_ttl_days=30` 只在登入時 `_purge_expired`（`auth.py:84,116`）清理；`api/deps.py` `current_user_optional` 每請求只刷新 `last_seen_at`（每 5 分鐘），**不檢查閒置過期**。
- 影響：30 天 TTL 實際上只在「再次登入」這個時點才會觸發清理；已發出的 session 在閒置超過 30 天後仍然有效，與宣告的 TTL 语义不符。
- 建議：session 表加 `expires_at`（或 `last_seen_at + ttl` 計算），`current_user_optional` 請求時檢查並拒絕過期 session。

### R-05（P1）outbox entry 無建立時間，離線重播上限無法執行

- 證據：`services/data_lifecycle.py:39-40` 定義 `OFFLINE_RETRY_DAYS = 30`、`RECEIPT_RETENTION_DAYS = 90`（且有 `assert RECEIPT_RETENTION_DAYS > OFFLINE_RETRY_DAYS` 合約守衛），但 `web-src/sync-outbox.js` 的 `emptyOutbox()`/`safeParse()`（:44-77）顯示 entry 結構只有 pending/pendingDeletes/idMap/rejected/settled，**無任何 per-entry 時間戳**（唯一 `at: now` 在 :289，是整把 localStorage 寫入時間，非 entry 時間）。
- 影響：30 天重播上限與 90 天 receipt 保留期在客戶端無法落實——離線一個月的 op 會永久重播，receipt 清單也無法按時間清理。
- 建議：entry 寫入時加 `queued_at`；reconcile/flush 時跳過超過 `OFFLINE_RETRY_DAYS` 的 entry 並轉入 rejected（附原因）；settled/rejected 按時間裁剪。

### R-02（P1）`mergeById` 衝突時 base 優先，與文件矛盾

- 證據：`web-src/sync-outbox.js:126-142`：先推入所有 base entry，再只補「id 未見過」的 incoming entry——同 id 衝突時 **base（stored）勝**。但 `mergeOutboxState` 文件註解（:157-160）明寫「Union per operation, **`incoming` wins on conflict**」。
- 影響：多分頁交錯時，較舊的 stored op 會壓過較新的 in-memory op，與文件承諾相反；屬於資料正確性問題（雙寫情境下可能丟失較新的刪除/新增）。
- 建議：依設計意圖改為 incoming 優先（同 id 時用 incoming 覆蓋 base entry），或若 base 優先才是本意則修正文件註解；並補一對多分頁交錯的單元測試鎖定行為。

### A-01（P2）mixed session 逐 repertoire 向上取整，突破全域 session 上限

- 證據：`services/training_smart.py:280-307`：`per_size = max(2, -(-total_size // len(reps)))`、`per_new = max(1, -(-total_new // len(reps)))`——對每個 repertoire **各自** ceiling。例：7 個 repertoire、`session_size=12` → per_size=2 → 混成最多 **14 題**（>12）。
- 影響：session 長度隨 repertoire 數線性膨脹，使用者點「Start」得到的隊列比承諾的 12 題長；`sessionPreviewText`（`web-src/views/train.js:16-30`）顯示的預估也會失真。
- 建議：改為先算全域 budget 再按 urgency 分配（如 floor + 餘數輪發），或於 `mix_plans` 後截斷到 `total_size`。

### D-03a（P3）`position_map` 對 duplicate FEN 靜默覆寫

- 證據：`api/routers/analyze.py:325-327`：`for item in validated: position_map[item["fen"]] = item`——同一 FEN 出現兩次時後者無聲覆蓋前者。
- 緩解：`classify_precomputed_game` 對矛盾的 duplicate 評估會拋 `PositionPayloadError` → 路由回 400（`analyze.py:360-364`），有害路徑已被服務層攔截。
- 建議：改為偵測 duplicate FEN 即拋錯（把攔截提前到驗證階段），避免「先覆寫再拋錯」的双段邏輯。

---

## 5. 新發現的迴歸（UX walkthrough 修復波引入，兩份舊報告均未涵蓋）

### N-1（P1）Library smoke 3/3 viewport 失敗 — 未捕獲 TypeError

- 現象：`pageerror: Cannot read properties of undefined (reading 'filter')`，desktop-1440 / laptop-1180 / mobile-390 全失敗；其餘所有斷言（3 列渲染、today 卡、mastery bar、鍵盤操作、無橫向溢出）皆通過——純為 console 錯誤。
- 根因鏈（以診斷腳本完整堆積確認）：
  1. 點選 Library 列 → `editRepertoire`/`loadRepertoire`（`web-src/app.js:5740-5776`）→ `api('/api/build/load?repertoire_id=...')`。
  2. 當回應是 200 但 payload 缺 `nodes`（malformed / 錯誤形狀）時，`hydrateBuild`（`app.js:7117-7162`）**先** `appState.build = payload`（:7144），**再** `new Map(payload.nodes.map(...))`（:7145）→ 擲 TypeError。
  3. catch 路徑呼叫 `setBuildLoading(false)`（`app.js:5771`），其 restore 分支呼叫 `syncViewHeads()`（`app.js:5806`）。
  4. `syncViewHeads`（`app.js:3855-3872`）此時讀 `build.nodes.filter((n) => n.depth > 0)`（:3863）——`appState.build` 已被汙染為缺 `nodes` 的 payload → **第二段 TypeError 發生在 catch 區塊內，未被捕獲** → pageerror。
- 引入提交：`eec2faf`（「Repertoire view opens NOW with a skeleton」）。舊版 `editRepertoire`（`eec2faf~1`）的 catch 只呼叫 `setStatusError`，不會觸發 `syncViewHeads`，故 smoke 先前通過。
- 影響：任何 malformed 的 build/load 回應（代理錯誤頁、未來 API 變形、200-with-error-body）都會讓未捕獲錯誤逃到介面；`countBuildMovesToTrain`（`app.js:3880+`）同樣假設 `build.nodes` 存在。
- 建議：`hydrateBuild` 驗證 payload 形狀（缺 `nodes`/非陣列時拋乾淨的「Could not load repertoire」錯誤，且**在**賦值前驗證）；`syncViewHeads`/`countBuildMovesToTrain` 守衛 `(build.nodes || [])`；catch 路徑避免帶著汙染狀態呼叫會讀 build 的函式。

### N-2（P2）Train smoke 3/3 viewport 失敗 — setup 狀態 board label 空白

- 現象：`#train-board-label` 為空字串，三個 viewport 皆失敗於 `board label should be non-empty`。
- 根因：`0e9d2ff`（「fix(analyze,train,coach): coherent coach prose and Analyze/Train UX fixes」，UX P2-10「Press Start 只說一次」）做了三處清空：
  1. `web-src/index.html:330`：靜態標籤 `>Press Start to train<` → `><`（初始內容清空）。
  2. `web-src/app.js:10311` `resetTrainBoardIdle`：fallback `label || "Press Start to train"` → `label || ""`。
  3. `web-src/app.js:14032` mode-tab 處理器：`resetTrainBoardIdle("Press Start to train")` → `resetTrainBoardIdle("")`。
  - 結果：進入 Train 檢視（setup 狀態）時，**無任何程式碼路徑設定該標籤**（`renderTraining`/`paintPlayPosition`/`startTraining` 都只在 session 啟動後才寫），標籤永久空白。
- 性質判斷：**設計意圖與 smoke 契約衝突**，兩邊都有道理：P2-10 的去冗餘方向正確（「Press Start」確實由 Start 按鈕自身承擔），但 board label 在 setup 狀態連「目前是哪個 repertoire / 棋盤上是什麼位置」這類非冗餘資訊也一併消失。smoke 斷言（標籤不應空白）codify 的是舊契約。
- 建議（二選一）：
  - A（推薦）：setup 狀態給**非冗餘**標籤——選取的 repertoire 名稱或「Starting position」，既不去冗餘也不留白；
  - B：若確定留白是設計，更新 `train-viewport-smoke.mjs` 的斷言為「banner 為 Ready to train 且標籤可為空」。

---

## 6. 六大面向逐項評估

### 6.1 UI

- 優點：9 支 viewport smoke 覆蓋 1440/1180/390（Analyze 另加第四檔），全部斷言無橫向溢出；Library 錯誤卡、空狀態（`empty-state big` + 設定步驟）、「Get started」三歩檢查清單（依真實狀態打勾）組成良好；棋盤與側邊欄在 860px 以上維持並排（`4678966`）。
- 問題：N-1（malformed 回應時未捕獲錯誤）、N-2（setup 標籤空白）；Library 列點擊後的 skeleton（`setBuildLoading`）在失敗時會帶著汙染狀態重繪（见 N-1 根因鏈第 3 步）。
- 改進：除錯誤韌性外，可考慮為 build/load 失敗提供 scoped error card（與 Library 列表錯誤卡同層級），而非僅 status 文字。

### 6.2 資料庫互動

- 優點：owner-scoped 查詢普遍且到位——`load_game(owner_user_id=...)` 無 IDOR、`claim_or_verify_game` 擁有權門檻、health 列表用 owner-scoped recursive CTE；`validate_position_payload` 在任何寫入前攔截壞輸入（可讀 400）；batched 寫入（`save_game_batched`）語句數不隨棋長膨脹。
- 問題：D-01（base_revision 未接線）、R-05（outbox 無時間戳）、R-02（合併方向矛盾）、D-03a（duplicate 靜默覆寫）。
- 改議：優先接線 D-01（樂觀鎖），並為 outbox entry 建立時間欄位以支撐資料生命週期合約。

### 6.3 演算法處理

- 優點：scheduler `_collect_candidates` 正確剪除 disabled 子樹；`node_mastery` 的 weak 判定含近期恢復邏輯，避免 mastery/weak 矛盾；`classify_precomputed_game` 是分類的單一真相來源（route 與其他地方共用）；`walk_effective`/`effective_children` 共用有效分支計算。
- 問題：A-01（mixed session 逐 rep 向上取整突破上限）；D-03a。
- 改議：A-01 改全域 budget 分配；`position_map` 提前對 duplicate FEN 拋錯。

### 6.4 功能設計

- 優點：分享連結生命週期完整（建立/輪換/撤銷 + `_share_link_live` 期限檢查）；local-first outbox 架構成熟（冪等 reconcile、settled tombstone、rejected 永久保留）；訓練模式三分（Smart queue / Line rehearsal / Play vs human）職責清楚；coach banner 以 `data-state` 驅動視覺狀態。
- 問題：F-01（重設郵件未寄送）、F-02（session 不過期）——兩者都是「功能存在但未完成」級缺口。
- 改議：F-01 接郵件服務；F-02 加 `expires_at` 並於請求時檢查。

### 6.5 視覺效果

- 優點：60px hover-expand 側邊欄（滑入展開 overlay、行動版改底部標籤列）；skeleton 載入（build 樹骨架、rep 名稱 skeleton-text）；mastery bar（`lib-mbar`）與 queue chips（`kchip k-weak/k-due/k-new`）以色彩+文字雙重編碼；coach banner flash 動畫只在 correct/wrong 觸發。
- 問題：N-2 造成 setup 狀態棋盤上方標籤區留白（視覺缺口）；今日卡 metrics 在 ≤1279px 隱藏、欄位標頭在 ≤760px 隱藏，皆為有意設計且 smoke 有斷言。
- 改議：同 N-2——以非冗餘資訊填補標籤區，避免「為簡潔而留白」損害可讀性。

### 6.6 UX 簡潔化

- 優點：P2-10 去冗餘方向正確——「Press Start」不再在 banner、按鈕、標籤三處複誦；queue 組成改由標籤 chips 說明、移除第二條進度條（UX 2026-09-30 P2-10，`web-src/views/train.js` `renderSmartQueueStrip`）；「Get started」從 3 張提示卡收斂為單一檢查清單；錯誤訊息一律可讀句子（非 raw exception）。
- 問題：N-2 是簡潔化**執行過度**的案例——清空靜態標籤時連「棋盤顯示的是什麼」也拿掉了；`resetTrainBoardIdle("")` 使 fallback 鏈完全失效。
- 改議：簡潔化的驗收標準應是「每個資訊只出現一次，且仍可被找到」，而非「刪到空白」；補 setup 標籤（非冗餘內容）後重跑 smoke。

---

## 7. 結論

專案主體品質高（測試齊全、權限與輸入驗證到位、舊審查多數項目已修復）。當前最該優先處理的是 **N-1**（恢復 smoke 9/9，屬錯誤韌性缺口）與 **D-01/F-01/F-02**（資料完整性與帳號安全）；**N-2** 需要一個明確的設計決策（非冗餘標籤 vs 更新 smoke 契約）；其餘 R-02/R-05/A-01 可排入下一輪。本報告未修改任何產品程式碼。

### 7.1 與舊報告的差異速查

- **新發現**：N-1、N-2（兩份舊報告均無）。
- **舊報告誤報**：09-30 D-03「重複儲存」（實為互補寫入）。
- **已修復**：第 3 節全部。
- **仍開放**：D-01、F-01、F-02、R-05、R-02、A-01、D-03a（第 4 節）。
- **smoke 基線修正**：09-30 報告寫 8/9，實測為 **7/9**（Library/Train 於 UX wave 後新失效）。
