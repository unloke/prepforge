# PrepForge Chess 專案改善評估報告

日期：2026-09-30  
檢查基準：工作目錄目前實作；Git HEAD `5a410de`（Merge PR #96）。  
範圍：UI、資料庫互動、演算法、功能設計、視覺效果、使用體驗與操作簡化。  
本次僅新增本報告，未修改程式碼、資料庫結構、產品設定或部署。

版本限制：檢查結束前觀察到工作目錄另有引擎面板、棋局終止判定及樣式的同步編輯；那些變更不是本次報告工作所作，也未納入完整驗證。上述測試結果與行數統計以本次檢查時點為準。

## 1. 整體判斷

這個專案已經有完整的產品骨架：開局建立、間隔複習、實戰比較、對手偵察、棋局分析及團隊分享，能串成「準備 → 練習 → 實戰 → 回顧 → 再準備」的迴圈。瀏覽器運算、擁有者權限、訓練重試收據、精簡棋譜儲存與大量回歸測試，也提供了值得保留的技術基礎。

目前最需要改善的是**各功能交界的可靠性與使用者能否完成整個流程**。新增的持久化、版本衝突、帳號找回與分享治理都有相應模組，但部分前後端尚未接通，或仍有成功路徑會破壞另一項功能的復原資料。這些問題應先於新增更多功能與大幅視覺重設計處理。

建議優先順序：

1. **確保使用者已做的工作能復原**：修正共用 outbox 清除、Build 恢復目標、被拒操作的恢復及多分頁覆寫。
2. **讓後端能力成為完整使用流程**：版本衝突、密碼找回、分享停用／輪替、帳號匯出與刪除。
3. **統一產品數字的含義**：到期數、有效訓練節點、熟練度、Scout 機率與分析品質。
4. **縮短主要操作路徑**：今日訓練、分析重要失誤、準備對手最重要的三條路線。
5. **以量測決定效能改善**：大型開局樹、低階裝置、模型冷啟動、PostgreSQL 真實查詢及跨頁運算競爭。

### 1.1 證據等級

| 標記 | 意義 |
| --- | --- |
| 已確認 | 目前程式碼可直接確認的行為或缺漏 |
| 最小重現 | 使用現有模組與記憶體資料重現；沒有操作使用者的正式資料 |
| 高可信風險 | 已追查資料路徑，但尚未以完整瀏覽器／並行請求重現 |
| 設計建議 | 使用流程或視覺方向，需使用者研究確認效益 |
| 待量測 | 無足夠實測資料，不宣稱目前已發生效能問題 |

### 1.2 優先順序

| 優先順序 | 原則 |
| --- | --- |
| P0 | 可能使未同步工作失去復原保障，應最先處理 |
| P1 | 核心流程不完整、數字不一致、衝突或重試語意不可靠 |
| P2 | 操作負擔、可讀性、效能擴充套件與維護性 |
| P3 | 需要資料累積的產品實驗與進階個人化 |

P0 在此是排程建議，不代表已確認正式環境發生事故。

## 2. 檢查方法、結果與限制

### 2.1 本次檢查

- 從 `docs/README.md`、目前架構與資料流檔案開始，再對照實作。
- 閱讀 SPA 同步與分析流程、account controller、主要 view、棋譜樹 renderer、瀏覽器引擎及 Scout 選取模組。
- 閱讀 workspace、auth、account、analyze API，repository、schema、migration、訓練排程、熟練度及資料清理邏輯。
- 以本機 `http://127.0.0.1:5173` 檢視未登入的 Library、Analyze、Train 畫面及可存取性樹。
- 檢視既有手機訓練及桌面 Scout 截圖，作為版面參考；這些截圖明確視為歷史證據。
- 執行與本次發現相關的現有測試，以及不落盤的最小重現。

### 2.2 實際執行的驗證

| 驗證 | 結果 |
| --- | --- |
| Vitest：outbox、同步錯誤、Train sync、Analyze checkpoint、Scout v2 selection、game analyzer | 6 個測試檔、67 個測試透過 |
| Pytest：improvement review fixes、progress、scheduler、workspace API、analyze API | 100 個測試透過；1 個 TestClient 相依套件棄用警告 |
| 記憶體 localStorage：共用 outbox 的清除行為 | 清除一次會同時移除 Build 與 Train 內容 |
| 記憶體 repository：有效子樹與 SQL 到期統計 | disabled ancestor 情境下，health due 為 0，但 SQL due 為 1 |
| 記憶體 repository：同一棋局同一時間的兩筆分析 | history 回傳 2 筆相同 game ID |

Python 使用專案 `.venv/Scripts/python.exe` 執行；系統 PATH 中的 `uv` 不可用。本次未因此安裝或修改環境。

### 2.3 本次沒有完成的驗證

未執行整套測試、重新建置、完整登入後的端到端操作、正式 PostgreSQL 壓測、真實郵件／付款／OAuth 整合測試或低階手機效能測試。未對使用者正式帳號做編輯、刪除、分享及訓練寫入。

目前選取的測試透過，不能推論所有產品流程完整。多項新功能的測試直接呼叫後端或測試純函式，沒有覆蓋實際 UI 連線及跨模組狀態。

### 2.4 舊檔案中已有改進、不能再列為全然缺失的專案

目前程式已包含：

- owner-scoped localStorage outbox 及登出前同步協調。
- Build 暫時性錯誤分類與 Train 混合失敗回報。
- `mastery-v2` 共用熟練度規則、有效啟用子樹遍歷。
- 分析自動解說與原始註解分離、分析品質欄位、待儲存 checkpoint。
- repertoire revision、到期數即時計算、分析歷史 keyset 分頁。
- 分享停用／輪替／期限、密碼重設、帳號匯出／刪除及資料生命週期後端。

下文評估的是這些功能**仍未完成的整合與邊界**，並非要求重新實作已存在的模組。

## 3. 改善專案總覽

