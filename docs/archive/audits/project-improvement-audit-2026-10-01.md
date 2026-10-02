# PrepForge Chess 全面改進檢查報告

檢查日期：2026-10-01（America/Phoenix）
檢查基準：HEAD `8bdf0e7`，工作目錄乾淨（僅未追蹤的報告／產物檔）
檢查範圍：UI、資料庫互動、演算法處理、功能設計、視覺效果、使用者體驗簡潔化
交付：報告本身。未修改任何產品程式、資料表、套件或部署設定。

> 說明：本次工作目錄在檢查期間是乾淨的（`git status` 僅顯示未追蹤的報告與產物目錄）。已存在的 `docs\reports\` 目錄為本次新建。

---

## 0. 摘要

PrepForge Chess 是一個成熟度相當高的產品：多租戶所有權驗證、不可變評估快照、批次儲存、訓練重試收據、明暗主題、鍵盤棋盤，以及 9/9 通過的跨 viewport UI smoke 都已到位。設計 token 系統相當完整，`styles.css` 有明確的雙主題語意色契約。

**但本次檢查發現三類仍待處理的問題，與前三份報告（9/29、9/30、10/1）不同：**

1. **舊報告中大部分 P1 已確實修好**（見第 2 節），這是好消息。
2. **仍有四個 CONFIRMED 的高優先缺陷**，其中兩個是資料正確性（併發保護實際未生效、`mate_in=0` 被誤判），兩個是演算法配額（混合訓練超額、終局勝率錯算）。
3. **測試策略本身有系統性弱點**：81 個前端測試檔用 `readFileSync` 讀原始碼做 regex 斷言，導致重構必然破測，且已經造成目前唯一的紅燈。

本次未修改任何程式。以下所有 CONFIRMED 項目皆有實測或程式碼證據。

---

## 1. 結論與優先順序

| 優先度 | 項目 | 類別 | 證據程度 |
|---|---|---|---|
| **P1** | SPA 從不送出 `base_revision`，併發保護實際被略過 | 資料庫 | 程式碼確認（全域 0 處引用） |
| **P1** | 混合訓練全域題數上限失效（要求 12 得到 14） | 演算法 | 服務實測 |
| **P1** | `mate_in == 0`（終局將死）被當成 50% 均勢 | 演算法 | 函式實測 |
| **P1** | 密碼重設信函只 `print`，無寄送 | 功能設計 | 程式碼確認 |
| **P2** | outbox 合併方向與註解相反，舊分頁可復活已確認操作 | 資料庫 | 記憶體探針 |
| **P2** | 訓練永久拒絕項目仍留在 durable pending，反覆重送 | 資料庫 | 記憶體探針 |
| **P2** | 棋盤座標對比 2.15–3.19:1，全部未達 WCAG AA | 視覺／無障礙 | 對比計算 |
| **P2** | `More` 選單宣告 `aria-modal` 但未限制背景焦點 | 無障礙 | 程式碼確認 |
| **P2** | 分析重送會產生重複歷史列；單一請求重複寫入兩次 | 資料庫 | 程式碼確認 |
| **P2** | Scout 約 68% 非測試碼不在預設路徑，v13 靜態進入正式 bundle | 演算法／維護 | 靜態匯入確認 |
| **P3** | 81 個測試檔以原始碼 regex 斷言，目前已有 1 個紅燈 | 測試策略 | 實測 |
| **P3** | `reclaim_orphans` 從未被應用程式呼叫 | 資料庫 | 程式碼確認 |
| **P3** | app.js god-file（13,716 行）、字級尺度不一致 | 維護／視覺 | 統計 |

### 1.1 三份舊報告的處理狀態（重要）

本次逐項核對了 9/29、9/30、10/1 三份報告的主要發現。**舊報告不能再直接當作待辦清單**：

**已確實修好（本次獨立驗證）：**

- 9/29 R-01（Build 丟棄 4xx）→ `sync-errors.js` 已有完整 `classifySyncError`，Build 已採用
- 9/29 F-01（分享不可撤銷）→ 已有 `share_rev` 輪替與 `/revoke`，撤銷即 404
- 9/29 D-03（`score_cp` 驗證）→ `browser_compute.py` 已有 `_validate_int`，壞值不再 500
- 9/29 A-01/A-02（mastery 矛盾、停用祖先）→ `progress.py` 已改為單一 `node_mastery`，`walk_effective` 統一
- 9/29 A-04（重複解說）→ `browser_compute.py` 用 `generated_comment =` 覆寫而非累加
- 9/30 F-02（session 永不過期）→ `deps.py` 已實作 idle 過期
- 10/1 P0-2（Explorer 失敗假裝低樣本）→ 已加 `explorer.unavailable` 分類
- 10/1 P0-3（Ctrl+K 誤觸）→ 已加 `isOpeningKeystroke` 守衛
- 10/1 P1-2（回憶卡洩漏答案）→ `train.js` 只在 `kind === "new"` 顯示 SAN
- 10/1 P2-5（`.qbar` hidden 失效）→ 已有 `.qbar[hidden] { display: none; }`

**仍成立（本次重新確認）：** 9/30 R-01、R-02、9/30 D-02、9/30 A-01、10/1 P1-1、10/1 P2-5 以外的大樹 DOM 與效能類。

---

## 2. 本次實際執行的驗證

| 檢查 | 結果 | 解讀 |
|---|---|---|
| `npm run smoke:ui-v2` | **9／9 通過** | 八個頁面 + 狀態在三種 viewport 無溢位、無 console error |
| `npm test -- --reporter=dot` | **1 failed / 1,898 passed** | 唯一紅燈是 `ui-layout.test.js` 原始碼 regex 斷言，非產品 bug（見 6.1） |
| 混合訓練配額探針 | 要求 12 → 實得 **14** | 以記憶體 repository 實測 `start_or_resume_mixed` |
| `mate_in` 勝率探針 | `mate_in=0, score_cp=-100000 → 0.5` | 終局被當均勢 |
| WCAG 對比計算 | 座標 2.15–3.19:1 | 四種主題／棋格組合全部未達 AA |
| `base_revision` 全域搜尋 | **0 處引用**（web-src） | 前端從未送出版本 |
| `reclaim_orphans` 呼叫端搜尋 | 僅定義與 docstring | 清理從未執行 |
| 產品碼／CSS／HTML 靜態盤點 | 見各節 | 未修改任何檔案 |

限制：未連接正式 PostgreSQL／Render／郵件／Stripe；未做多帳號 E2E；效能結論為靜態推估，未做真實大數據量測。

---

## 3. P1 級發現（建議優先排入下一輪）

### 3.1 併發保護實際未生效：SPA 從不送出 `base_revision`

**CONFIRMED。** 這是本次最嚴重的資料庫層發現。

後端已經完整實作了樂觀併發控制，但前端完全沒用：

- `workspace.py` 有 7 個 mutation 端點接受 `base_revision`，並在 `_check_base_revision`（`workspace.py:75-83`）比對。
- 但 `_check_base_revision` 在 `base_revision is None` 時**直接 return**（`workspace.py:80`），註解明寫 "keeps the legacy merge-anywhere behaviour"。
- 全域搜尋 `web-src/**/*.js`，`base_revision` 出現 **0 次**。`app.js:8597`（刪除）與 `app.js:8604`（新增）送出的 body 只有 `repertoire_id` 與 `moves`。

**影響：** 兩個分頁同時編輯同一個 repertoire 時，伺服器不會回 409，最後寫入者覆蓋。前端已寫好的衝突保留流程（`app.js:8757` 的 `setBuildSync("conflict")`）因此幾乎永遠不會觸發——程式碼存在但形同虛設。

**更深的問題（即使補上前端欄位也不夠）：** `workspace.py:786-787` 先讀 metadata、再檢查版本、最後才寫入，而 `repositories.py:840` 的更新條件只有 `id == repertoire_id`，沒有帶 revision 條件。兩個請求可以同時通過相同版本檢查再各自提交。**檢查與寫入不具原子性，會 lost update。**

**建議：** 讓所有 Build mutation 帶上映入時的版本，成功後更新本地版本；並把版本檢查移進寫入交易，以 `WHERE id=? AND revision=?` 更新並檢查影響列數。

### 3.2 混合訓練全域題數上限失效

**CONFIRMED（服務實測）。**

`training_smart.py:290-291`：

```python
per_size = max(2, -(-total_size // len(reps)))
per_new  = max(1, -(-total_new  // len(reps)))
```

各 repertoire 分別取題後交給 `scheduler.py:474` 交錯合併，**沒有全域截斷**。`max(2, ...)` 的下限在 repertoire 數多於預算時反而放大總量。

實測：7 個 repertoire、要求 12 題、每庫各供 2 題 → 最終 queue **14 題**。`new_cap` 同樣失控：`new_cap=0` 也會變成每庫至少 1。

**影響：** 使用者選 3 個以上 repertoire 時，「本次 12 題」的承諾不成立，訓練量與預期不符。

**建議：** 以全域 target／new-target 預算分配，而非先除再各自取。注意不能只截斷卡片數——一張卡可能包含多個 targets。

### 3.3 終局 `mate_in == 0` 被當成 50% 均勢

**CONFIRMED（函式實測）。**

`classification.py:71-80`：

```python
if evaluation.mate_in is not None:
    if evaluation.mate_in > 0:  return cp_to_win_chance(CP_CLAMP)
    if evaluation.mate_in < 0:  return cp_to_win_chance(-CP_CLAMP)
    return 0.5          # ← mate_in == 0 直接視為均勢，且忽略 score_cp
```

實測 `mate_in=0, score_cp=-100000 → 0.5`。而 `engine.py:275` 使用 python-chess 的 `.mate()`，將死局面確實可能回傳 0（已實測 `Mate(0).mate() == 0`）。

**影響：** 被將死的局面被判為五五波，非最佳著法的損失計算與 Brilliant 的 Stockfish truth 可能錯誤。最佳著法在分類前會直接回傳 BEST，所以並非每個將死著都受影響，但誤判範圍真實存在。

**建議：** 明確定義 mate-zero 的終局／視角契約，用終局棋盤或有方向的分數還原，不要把 0 當中立。

### 3.4 密碼重設信函只印到 stdout

**CONFIRMED。**

`auth.py:314-321` 的 `_deliver_mail` 全文就是 `print(...)`。`forgot_password`（`auth.py:347`、`367`）確實建立了 `PasswordResetToken` 並產生正確的 link，但**沒有任何寄送機制**。非 production 才會在 response 回傳 `dev_reset_token`。

**影響：** 使用者點「忘記密碼」會得到 200 與 "sent"，但永遠收不到信。帳號鎖死時沒有自行復原路徑。這是登入閘門（email/password）唯一的復原管道。

**建議：** 實作真正的寄送轉接（例如 SMTP／郵件服務 API），並把 `print` 換成結構化 log（避免把 reset token 寫進應用程式日誌）。

---

## 4. P2 級發現

### 4.1 outbox 合併方向與註解相反

**CONFIRMED（記憶體探針）。**

`sync-outbox.js:149-160` 的 docstring 寫 "incoming wins on conflict"，但 `mergeById`（`sync-outbox.js:126-143`）先加入 `base`，再以 `!seen.has(id)` 排除同 ID 的 incoming——**實際是 stored/base wins**。沒有版本或時間比較，新的記憶體內容可能被舊的 stored 內容取代。

同一處 `sync-outbox.js:165` 的排除集合只取本次參數 `settled`，未讀取 `base.settled`；舊分頁保存舊快照時，已確認的操作會被重新加入 pending。`app.js:3408` 的 `clearOutbox` 在佇列清空時連 tombstone 一起刪除，進一步失去排除依據。

**建議：** 修正註解與實作的方向；合併時納入已儲存的 `settled`；清理時保留 tombstone。

### 4.2 訓練永久拒絕項目仍留在 durable pending

**CONFIRMED（記憶體探針）。**

`app.js:12202` 的 `unsettled` 同時包含 failed 與 rejected，接著 `filter((id) => !unsettled.has(id))`——rejected 不會被 tombstone。記憶體 pending 清空了，但 durable merge 是聯集，空陣列無法刪除原本的 pending。探針模擬 404：得到 1 個 rejected group、0 個 settled ID，durable pending 仍有 1 筆；重載後恢復。

**影響：** 永久失敗的操作會反覆送出、反覆報錯，與 `sync-errors.js` 註解宣稱的 "never auto-retried" 矛盾。

### 4.3 棋盤座標對比全部未達 WCAG AA

**CONFIRMED（對比計算）。**

`.coord` 只有 9.5px（`styles.css:2114`），必須達 4.5:1，不能用大型文字的 3:1 門檻。四種組合：

| 情境 | 前景／背景 | 對比 |
|---|---|---:|
| 淺色主題、淺格 | `#6f8394 / #e4e8eb` | **3.19:1** |
| 淺色主題、深格 | `#eef1f3 / #97a8b6` | **2.15:1** |
| 深色主題、淺格 | `#5a6c7b / #b9c3cb` | **3.03:1** |
| 深色主題、深色格 | `#d8dee3 / #6f8292` | **2.93:1** |

Explorer 和局數字也偏低（`#fff / #9a9fa6` = 2.66:1）。這是 9/29 報告的 V-01，**至今未修**。

值得肯定的是：`--muted`（7.13:1）、`--label`（4.94:1）等一般文字已通過，且有 `visual-system.test.js` 對比護欄——但護欄沒有涵蓋座標與 Explorer 數字。

**建議：** 調整前景色；必要時加不透明文字底片；把這幾組加進對比測試護欄。

### 4.4 `More` 選單宣告 modal 卻未限制背景焦點

**CONFIRMED。** `index.html:749` 有 `aria-modal="true"`，但 `app.js:13674` 開啟時只顯示選單、更新 `aria-expanded`、聚焦首項，沒有呼叫共用 `activateModal`，也沒有 Tab 循環或背景 inert。鍵盤使用者可以離開仍開啟的 modal。Escape 與關閉後焦點返回已有實作。

**建議：** 統一使用既有共用 modal lifecycle（已用於 auth modal，含 trap 與 focus restore）。

### 4.5 分析重送產生重複歷史列；單一請求重複寫入

**CONFIRMED。**

- `browser_compute.py:322` 每次分類產生新的 `analyzed_at=utc_now()`，而 `repositories.py:2298` 把 `analyzed_at` 放進分析 ID 雜湊。成功儲存但回應遺失後，重送相同 payload 會得到新 ID、新歷史列——**無法區分重試與新工作**。
- `analyze.py:375` 先呼叫 `save_game_batched(...)`，`analyze.py:379` 再呼叫 `save_analysis_result(result)`；前者已在 `repositories.py:576` 寫入分析列。第二次通常是同 ID upsert，但增加交易與故障窗口：第一次成功、第二次失敗仍會讓整個請求報錯。

**建議：** 使用穩定的分析 operation ID；移除第二次儲存。

### 4.6 Scout 約 68% 非測試碼不在預設路徑

**CONFIRMED（靜態匯入確認）。**

`web-src/scout-*.js` 非測試合計 **17,890 行**，接近整個後端的規模。分類：

| 類別 | 檔案數 | 行數 |
|---|---:|---:|
| 預設 Scout 可達 | 12 | 5,703 |
| 僅 v13 可達及共享依賴 | 12 | 5,261 |
| Scout UI 不可達（研究／CLI／harness） | 9 | 6,497 |

關鍵點：`views/scout.js:32-33` **靜態匯入** `scout-v13-report.js` 與 `scout-v13-stream.js`。正式產物 `scout-BB21NIp_.js` 約 155 KB 未壓縮，**沒有 flag 也會載入**。相較之下 v15 沒有任何 UI flag（本次搜尋確認）。

**建議：** v13 改為動態匯入；研究模組移出 runtime 目錄（在 `ARCHITECTURE.md` 與 `docs/README.md` 註明歸屬）。

### 4.7 其他 P2

- **mastery 儲存狀態仍可能矛盾**：`progress.py` 的 UI／scheduler 互斥**成立**（共用 `node_mastery`），但 `training.py:490` 累計答對 3 次就加入 session 的 `mastered_nodes`，SRS 卻要 score≥7，且答錯不會移除 session 名單——同一 session 可同時保留 mastered 與 mistakes。建議統一，或把「本次完成」與「已掌握」分開命名。
- **分析歷史與棋著未綁定同一快照**：`repositories.py:2045` 讀最新分析 metadata 後，另行 `load_game`（`:2057`），兩次讀取之間可能換版本，回傳「分析 A 的摘要＋分析 B 的棋著」。
- **Smart Sync 可部分提交後回傳整批失敗**：`training_smart.py:694` 逐 attempt 提交，`:817` 才檢查 `MAX_SYNC_QUEUE` 大小——attempts 已提交，最後卻回 400。
- **引擎快取無容量限制**：`scout-engine.js:30` 的持久化 key 沒有 Stockfish 版本，無 TTL／LRU；`scout-init-guard.js:15` 同 username 的 Map 無上限。
- **登出承諾無條件**：`account.js:670` 無條件承諾「kept on this device」，未檢查 `outboxPersisted`。
- **PGN 輸入缺可存取名稱**：`index.html:205` 的 `textarea#pgn-input` 沒有 label／aria-label。
- **操作後強制失焦**：`movetree.js:91`、`analyze.js:233` 無條件 `blur()`（含鍵盤啟動），破壞連續操作；訓練 `progressbar` 沒有同步 `aria-valuenow`。
- **部分操作只有指標支援**：`analyze.js:587` 明確移除圖表 `tabindex` 且無鍵盤 handler；引擎視窗移動／縮放只有 `pointerdown`（`app.js:1719`、`1752`），resize handle 被 `aria-hidden` 隱藏。

---

## 5. 站得住的優勢（不要在重構中弄丟）

- **UI smoke 9/9 通過**，涵蓋 8 個頁面 × 3 種 viewport，含真實 fixture 與瀏覽器引擎管線。
- **設計 token 系統成熟**：雙主題、語意色一致（`--good` / `--warn` / `--danger` 在每個視圖同義）、字型／圓角分層，並有 `visual-system.test.js` 對比護欄。
- **一般文字對比良好**：`--muted` 7.13:1、`--label` 4.94:1、深色 muted 7.66:1。
- **Reduced-motion 有全域支援**：`styles.css:5088`。
- **鍵盤棋盤**：roving tabindex、方向鍵導覽、棋子名稱齊全。
- **共用 modal 有 focus trap 與 focus restore**（問題只在 `More` 選單沒用共用路徑）。
- **狀態不只靠顏色**：分類與狀態多有文字／符號。
- **`sync-errors.js` 是優秀的錯誤契約**：單一 classifier，清楚區分 retriable／permanent，訊息可操作。
- **延遲載入模型**：Python `_engine=None` 首次推論才載入並重用；瀏覽器 worker 共用 init promise。沒有每次請求重載。
- **評估去重正確**：fingerprint + unique constraint，批次用 `on_conflict_do_nothing`。
- **分析列表已有 keyset 分頁**（`repositories.py:1997`），不是無界列表。
- **熱路徑索引齊全**：`owner_user_id`、`repertoire_id`、`due_at` 都有索引。
- **未發現可利用的多租戶越權**。

---

## 6. P3 與維護邊界

### 6.1 測試策略是系統性弱點（唯一紅燈的根因）

`npm test` 目前 **1 failed / 1,898 passed**。紅燈是 `web-src/ui-layout.test.js:360`：

```js
expect(restore.slice(0, 1800)).toMatch(/switchView\(loc\.view,\s*\{\s*fromUrl:\s*true\s*\}\)/);
```

這是**讀原始碼字串做 regex 斷言**，不是產品 bug——`restoreWorkspaceLocation` 的行為正確，只是 `switchView(loc.view, { fromUrl: true })` 這行被挪到 1800 字元切片之外（新增的 `navigatedDuringBoot` 分支把它推後了）。

**但這暴露了更大的問題：81 個前端測試檔用 `readFileSync` 讀原始碼做斷言**，`ui-layout.test.js` 單檔就有 128 個 `toMatch(/.../)`。這類測試：

- 對任何重構都會失敗（改個變數名、調個順序就紅），造成「改程式先改測試」的負面誘因；
- 無法驗證執行時行為，只驗證「程式碼長什麼樣子」；
- 本次的 9/30–10/1 UX 修正大量動到 `app.js` 與 `index.html`，這正是紅燈的來源。

**建議：** 逐步把行為斷言改成 DOM／執行時斷言（smoke 已證明 Playwright 路線可行），或至少把純樣式契約留在 CSS 解析、把結構斷言移到整合測試。

### 6.2 其他 P3

- **`reclaim_orphans` 從未被應用程式呼叫**：`data_lifecycle.py:69` 定義了清理，全庫搜尋只有定義與 docstring。孤兒評估與 receipts 持續累積。注意 `OFFLINE_RETRY_DAYS = 30` 的離線重播期限**在 outbox／sync 路徑也未實作**——若日後直接啟用清理，仍有效 session 的舊 attempt 可能在 receipt 刪除後重複計入。**先實作可驗證的重播期限，再接入清理。**
- **app.js god-file**：13,716 行、450 個頂層函式。視圖／功能控制流程佔 7,138 行。可確認的重複 helper 至少 39 行：`bindDropZone`（`app.js:9254` vs `views/dashboard.js:8`，25 行）、`classBadgeSymbol`（`app.js:6832` vs `views/analyze.js:34`）。**不建議換框架**——先抽出同步編排與這兩個純 helper，收益比明確。
- **真正被吞掉的錯誤**（非所有空 catch 都錯）：`app.js:2358` book fetch 失敗後仍設 `loaded = true`，空結果被當成功快取；`app.js:6168` repertoire 刪除的網路失敗只刷新列表不通知；`app.js:4818` `/lichess/seen` 失敗完全忽略。優先修「失敗被記成成功」與「使用者操作無回饋」。
- **字級尺度不一致**：193 個直接 px 的 `font-size`、21 種尺寸、11 種只用一次（含 12.5px、13.5px、11.5px、8px）。缺少共用 spacing scale（1772 個 px 值、122 種數值）。建議建立角色字級，優先消除半像素變體。
- **Standing-explanation 規則殘留**：`scout.js:1661` 的 "After 1.X: what their opponents answered, and how Y scored" 持續顯示（drill-down 圖表解說，應移至 ⓘ）；`settings-account.js:61` 的訪客跨裝置同步說明屬常駐功能解說（guest 是合法狀態，但理由應按需顯示）。Library／Analyze／Build 的空態與阻擋狀態符合例外。
- **analyze-checkpoint 只有單筆限制**：索引 `slice(0, 50)` 但淘汰的 checkpoint 本體沒有 `removeItem()`，無總量或 TTL；同 origin 的 outbox 可能因此無法持久化。
- **跨帳號狀態邊界**：其他開啟中的分頁沒有登出通知，會保留 `bookState.reps`、`trainPreviewCache` 等私人資料；`account.js:632` 把任何 `/auth/me` 失敗視為登出，可能讓暫時網路故障把後續持久化導向 anon。

---

## 7. 使用者體驗簡潔化：最值得做的三件事

1. **統一數字定義（P1-1 仍成立）。** Library、Train、Repertoire 對「要學／要複習」用不同口徑（trainable 總量 vs weak+due vs 到期時間計數），畫面上卻沒有說明，再加上同步時間差，看起來互相矛盾。使用者不知道今天練完了沒有。建議定義每個指標的範圍與單位，對齊後端與各頁。
2. **簡化 Train 面板。** 截圖顯示一個面板裡同時有「1 due / 4 new / 1 polish」、「In a row / Correct / Mistakes」、「This session」等多層進度與兩種單位（每步／每張卡）。建議：回憶卡不顯示答案（已修）、完成前顯示同步狀態而非 summary、計數加單位。
3. **Train 與 Analyze 的 coach 語意要分層。** 目前「剛才著法的評語」「失誤前的替代著法」「目前局面的 PV」混在同一個教練框裡。建議明確區分時間點。另 `Analyze` 截圖顯示教練文案很長且資訊密度高，建議壓縮成一句話加一個 ⓘ。

---

## 8. 建議實施順序

| 批次 | 範圍 | 先後原因 |
|---|---|---|
| 第一批：資料正確性 | 3.1 併發保護、3.3 mate=0、4.5 分析冪等、3.4 密碼重設寄送 | 直接影響資料正確性與帳號可用性 |
| 第二批：演算法配額 | 3.2 混合訓練上限、4.7 mastery 統一 | 讓「要求的量」與「實際的量」一致 |
| 第三批：同步契約 | 4.1 outbox 合併、4.2 永久拒絕清理 | 讓儲存狀態可信 |
| 第四批：無障礙與視覺 | 4.3 座標對比、4.4 modal 焦點、PGN label、progressbar、鍵盤 | WCAG 與可操作性 |
| 第五批：體驗簡化 | 第 7 節三項 | 降低完成任務的步驟與判斷負擔 |
| 持續維護 | 6.1 測試策略、6.2 god-file 與重複、scout 實驗碼整理 | 避免功能增加後再次失去一致性 |

每批建議有獨立回歸範圍；不要把持久化、排程改版與視覺重構綁成一次大改。

---

## 9. 主要證據位置

| 主題 | 主要檔案／函式 |
|---|---|
| 併發保護 | `workspace.py`：`_check_base_revision:75-83`、mutation 端點 `:776-1087`；`repositories.py:840`；`app.js:8597,8604` |
| 混合訓練配額 | `training_smart.py:290-291`；`scheduler.py:474` |
| 終局勝率 | `classification.py:71-80`；`engine.py:275` |
| 密碼重設 | `auth.py:314-321,330-378` |
| outbox 合併 | `sync-outbox.js:126-143,149-168,221`；`app.js:3408,12202` |
| 座標對比 | `styles.css:93,191,2112-2123`；`visual-system.test.js` |
| More modal | `index.html:749`；`app.js:13674` |
| 分析冪等 | `browser_compute.py:322`；`repositories.py:2298,576`；`analyze.py:375-379` |
| Scout 實驗碼 | `views/scout.js:32-33`；`web-src/scout-v13-*.js`、`scout-v15-*.js` |
| 測試策略 | `ui-layout.test.js:360`；81 個 `readFileSync` 測試檔 |
| 清理未接入 | `data_lifecycle.py:69`（`reclaim_orphans` 無呼叫端） |
| UX 簡化 | `views/train.js:135-177`；`views/scout.js:1661`；`views/settings-account.js:61` |

---

## 10. 本次未涵蓋

- 未連接正式 PostgreSQL／Render／郵件／Stripe／OAuth。
- 未做多帳號 E2E、跨分頁實地競態重現（4.1／4.2 為靜態與記憶體探針）。
- 未做真實大數據量的 API p50／p95、DOM 節點數、低階裝置引擎實測（效能結論為靜態推估）。
- 未以螢幕閱讀器實際驗證（無障礙結論為程式碼與對比計算）。
- 未評估商業／定價／成長面。