| ID | 專案 | 優先順序 | 證據 |
| --- | --- | --- | --- |
| R01 | 單一功能儲存成功會清除共用 outbox | P0 | 已確認＋最小重現 |
| R02 | Build 佇列恢復沒有完整的開局目標協調 | P0 | 已確認；整體影響為高可信風險 |
| R03 | rejected 操作未恢復、儲存失敗未告知 | P1 | 已確認 |
| R04 | 多分頁整份覆寫與鎖定整合不足 | P1 | 已確認；競態待完整重現 |
| R05 | 逐筆隔離失敗未更新 parent ID 對映 | P1 | 已確認；高可信風險 |
| D01 | revision 未由前端送出，檢查與寫入未原子化 | P1 | 已確認 |
| D02 | SQL 到期數與有效訓練集合不一致 | P1 | 最小重現 |
| D03 | 分析歷史同時間快照會重複 | P2 | 最小重現 |
| D04 | 離線佇列期限與收據清理契約不一致 | P1 | 已確認 |
| D05 | 帳號刪除跨兩個交易 | P1 | 已確認；故障情境待重現 |
| D06 | 全樹回傳、大型匯出與索引需量測 | P2 | 已確認成本形狀；待量測 |
| A01 | 提示後答對與獨立回憶使用同一成績 | P1 | 已確認 |
| A02 | 間隔複習上限與評分過於粗略 | P2 | 已確認規則；設計建議 |
| A03 | Scout 分數不是未來勝率，UI 需清楚區分 | P1 | 已確認演算法；設計建議 |
| A04 | 精確 DP 前仍有啟發式候選截斷 | P2 | 已確認；待離線驗證 |
| A05 | 引擎並行上限與跨功能資源協調 | P2 | 已確認區域性問題；待量測 |
| A06 | 模型下載與記憶體峰值 | P2 | 已確認成本形狀；待量測 |
| F01 | 密碼找回缺實際寄信與前端流程 | P1 | 已確認 |
| F02 | 分享治理後端缺使用者入口 | P1 | 已確認 |
| F03 | 帳號匯出／刪除缺完整前端入口 | P1 | 已確認 |
| F04 | Analyze checkpoint 缺帳號隔離與明確選取 | P1 | 已確認 |
| F05 | 個人失誤採納與 compare 長期去重 | P2 | 已確認契約；設計建議 |
| U01 | Library 新手流程可合併 | P2 | 當前畫面＋設計建議 |
| U02 | 訓練中應突出當前任務 | P2 | 程式碼＋歷史手機畫面 |
| U03 | Scout 首屏應先呈現準備行動 | P2 | 程式碼＋歷史畫面 |
| U04 | 導航命名及模式切換需要更直覺 | P2 | 當前畫面＋設計建議 |
| U05 | Analyze 資料來源及品質文案 | P2 | 當前畫面＋程式碼 |
| V01 | 小字、灰階與狀態辨識 | P2 | CSS＋畫面；對比待量測 |
| V02 | 棋盤與走法樹的鍵盤／讀屏語意 | P2 | DOM＋程式碼 |
| M01 | 整合測試、維護界線與檔案更新 | P2 | 已確認 |

## 4. 本機編輯、同步與復原

### R01｜共用 outbox 被單一功能清除

**優先順序：P0；已確認。**

位置：`web-src/app.js` 的 `persistOutbox()`、`flushBuildMoves()`、`flushTrainSync()`；`web-src/sync-outbox.js` 的 `clearOutbox()`。

`persistOutbox()` 將 Build 與 Train 寫入同一個 owner key。但 Build 成功、且自己的佇列清空時，會呼叫 `clearOutbox(owner)`；Train 也有相同做法，沒有同時確認另一功能是否還有 pending 或 rejected 工作。

**影響情境：**Build 仍有待同步編輯，使用者完成 Train 同步；Train 成功後清除整份本機 outbox。Build 在記憶體中可能仍存在，但在它再次持久化前若頁籤終止，失去復原保障。反方向亦然。這不是每次成功都永久丟失所有資料，而是成功路徑建立了一個不必要的資料遺失視窗。

最小重現使用 Map 模擬 localStorage：先同時儲存 Build 與 Train；執行 `clearOutbox()` 後兩者皆為空。再對照兩個 flush 的成功分支，可確認沒有全域清空條件。

**建議：**以單一 outbox 協調者負責合併與確認；成功時只移除已確認的操作。只有 Build、Train、in-flight 與待處理 rejected 都不存在時才可清除 owner key。

**驗收：**同時有兩種工作時，任一功能成功後強制終止頁面；重新登入仍能看到另一功能未完成操作。若某項操作已被伺服器確認，不得在復原時重複計分。

### R02｜Build 恢復佇列與開局載入順序未接通

**優先順序：P0；目前路徑已確認，完整瀏覽器影響待重現。**

位置：`app.js` 的 `restoreOutbox()`、`loadSignedInWorkspace()`、`hydrateBuild()`、`flushBuildMoves()`、`onBuildBoardMove()`。

Build add entry 包含 `tempId`、`parentRef`、`uci` 與 `node`，其中 node 帶有開局資訊；但佇列層沒有按 repertoire 分組，delete entry 也缺少獨立 target。恢復時只把儲存內容串接到目前佇列，沒有依各筆 target 載入及復原開局。

`flushBuildMoves()` 在沒有 `appState.build` 時直接返回成功；真正送出時採用目前開啟的 `appState.build.repertoire_id`。而 `hydrateBuild()` 在開啟另一 repertoire 時會清空 pending、delete queue 及 ID map。

因此「存到了 localStorage」與「重新整理後可正確重播」之間仍有缺口：登入後尚未載入原開局時不會送出；載入開局時又可能重置恢復內容。不能只靠既有註解所稱每筆操作有 target，就認定恢復完整。

**建議：**每筆操作明確攜帶 owner、repertoire、operation ID、base revision；恢復工作獨立於目前頁面選擇，先依 target 分組，再載入必要的 server tree 與 parent 對映。切換開局只改顯示狀態，不應刪除另一開局的復原資料。

**驗收：**A 開局離線新增三手、重整後先開 B，再回到 A；資料仍存在且只能送往 A。刪除操作也做相同驗證。恢復時應呈現「此裝置有 A 的 3 筆待同步編輯」。

### R03｜拒絕操作未恢復，儲存失敗卻仍宣稱資料已保留

**優先順序：P1；已確認。**

`loadOutbox()` 會讀到 rejected，但 `restoreOutbox()` 只恢復 pending 與 ID map；若整份資料只有 rejected，`outboxHasWork()` 為 false，直接返回。`buildRejected`／`trainRejected` 未被重新載入，使用者無法從 UI 檢查這些記錄。

另一問題是 `saveOutbox()` 在容量不足或儲存被封鎖時返回 false，`persistOutbox()` 未使用這個結果。`saveCheckpoint()` 也有類似情形，分析失敗文案仍會說已存於此裝置。

**建議：**pending、in-flight、rejected 應為三種可查詢狀態；提供重試、複製草稿、匯出及明確放棄。持久化失敗要顯示「目前只儲存在此頁面，請勿關閉」，避免給出超出保證的承諾。

**驗收：**只剩 rejected 的佇列重新整理後仍可檢視；模擬 storage quota exception 時，UI 必須區分「記憶體保留」與「此裝置可復原」。

### R04｜多分頁會覆寫整份 outbox；鎖不是完整協調

**優先順序：P1；已確認結構，競態待端到端測試。**

`saveOutbox()` 以 `setItem()` 寫入當前頁籤的完整狀態。兩個頁籤各有自己的 `appState`，沒有依 operation ID 合併，也沒有看到對這份 outbox 的 storage event 協調。A 寫入後，B 可以用舊快照覆蓋 A 的內容。

現有 lock 是 localStorage 的「讀後寫」機制，並非原子鎖；30 秒後可被另一頁籤接管，也沒有續租。Build 使用它，Train flush 沒有相同取得鎖步驟。Build 取得鎖失敗時直接返回 false，未在此分支排程重試。

**建議：**以每筆操作獨立儲存及合併為主，鎖只作降低重複流量的輔助。後端冪等性仍是最後保障。補上鎖失敗的重試／變更通知，避免 UI 留在 dirty 卻不再送出。

**驗收：**兩頁籤交錯新增、其中一頁重新整理／關閉／取得 stale lock，所有操作最後只能確認一次且不消失。不能只測 `acquireFlushLock()` 的單次布林回傳。

### R05｜逐筆隔離批次失敗時，成功操作沒有更新依賴對映

**優先順序：P1；已確認程式碼，高可信風險。**

位置：`isolateRejectedBuildOps()`。

批次 400／422 後，函式會逐筆重送。假設第一筆合法新增建立 `tmp-A → real-A`，第二筆的 parentRef 是 `tmp-A`；目前逐筆重送成功後沒有讀取回傳 `id_map`，第二筆請求無法使用上一請求的臨時 parent。批次中一筆無效操作，可能讓合法後續分支也被拒絕。

delete 的逐筆 catch 也直接放入 rejected，沒有像 add 一樣區分中途網路失敗是否應重試。成功回傳的 authoritative tree 未被整體 reconcile，顯示狀態及 ID map 有機會落後。

**建議：**依父子依賴排序隔離；每次成功立即更新 parent 對映；區分永久失敗與暫時失敗；最後用確認結果重建畫面。隔離過程中遇到登入／網路中斷，應停止並保留後續操作。

**驗收：**一個批次同時包含合法三手鏈與一筆非法操作，合法鏈全部落盤；只有非法操作進入 rejected。隔離中途斷網時，未確認的 delete 仍留在 retry queue。

## 5. 資料庫互動與一致性

### D01｜版本衝突保護目前主要存在於後端介面

**優先順序：P1；已確認。**

後端 `AddMovesBody`、rename 及其他部分 mutation 支援 `base_revision`；`_check_base_revision()` 在未提供時會跳過檢查。前端目前 Build 批次新增、刪除與 rename 未送出此欄位。雖然 payload 回傳 revision，日常 UI 的寫入沒有使用它。

另外，revision 比對透過讀取 metadata 進行，實際寫入在後續 repository transaction。即使前端開始送出 revision，兩個請求仍可能先讀到相同值並一起透過，形成檢查與寫入之間的競態。

**建議：**前後端一起完成契約：前端送基準版本；資料庫在同一交易中做條件更新／鎖定與 mutation；409 回傳足夠資訊給使用者選擇保留本機草稿、重新套用或比較差異。相同已確認操作的重播，應先用 operation identity 認出，不要因版本變動被誤判成新衝突。

**驗收：**兩個獨立連線用同一 base revision 並行改名或修改節點，只有符合契約的一方成功，另一方收到可解決的衝突；日常 UI 請求確實帶欄位。

### D02｜到期統計尚未遵守有效訓練集合

**優先順序：P1；最小重現。**

`progress.py` 已修正 disabled ancestor 的有效子樹規則；但 `due_counts_by_repertoire()` 直接統計 progress 的 `due_at`，沒有檢查祖先啟用狀態、該節點是否仍符合訓練資格，或與 `node_mastery()` 的互斥分類保持一致。

最小重現中，禁用一個到期節點的祖先，`compute_health().due` 為 0，SQL due 計數仍為 1。`list_repertoire_meta()` 又以此 SQL 數字覆蓋 cached health 的 due。因此 Library 可以顯示「1 項到期」，Smart queue 卻沒有相應可練專案。

weak 與 due 也需定義：目前 mastery 先判 weak，再判 due；SQL due 則算所有到期 timestamp。若一個數字表示「到期時間」、另一個表示「目前排程類別」，應明確命名，而非都叫 due。

**建議：**先決定產品語意，再用同一有效節點集合計算。可將「需複習」與「優先弱點」分開呈現；避免單純改 SQL 而引入昂貴全樹計算。

**驗收：**禁用祖先、重新啟用、弱且到期、停用 repertoire 等情境下，Library、Dashboard、Build health 與訓練佇列對同一數字有一致解釋。

### D03｜分析歷史對同棋局同時間快照缺決勝條件

**優先順序：P2；最小重現。**

`list_analyzed_games()` 用每個 game 的 `max(analyzed_at)` 再 join 回分析表。若同一 game 有兩個快照的時間相同，兩筆都符合條件。最小重現回傳 `['g', 'g']`，雖然產品意圖是每個 game 一筆最新分析。

既有 keyset 測試保護不同 game 在相同時間的分頁，但沒有涵蓋同 game 的時間平手。

**建議：**以 `(analyzed_at, analysis id)` 定義唯一最新快照，再以一致的排序鍵分頁。先保留目前 owner-scoped aggregation 的優點。

**驗收：**同棋局同時間多快照只能顯示一次；不同棋局同時間仍不遺漏；多頁結果不可重複。

### D04｜收據清理與離線重播期限的假設未被實作強制

**優先順序：P1；已確認契約差異。**

`data_lifecycle.py` 設定 offline retry 30 天、receipt retention 90 天，註解說前端最多保留 30 天。但 outbox entry 沒有建立時間／期限，也沒有看到此 TTL 的檢查或過期處理。

若未來啟用收據清理，超過 90 天的舊離線 attempt 還可能從裝置重播；收據已不存在時，重試可能被重新計分。現有「90 > 30」常數斷言不能證明前端遵守 30 天。

**建議：**在操作及 API 契約中明確加入最晚重播期限；超期內容留給使用者檢視／匯出，不默默當成新成績。清理策略必須與所有裝置及舊版本客戶端相容。

**驗收：**跨越 retry／retention 邊界後重播同 UUID，不會重複加分；清理報告清楚說明哪些內容是無引用快取、哪些是冪等保障。

### D05｜帳號刪除不是一個完整資料庫交易

**優先順序：P1；已確認交易邊界。**

`DELETE /api/account` 先執行 `repo.delete_owner_data()`，它使用自己的 `engine.begin()` 並提交；接著用另一個 ORM Session 刪除身分、會員及團隊資料。若第二部分失敗，第一部分不會跟著回滾。

這會形成「內容已刪、帳號還存在」的半完成狀態。團隊關係、其他成員分享的 repertoire 與 team reference 也需明確整體清理策略。一般成功測試不能覆蓋跨交易中途失敗。

**建議：**讓 domain 與 identity 刪除共用同一交易，或採用可復原且可重試的刪除工作流程。介面應在真正完成後才顯示完成，並清理本機 owner 資料。

**驗收：**在第二階段插入受控錯誤，資料要完整回滾或可明確恢復；重試不得造成無法解釋的半刪除狀態。

### D06｜目前 SQL 次數已改善，下一步應看實際資料量成本

**優先順序：P2；待量測。**

`list_repertoires()` 已批次讀取，不能再把它描述成既有 N+1 問題；Build mutation 也已有增量寫入。但每次 batch response 仍回傳全樹，`build_workspace_payload()` 重建 report、節點 map、mastery 與 health。compact UCI 儲存節省磁碟，讀取時則需重建 SAN／FEN。

大型開局的一次小編輯，可能仍付出全樹 hydration、序列化、下載與渲染成本。帳號匯出也一次載入所有棋局及完整 repertoire，沒有分批或串流。

**建議量測：**

| 場景 | 應記錄 |
| --- | --- |
| 1k／10k／50k 節點開局，每次新增 1～5 手 | DB 時間、CPU traversal、JSON bytes、瀏覽器重繪及 long task |
| 10／100／1000 個 repertoire | 查詢次數與耗時、節點總量、記憶體 |
| 1k／10k 已分析棋局 | history 最新快照查詢的 PostgreSQL query plan |
| 大帳號匯出 | 峰值記憶體、回應大小、逾時率 |

`analysis_results` 的 game/time 查詢、`training_progress` 的 owner/due 篩選可評估複合索引；不能僅憑欄位名稱決定加索引。用實際 query plan 確認再做取捨。

API 預設 PostgreSQL pool 為 10 + 20 overflow；若開多 process，總連線需求會按 process 倍增。這是容量規劃專案，本次未證明正式環境已耗盡連線。

## 6. 演算法與運算處理

### A01｜看過答案後首次提交仍可被視為獨立答對

**優先順序：P1；已確認。**

`smartHint()` 第三級會顯示答案及箭頭；`submitSmartMove()` 的第一個 attempt 仍只依 UCI 是否等於 expected 決定 correct，沒有將 hint level 放進成績。因此先按提示看答案，再提交正確走法，與未提示自行回憶獲得同一 spaced repetition 更新。

**影響：**熟練度及下次複習時間可能高估真正回憶能力。UI 的「提示」是學習工具，但演算法需要區分學習成功與獨立回憶成功。

**建議：**至少區分獨立答對、提示後答對、看答案後完成、答錯及略過。先調整資料契約，不急著引入複雜模型。保留答對的正向回饋，同時誠實呈現「已學習」與「已記住」。

**驗收：**在同一初始 progress 下，無提示答對、第三級提示後答對，其下一次 due 不應完全相同；練習補答不重複增加 first-attempt accuracy。

### A02｜間隔複習規則可更符合長期保持

**優先順序：P2；目前規則已確認，改進效果待驗證。**

`update_spaced_repetition()` 答對 score +1、最多 10；間隔是四捨五入 score 的天數，因此最長約 10 天。答錯 score 減半、10 分鐘後到期。

這個規則簡單、可理解，但「穩定記住三個月」與「剛連續答對十次」的間隔沒有更長的區別，也沒有回答時間、提示程度、實際間隔或遺忘次數等訊號。高階使用者會持續複習已經非常熟的內容。

**建議：**先記錄非侵入式的提示使用、反應時間與實際間隔，研究長期保持率；再決定是否增長上限或引入記憶穩定度。回應慢不應直接等同不熟，需考量無障礙、裝置與思考風格。

**驗收指標：**同等訓練時間下的 7／30 日無提示回憶率、每週成熟卡片負擔、弱卡改善及新卡完成率。避免只用 streak 當演算法品質指標。

### A03｜Scout 的估計值、排名效用與勝率應明確分開

**優先順序：P1；演算法已確認，介面改進建議。**

目前 selector 以觀察到的對手決策為來源，控制方的歷史走法頻率不被當成對手機率；共享決策只算一次，Maia 至多提供兩個 pseudo-games，這些設計值得保留。

但 `conditionalReach` 是 raw conditional frequency 的連乘，`routeReach` 用於 plausibility gate，`value` 是準備效用。它們都不等於未來會走該路線的校準機率，更不等於使用者準備後的勝率。

UI 同時呈現 overall score、route score、推薦／弱點、風格、可預測程度與引擎機會時，使用者容易混淆其含義。既有 confidence qualifier 已存在，改善重點是所有關鍵數字是否可被正確解釋。

**建議：**路線首層只顯示「觀察到 N 局／M 局」「為何值得準備」「你目前缺哪一手」；機率／排名細節放在展開層。所有統計標明對手顏色、速度池、期間與資料覆蓋。以少量棋局推論風格時，保留弱信心語氣。

**驗收：**第一次使用者能回答：百分比是誰的成績？是歷史還是預測？推薦理由是常見還是容易出錯？這條路線是否已經做過引擎驗證？

### A04｜DP 精確性不代表完整流水線全域最優

**優先順序：P2；已確認。**

`selectPreparationRoutes()` 在輸入集合上執行有 12 個名額上限的 prefix-tree DP；但進入 engine 的候選先受最多 300 條與單線效用排序限制，另有 plausibility、機會與 Maia budget 的門檻。

單線較低分的候選，若能提供與其他路線不重疊的決策，組合價值可能很高。它若在 300 條以前就被刪掉，後面的精確 DP 無法找回。

**建議：**保留 bounded compute，離線比較「全候選理想結果」與「目前候選佇列」的差距。測試共享字首、大量近似路線、稀疏候選與 tactical singleton；避免為了一個案例加入沒有產品依據的家族配額或最短長度。

另應加入 corpus bootstrap／留出期間的穩定性研究：新增少數棋局是否導致推薦大幅變動，與是否實際提升可準備的決策覆蓋。

**驗收：**報告候選截斷造成的 objective gap、前 12 推薦變動率、計算耗時。變更品質以可重現資料與可解釋目標決定。

### A05｜引擎並行策略還需要全域資源預算

**優先順序：P2；區域性問題已確認，效能影響待量測。**

`resolveConcurrency()` 的自動分支限制最多 6，但指定 `requested >= 1` 時直接返回 floor，沒有套用同一上限。現有呼叫多為小數值，因此這不是已確認的日常爆量，但公開函式契約與註解上限不一致。

Analyze、Scout prefilter／deep scan、Build Generate、即時 Engine 與 Maia 各自管理任務與 worker。區域性池有上限，不代表同時跨功能仍有裝置總預算。硬體執行緒數也不直接代表手機散熱、電池與記憶體能力。

**建議：**一個簡單全域 job/resource 協調層：前景棋盤優先，背景 Scout 降權；同時限制總 worker 與 Maia session；提供省電、標準、深入模式。保留現在停止／drain／worker lifecycle 已有的保護。

**驗收：**同時啟動各種運算並切換頁面時，棋盤仍可操作，停止可在合理時間生效；背景頁籤恢復不出現舊結果覆蓋新任務。

### A06｜模型冷啟動的下載、複製與記憶體峰值

**優先順序：P2；成本已確認，裝置風險待量測。**

manifest 的 fp16 模型為 46,417,576 bytes；fp32 為 91,183,396 bytes。目前將兩個 backend 都對映到 fp16，是已記錄的下載體積取捨。已有 SHA-256 驗證、IndexedDB 快取與腐敗快取重抓，不需要重做。

`fetchWeightsWithProgress()` 將所有 chunks 留在記憶體，再建立連續 buffer，下載結束時暫時持有 chunks 與合併後 buffer，接著還要雜湊與建立推論 session。模型檔案大小並非最終 RAM 用量。

**建議：**量測冷／熱啟動、網路、裝置 RAM 與 tab suspension；將必要性不同的模型載入延後到使用者真正使用該能力。若沒有 Maia，顯示 Stockfish 仍可完成的分析範圍，並明確哪些教練解說／人類走法推估缺席。

**驗收：**最低目標裝置能完成初次下載／推論；失敗時保有可用核心流程；下載進度、驗證與模型初始化用不同文案，不把全部顯示成不明的 Loading。

## 7. 功能設計與完整性

### F01｜密碼找回後端存在，但使用者尚不能完成找回

**優先順序：P1；已確認。**

後端有 forgot/reset、token hash、期限及重設後撤銷 session。但 `_deliver_mail()` 只 `print()` 郵件內容，沒有實際寄信；響應仍是 `status: sent`。郵件中的 URL 是相對路徑，也需在真實投遞時組成可信的絕對 URL。

目前前端沒有 `/password/forgot`、`/password/reset` 或 `reset_password` 的處理入口。開發模式能回傳 token 不代表正式流程完成。

**建議：**接上真正寄信、Forgot password UI、重設頁面、過期／已使用提示及重新登入。保留防帳號列舉的相同回應。正式日誌不應包含可使用的原始重設 token。

單次 token 消耗目前是先查後改，沒有 row lock 或條件 claim；「同 token 同時兩請求」的單次使用保障也值得加並行驗證。

**驗收：**從登入頁出發，真的收到信、開啟連結、重設、登入；OAuth-only 帳號有可行說明；過期／重複／並行使用都有一致結果。

### F02｜分享停用、輪替及期限沒有可發現的介面

**優先順序：P1；已確認。**

後端 share state 和 token revision 已存在。前端「Share link...」目前直接 POST 取得／啟用分享，再複製 URL、顯示輸入框；沒有檢視目前狀態、停止分享、輪替舊連結與設定期限的對應流程。

使用者選這個選單不是隻檢視資訊，而會改變分享狀態。應讓這一點可理解。

**建議：**先開分享管理面板：顯示啟用狀態、到期日與可見內容，再提供建立／複製、停止與換新連結。清楚說明公共連結與團隊分享是兩個獨立權限；他人已建立的副本不會隨撤銷連結消失。

**驗收：**全部操作可由 UI 完成；停止後舊連結失效；輪替後只有新連結可用；取消面板不改分享設定。

### F03｜帳號資料自助管理缺少 UI 閉環

**優先順序：P1；已確認。**

後端已有 `/api/account/export` 與 `DELETE /api/account`，但目前 Settings／account 前端沒有對應入口。API 可用不等於一般使用者能帶走自己的資料或離開產品。

**建議：**Settings 加「帳號與資料」：說明匯出內容、下載結果、刪除影響與輸入確認。刪除前應該說明 unsynced drafts、他人副本與剩餘第三方訂閱關係，這些說明只在確實相關的流程出現。

本機 outbox、checkpoint 與可識別帳號資料也應納入清理範圍。大型帳號匯出先做 D06 量測。

**驗收：**不需要開發者工具就能匯出與完成刪除；匯出資料範圍與UI說明一致；刪除後換帳號不會看到前人的待儲存分析。

### F04｜Analyze checkpoint 沒有 owner 邊界，還會任意取一筆

**優先順序：P1；已確認。**

`checkpointKey()` 只以 game ID 作 key；`loadCheckpoint()` 不帶 game ID 時，遍歷 localStorage 並返回第一個符合字首的資料。它沒有 owner、schema version 或主動選擇順序。

因此換帳號或有多個失敗分析時，Retry save 可能指向舊帳號或另一場棋局。API 的 ownership 檢查會阻擋跨帳號寫入，不能據此宣稱會跨租戶覆寫；實際問題是裝置上資料可見性、錯的恢復物件與難以理解的 404。

儲存結果返回 false 亦未處理，且 startup 只提示「開 Analyze 按 Retry save」，沒有在此路徑明確把 checkpoint 恢復到畫面。

**建議：**owner-scoped checkpoint index，列出對局名稱、分析時間、品質與待儲存狀態；恢復時使用者選擇確切物件。登入／登出切換會重新篩選；儲存失敗區別 storage failure 與 API failure。必要時支援匯出本機結果。

**驗收：**A／B 兩帳號、兩棋局、重新整理、無權限與storage滿的組合，不會顯示錯棋局或誤稱已持久化。

### F05｜失誤採納與長期比較去重需要更明確

**優先順序：P2；目前契約已確認。**

Compare 自動訓練證據已經只接受擁有者的 verified Lichess identity，這是重要保護。Analyze 的「Train it」則是明確採納，每次請求算一個新 miss，不以 game ID 去重。兩者本來就可以有不同語意，但 UI 應說明「加入複習」不是「證明我這場對局又犯一次」。

Compare 的 ingest ledger 只留最近 300 game IDs。若重新匯入超出歷史視窗的舊棋局，有可能再次記錄相同失誤。現有 exactly-once 更準確的描述是「記憶視窗內重試一次」，不是無限歷史保障。

**建議：**單次採納按鈕防雙擊；對已加入的內容顯示狀態。長期去重需要根據真實使用者回掃習慣決定持久收據或可說明的歷史視窗。

**驗收：**重複點選、重複比較、改變匯入範圍、超過300局後重掃舊局，計分與文案符合明確產品契約。

## 8. UI 與使用體驗簡化

### U01｜Library 新手畫面可以合併重複動作

**優先順序：P2；本次畫面已觀察。**

未登入 Library 同時有 header 的 Import／New、空白狀態的 Sign in／Import，以及 Get started 三組動作。資訊本身合理，但一個新使用者必須在數個同義入口中判斷從哪裡開始。

**建議流程：**首屏一個主要動作「分析一場棋局」，一個次要動作「建立我的開局庫」；後者需要登入時再進入登入。已登入但無開局時，主要動作改為「匯入開局／從棋局建立」。有開局使用者則顯示「繼續今日訓練」及現有列表。

不必新增複雜 onboarding wizard；根據狀態複用現有 source composer 與 import 能力。

**驗收：**第一次使用者無需理解 repertoire／builder 的內部區別，在1分鐘內開始一個可見任務；入口之間不能在認證／匯入行為上產生矛盾。

### U02｜訓練進行中，讓「現在該做什麼」佔據最高層級

**優先順序：P2；目前實現與歷史手機截圖支援。**

Train 有 Smart queue、Line rehearsal、Play vs human、blitz、queue composition、coach、進度及統計。三種模式代表不同任務，應在開始前選擇；實際回憶時持續顯示模式切換與大量摘要，會搶佔棋盤和提示的位置。

既有手機截圖中，棋盤之後還有翻轉／提示／跳過、教練區、模式按鈕、queue strip、分類標籤與toast。它未證明當前所有視窗都被遮擋，但顯示值得驗證的垂直空間競爭。

**建議：**

- 開始前：選擇「複習／演練整條路線／練習對局」，給推薦預設值。
- 進行中：棋盤、你的回合、一句話提示、提示／略過、`3 / 12`；其餘統計摺疊。
- 完成後：獨立答對、需要提示、已修正、下一步，詳細統計展開。
- 切換模式時說明保留／結束當前任務，避免因試按模式而失去當前位置。

「Play vs human」實際上由 Maia／Explorer 模擬對手，可能被理解為與真人聯網對弈。可改為更準確的「模擬人類對手」，加一句強度說明。

**驗收：**手機主要回合提示、提示按鈕與進度無需大段滾動；螢幕鍵盤／底部欄／通知出現時仍能完成當前手。

### U03｜Scout 首屏先給行動，再給人物畫像

**優先順序：P2；設計建議。**

Scout 把來源、速度、顏色、勝負、風格、預測性、寬度、偏好路線、deep scan及route list結合在一起。資訊豐富，但使用者通常先想知道「比賽前有限時間應該準備什麼」。

**建議首屏：**對手與資料範圍 → 三條最值得準備的路線 → 每條缺哪一手／推薦原因 → 一鍵加入準備。其餘路線、風格與統計展開。已覆蓋路線降低視覺權重，缺口和可採取動作突出。

顏色必須區分「對手執白」與「我執白」，目前 With White／With Black在多身份資料下容易要求使用者猜測視角。排名因背景 enrichment 改變時，應保留使用者正在閱讀的路線選擇及滾動位置。

**驗收：**第一次使用者能在30秒內找出第一條準備行動；不用先理解所有score；Deep scan開始後不會因為列表重排讓原按鈕位置改變並造成誤點。

### U04｜導航術語與工作流採用使用者目的

**優先順序：P2；當前畫面已觀察。**

Library、Repertoire、Analyze、Train、Games、Scout、Teams是獨立頁面，但Library和Repertoire對新手可能像重複功能。內部程式碼仍使用dashboard／build，產品上不一定有問題，但幫助文字、錯誤與操作標籤需統一。

**建議命名說明：**Library「管理開局庫」，Repertoire「編輯當前開局」，Analyze「分析棋局」，Games「回顧實戰」，Scout「準備對手」。側欄首次使用保留短標籤／幫助；收縮圖示適合熟悉使用者。

跨頁handoff已有模組，值得繼續強化：從失誤進入開局時標示「來自第12手，當前缺少此回應」，完成新增後提供「立即練這條」。手機More裡的功能也需要從相關流程直接到達。

**驗收：**從實戰缺口到補充再到訓練，不需要手動重新找棋局、開局及節點；返回時保留來源視角。

### U05｜Analyze 的預設內容與品質描述應可理解

**優先順序：P2；當前畫面與程式碼已確認。**

未登入Analyze首屏棋盤為起始局面，但header顯示PrepForge vs Demo及日期／結果，而source隱藏在摺疊區。使用者可能不清楚這是示例對局、尚未載入還是自己正在分析的棋局。

建議首次展示明確的「匯入PGN／試用示例」入口；進入示例後標籤明確；普通棋盤探索與整局分析有清楚的資料來源說明。

quality summary已是重要進步，但`complete/no-maia/partial-shallow`混合搜尋完整度與可選模型狀態。若產品允許使用者關閉Maia，正常Stockfish分析不應看起來像出錯的殘缺任務。

**建議：**分別顯示「引擎搜尋：完成／部分」「人類模型：已使用／未啟用／無法載入」「雲端儲存：已完成／待儲存」。首層只呈現影響使用判斷的內容，模型版本等細節展開。

**驗收：**關閉Maia使用者仍清楚知道分析成功；引擎淺層結果會說明影響；儲存失敗不會與計算失敗混為一談。

## 9. 視覺效果與無障礙

### V01｜提高可讀性比增加裝飾更有價值

**優先順序：P2；CSS與畫面確認，準確對比率待量測。**

當前視覺已有統一邊框、卡片、側欄、棋盤與淺／深色主題。建議保持這個方向，避免每頁增加不同視覺語彙。

Scout CSS中多個統計標籤為10～10.5px，小字承擔樣本數、可信度、時效等影響決策的資訊。深色主題也使用相近灰階區分面板及次級文字。不能僅憑截圖宣稱對比不合格，但應對文字與背景做實際量測。

**建議：**

- 關鍵決定資訊優先使用更易讀字號；次要細節可摺疊，而不是全部縮小。
- 顏色明確分工：主要行動、當前選擇、訓練狀態、儲存狀態；不能讓相同顏色暗示不同產品結論。
- 錯誤／到期／熟練度同時有文字或圖形，不只靠紅綠。
- toast不承擔長期儲存問題的唯一入口；持續錯誤放在相關工作區，通知只補充。
- 不必新增動畫；已有reduced-motion與focus-visible支援，應繼續保留。

**驗收：**亮暗主題、200%縮放及手機都能讀關鍵狀態；長開局名／賬號名不推擠主要按鈕；toast與底部導航不覆蓋操作目標。

### V02｜棋盤與樹的無障礙語意仍可加強

**優先順序：P2；本次DOM及程式已確認。**

本次可存取性樹中每個棋盤格被表示為checkbox，共64格。它有棋子與位置名稱，這是優點；但棋盤操作是「選起點／選終點」，checkbox語意可能讓讀屏使用者誤解為獨立勾選專案。是否有完整roving focus與動作播報，還需實測。

move tree collapse button只有title及符號，未在renderer中輸出aria-expanded；點選走法後主動blur，也可能影響鍵盤使用者追蹤當前位置。`bindMoveTreeClicks()`給每個button個別掛事件，在大樹也有額外成本。

**建議：**保留合法棋步與鍵盤導航既有能力，明確當前位置、選中的棋子、可選目標、移動成功與升變流程；樹的展開狀態、當前手與disabled節點提供語意。適當使用容器事件委派；是否需要虛擬化則依據真實大樹量測。

**驗收：**純鍵盤完成一段訓練、切換變例、升變、開啟／關閉modal；焦點不無故消失。讀屏能聽懂當前回合與出錯原因。自動axe透過不替代此人工驗證。

## 10. 維護性、測試與可觀測性

### M01｜優先補整合測試與狀態邊界，再做針對性拆分

**優先順序：P2；已確認。**

本次統計：`app.js` 12,883行，`styles.css` 6,273行，`views/scout.js` 2,309行，repository 2,237行。程式碼長度本身不是缺陷，但`app.js`同時協調認證、outbox、棋盤、分析、Build與Train，狀態與生命週期容易產生本報告的交界問題。

不建議為了整齊全面重寫SPA或遷移框架。先把當前最易出錯的owner／operation／job生命週期從頁面狀態中明確分離，再針對這些邊界抽取模組。

### 10.1 值得補的測試

| 測試層級 | 首要案例 |
| --- | --- |
| 前端整合 | Build＋Train同時待同步；其中一方成功不得清除另一方 |
| 瀏覽器恢復 | refresh／logout／登入換賬號／先開另一開局／只剩rejected |
| 多分頁 | 同owner交錯新增、舊快照覆蓋、鎖失效及持鎖頁終止 |
| API並行 | revision同時寫入、token同時消耗、相同attempt響應遺失 |
| 資料契約 | effective enabled與due一致、同game同時間latest唯一 |
| 故障注入 | 批次隔離中斷、storage滿、賬號刪除第二階段失敗 |
| 真實裝置 | 冷模型載入、弱網路、後臺掛起、手機訓練及鍵盤操作 |

現有CI已有PostgreSQL migration／race相關測試、Vitest、UI viewport smoke及E2E／axe，這是良好基礎。下一步是新增正確場景，不只是更多斷言或擴大每次執行範圍。

### 10.2 建議觀測指標

- 每個operation從建立到確認的時間、等待原因、恢復／rejected數量；不記錄私人PGN全文。
- storage持久化失敗、重複收據命中、revision conflict與永久拒絕比例。
- 分析每階段耗時：引擎、Maia下載／初始化／推論、classify、DB save。
- 全樹response bytes、main-thread long tasks、頁面首個可用操作時間。
- 訓練獨立回憶率、提示使用、完成率與恢復失敗；不要只追蹤點選數。

目前Sentry配置預設只監控錯誤，`traces_sample_rate=0.0`；需要主動增加有預算的效能觀測，才能判斷資源與UI瓶頸。本次不推論正式環境是否開啟Sentry。

### 10.3 檔案新鮮度

`docs/ARCHITECTURE.md` 與local-first檔案仍把pending queue描述為主要在記憶體；當前已新增outbox。ROADMAP也把多項已開發後端列為候選項。建議以狀態標示「後端存在／前端未接／整合待驗」，更新實現快照。

舊報告仍可保留，但每個待辦應指向當前實作與驗收，避免下一次檢檢視到「缺durable outbox」就重做模組，卻遺漏真正的恢復錯誤。

## 11. 建議實施順序

### 第一批：守住使用者工作

處理R01～R05、F04與D04。先統一operation資料、owner／target邊界、確認與恢復流程，再增加跨功能／refresh／多分頁測試。UI誠實區分「雲端儲存」「裝置草稿」「僅本頁保留」「需要處理」。

完成條件：未確認操作都可追蹤，每筆都有明確結果，成功路徑不再破壞另一項工作。

### 第二批：完成已存在的後端能力

處理D01、D05、F01～F03；同時修正D02與A01。重點是一個使用者能從真實入口走到完成，不依賴開發者工具。

完成條件：密碼找回真的寄信、分享可以撤銷、資料可以匯出／刪除、衝突可解決，訓練成績與統計的定義一致。

### 第三批：減少主要任務的介面負擔

按U01～U05與V01～V02調整狀態層級。先針對Library首用、手機訓練、Scout賽前準備與Analyze結果做小範圍方案，避免全站同時重設。

完成條件：使用者更快完成具體任務，主要操作減少尋找與滾動，保留專家需要的細節。

### 第四批：以量測決定擴充套件

執行D06、A04～A06的資料／裝置矩陣。只有量測確認之後，才決定delta response、索引、虛擬化、worker預算或演算法升級。

完成條件：有固定基準資料、可重複效能結果與能解釋取捨的產品指標。

## 12. 驗證清單與成功指標

以下數值是建議設定的目標，**不是本次已測得結果或行業標準**。

| 目標 | 建議成功條件 |
| --- | --- |
| 工作不丟失 | 所有受控故障場景中，未確認操作可恢復／匯出；已確認操作不重複計分 |
| 新手啟動 | 無需解釋內部術語即可在1分鐘內開始分析或建立開局 |
| 手機訓練 | 當前回合說明、提示及進度在主要操作區內可見；不被toast／導航擋住 |
| Scout行動 | 在30秒內找到第一條推薦準備路線，並能說明推薦理由 |
| 數字一致 | 以同一owner、時刻及有效節點集合比較，所有頁面定義一致 |
| 帳號閉環 | 找回、分享撤銷、匯出與刪除由真實UI完成 |
| 大樹效能 | 建立1k／10k／50k節點基準，先測p50／p95再訂延遲預算 |
| 低階裝置 | 核心棋盤操作優先可用；模型失敗與後臺中斷有可行恢復路徑 |

## 13. 主要程式依據

為了後續修正容易定位，主要依據列在這裡；本報告不是以archive中的舊規範作為產品要求。

| 領域 | 主要來源 |
| --- | --- |
| 專案背景 | [檔案入口](README.md)、[架構](ARCHITECTURE.md)、[開發檢查](ROADMAP.md) |
| 同步／恢復 | [SPA orchestration](../web-src/app.js)、[outbox](../web-src/sync-outbox.js)、[錯誤分類](../web-src/sync-errors.js)、[Train sync](../web-src/train-sync.js) |
| 分析恢復／品質 | [checkpoint](../web-src/analyze-checkpoint.js)、[Analyze view](../web-src/views/analyze.js)、[browser compute](../src/prepforge_chess/services/browser_compute.py) |
| 資料庫與交易 | [repository](../src/prepforge_chess/storage/repositories.py)、[schema](../src/prepforge_chess/storage/sa_tables.py)、[DB wiring](../src/prepforge_chess/api/db.py)、[workspace payload](../src/prepforge_chess/services/workspace_view.py) |
| API功能 | [workspace](../src/prepforge_chess/api/routers/workspace.py)、[auth](../src/prepforge_chess/api/routers/auth.py)、[account](../src/prepforge_chess/api/routers/account.py)、[analyze](../src/prepforge_chess/api/routers/analyze.py) |
| 訓練演算法 | [progress](../src/prepforge_chess/services/progress.py)、[scheduler](../src/prepforge_chess/services/scheduler.py)、[training](../src/prepforge_chess/services/training.py) |
| Scout演算法 | [生產排名說明](scout-production-ranking.md)、[preparation value](../web-src/scout-preparation-value.js)、[prefilter](../web-src/scout-prefilter.js)、[summary](../web-src/scout-summary.js) |
| 引擎／模型 | [game analyzer](../web-src/engine/game-analyzer.js)、[Stockfish provider](../web-src/engine/stockfish-provider.js)、[weights loader](../web-src/engine/maia3-weights-loader.js)、[manifest](../web-src/public/maia3/maia3.manifest.json) |
| UI與視覺 | [HTML](../web-src/index.html)、[樣式](../web-src/styles.css)、[Scout樣式](../web-src/views/scout.css)、[走法樹](../web-src/views/shared/movetree.js)、[account controller](../web-src/controllers/account.js) |
| 生命週期／驗證 | [data lifecycle](../src/prepforge_chess/services/data_lifecycle.py)、[迴歸測試](../tests/test_improvement_review_fixes.py)、[outbox測試](../web-src/sync-outbox.test.js)、[CI](../.github/workflows/ci.yml) |

### 歷史視覺參考

以下只用於說明資訊密度與操作空間，不代表本次已重新截圖驗證登入後頁面。

![2026-09-29 手機訓練參考](review-assets/2026-09-29-followup/train-active-current-mobile-390.png)

![2026-09-29 Scout桌面參考](review-assets/2026-09-29-followup/scout-report-white-current-desktop-1440.png)

## 14. 本次依報告修復的項目（2026-09-30 追加）

以下項目已依本報告的驗收條件實作並補上回歸測試；其餘項目仍維持報告中的狀態描述。

### 已修復

| 項目 | 修復內容 | 測試 |
| --- | --- | --- |
| R01 | Build／Train 成功路徑不再呼叫無條件 `clearOutbox`。新增 `clearOutboxWhenQuiescent()`：只有當 durable 副本既無 pending 也無 rejected 時才刪除 owner key | `web-src/sync-outbox.test.js` |
| R03 | `restoreOutbox()` 會還原 `buildRejected`／`trainRejected` 並回報筆數；`persistOutbox()` 回傳寫入結果，storage 失敗時明確提示「只保留在此頁面」 | 同上＋`tests/test_improvement_review_fixes.py` |
| R04 | `saveOutbox()` 改為逐筆合併（依 tempId／node id／attempt_uuid），並以 settled tombstone 記錄已確認操作，避免舊分頁快照覆蓋或復活別的操作；Build 取得鎖失敗時會排程重試 | `web-src/sync-outbox.test.js` |
| R05 | 逐筆隔離改為 parent-before-child 排序（`web-src/build-queue.js`），每筆成功回傳的 `id_map` 餵給後續操作；delete 的失敗同樣分類，暫時性錯誤會連同後續操作回到佇列；已解決的操作會 reconcile 到畫面並回報 settled | `web-src/build-queue.test.js` |
| R02（部分） | 每筆 Build 操作帶 `repertoire_id`，flush／hard-flush／beacon 只送出目前開啟 repertoire 的操作；`hydrateBuild()` 不再清空其他開局的恢復資料，並把本開局未同步的節點重新插回樹中 | 前端無單元測試層，驗證靠既有 107 個測試檔與 lint |
| D02 | `due_counts_by_repertoire()` 以遞迴 CTE 只計「有效啟用子樹內、且為可訓練己方著法、且 mastery 為 due（先判 weak）」的節點，與 `compute_health().due` 定義一致 | `tests/test_improvement_review_fixes.py`（停用祖先、weak 優先序） |
| D03 | 每個棋局的最新快照改用 `ROW_NUMBER() OVER (PARTITION BY game_id ORDER BY analyzed_at DESC, id DESC)`，同時間平手也能唯一決定，分頁鍵維持不變 | 同上（同秒快照只顯示一次） |
| D05 | 帳號刪除的 domain 與身分兩段共用同一個 transaction（`delete_owner_data(conn=...)`），失敗時整體回滾 | 同上（注入第二階段失敗後資料與帳號皆完整） |
| F04 | Analyze checkpoint 改為 owner-scoped key 加上索引，未指定 game id 時取「最新一份」而不是第一個命中；checkpoint 寫入失敗時文案改為「只保留在此頁面」 | `web-src/analyze-checkpoint.test.js` |

### 未修復（維持報告原狀態）

- **D01**：前端送出 `base_revision` 與伺服器端「同交易內條件更新」必須一起完成，否則只送欄位會讓衝突後的草稿卡住且無解決路徑；目前 409 分支仍只保留草稿。
- **D04**：離線重播期限需要 API 契約與舊版客戶端相容的欄位，未在本次加入。
- **A01～A06**：屬於演算法與資源調配的產品決策，需先定義資料契約與量測方法。
- **F01～F03、F05**：需要寄信服務與新的 UI 入口，屬產品功能而非本次缺陷修復範圍。
- **U／V／M、D06**：介面層級與效能量測工作，需先有使用者研究或基準資料。
