# PrepForge Chess 詳細改善檢查報告（最新版本複查）

檢查日期：2026-09-29，America/Phoenix。  
檢查版本：HEAD `b0dee11`，包含合併的第一批改善提交 `450f539`。  
範圍：UI、資料庫互動、演算法處理、功能設計、視覺效果、使用者體驗簡潔化。  
交付：本報告與檢查截圖。沒有修改產品程式、資料表、套件、部署設定或既存報告。

## 1. 結論與優先順序

目前產品的主要功能已連成完整流程：棋譜匯入 → 分析 → 補進開局準備 → 訓練 → 實戰比對 → 偵察對手。底層也已有多租戶所有權驗證、瀏覽器引擎、批次儲存、訓練重試收據、明暗主題、鍵盤棋盤與 UI smoke。下一輪的最大收益，來自**讓儲存真正可恢復、讓統計與排程說同一件事，以及讓每個畫面更直接指向下一個動作**。

本次有幾項新增或修正後才看清楚的問題：

1. **Build 仍會丟棄所有 4xx 失敗批次。** Train 已修正，Build 尚未採用同樣的錯誤分類；登入過期、CSRF 或限流也可能被當成不合法編輯。
2. **訓練的混合失敗仍有通知缺口。** 同一次 flush 先遇永久拒絕、後遇暫時失敗，永久拒絕有回傳，但 UI 的可重試分支沒有顯示它。
3. **重新分析會累積重複解說。** 實際 API 連續分析同一盤棋後，第一步解說從一行變成兩行。
4. **分析輸入的欄位驗證仍不完整。** `score_cp` 傳入非數字字串，可重現 HTTP 500。
5. **健康統計與訓練排程對停用祖先的處理不同。** 在「祖先停用、後代啟用」的區域性樹狀態中，健康統計計入後代，訓練排程不會出題。
6. **長期答錯後近期進步，仍可能同時被標示為已精熟及弱項。** 這會妨礙使用者理解訓練成效。

### 1.1 建議先處理的項目

| 優先度 | 項目 | 理由 | 證據 |
|---|---|---|---|
| P1 | R-01 Build 的 4xx 批次處理 | 可能丟失尚未確認的編輯，Saved 語意失真 | 程式碼確認 |
| P1 | R-03 可恢復的本地待同步佇列與登出處理 | 重整／關閉／登出仍可能失去未送達資料 | 程式碼確認；完整中斷 E2E 待補 |
| P1 | F-01 公開分享可撤銷 | 設成 private 不會撤銷既有公開連結 | 路由及 UI 程式碼確認 |
| P1 | F-02 帳號復原 | 電子郵件密碼登入缺少自行復原路徑 | 路由盤點 |
| P2 | R-02 混合失敗的永久拒絕通知 | 部分訓練紀錄可能被丟棄而沒有對應說明 | 函式重現＋UI 分支確認 |
| P2 | A-01／A-02 精熟判定與有效分支一致性 | 統計和實際排程不一致 | 純函式重現 |
| P2 | A-04 重新分析解說去重 | 閱讀負擔與資料來源混淆 | API 重現 |
| P2 | D-03 分析輸入驗證 | 壞資料回 500，無法指引使用者修正 | API 重現 |
| P2 | D-01 時間相關 health 快取 | 今日待複習數可能停留在舊時間 | 程式碼確認 |
| P2 | D-02 多分頁 revision 契約 | 區域性變更與過期資料需要明確衝突處理 | 結構性風險 |
| P2 | U-02／U-03 Scout 首屏與手機任務介面 | 降低判斷量及往返捲動 | 本次截圖＋設計評估 |
| P2 | V-01 棋盤座標對比 | 主要使用場景的定位文字偏淡 | token 計算＋截圖 |
| P3 | 大樹 DOM 更新、資料生命週期、維護邊界 | 隨資料量及功能擴張逐步改善 | 程式碼盤點；效能待量測 |

P1：應優先排入下一輪，涉及資料儲存、分享控制或主要功能可用性。P2：重要正確性與體驗改善。P3：可依實際用量逐步安排。這些等級不代表已發生正式環境事故。

## 2. 檢查方法、驗證與限制

### 2.1 本次實際驗證

| 檢查 | 結果 | 解讀 |
|---|---|---|
| `npm test -- --reporter=dot` | 109 個檔案、1,653 個測試透過 | 現有前端單元及回歸測試透過 |
| `.venv/Scripts/python.exe -m pytest -q` | 656 透過、12 skipped、5 deselected | 預設後端測試透過；略過與排除不算透過 |
| `npm run smoke:ui-v2` | 9／9 透過 | 八個頁面與跨頁狀態，在既有 fixture 及斷言下穩定 |
| UI viewport | 1440×900、1180×900、390×844 | 未發現 smoke 所檢查的水平溢位或 console error |
| 額外截圖 | Train／Scout 的 setup、active、play、白黑方報告等 | 使用目前已建置 static 資產與測試資料 |
| 同步探針 | 422 後接 503，得到 `rejectedGroups` 與 `failedGroups` 同時非空 | 可確認混合失敗結果，UI 分支仍未完整呈現 |
| 樹遍歷探針 | health trainable=1，scheduler cards=0 | 可確認停用祖先與啟用後代狀態下的不一致 |
| SRS 探針 | 100 次錯後連對 10 次：score=10、is_mastered=true、顯示 weak | 可確認判定矛盾，不是估測 |
| 隔離 API 探針 | 連續兩次 classify-save 均 200；解說行數由 1 增至 2 | 可確認同盤重分析累積解說 |
| 隔離 API 壞資料探針 | `score_cp="bad-value"` → 500 | 可確認欄位驗證未涵蓋此情境 |
| 本機工具版本 | Vite 8.3.1、Vitest 5.0.2、ESLint 10.11.0 | 上份報告的工具版本落差在本機已不再成立 |

Python 出現一項 Starlette TestClient／httpx deprecation warning，沒有將它列為產品故障。完整後端執行約 106 秒。

### 2.2 證據邊界

- 本次沒有連線正式 PostgreSQL、Render、真實 Stripe 或 OAuth 帳號；不判斷正式資料量下的查詢延遲。
- UI smoke 服務的是 repository 內目前的 static 產物。本次沒有重建 bundle；原始碼的檢查與建置產物的檢查分開解讀。
- UI fixture 驗證版面與互動，不代表所有真實帳號、模型下載、長局棋譜、網路中斷與多裝置情境。
- 本次未重新執行完整 axe 掃描，也未完成 Safari／iOS、200% 縮放、軟鍵盤與螢幕閱讀器驗證。
- 純函式樹探針刻意建立「停用祖先＋啟用後代」邊界狀態，不表示每次停用分支都會出問題；一般停用操作會遞迴停用後代。
- 隔離 API 探針使用臨時 SQLite，不操作專案既有資料庫。臨時檔案清理遭工具政策阻擋，留下 Windows TEMP 內的檢查檔；不影響測試結果。
- 下文「建議」屬設計提案；驗收數值是建議目標，沒有將它們寫成本次已達成的效能。

### 2.3 最新版本已改善的項目

| 上份報告項目 | 最新狀態 | 仍需關注 |
|---|---|---|
| Train 所有 4xx 都丟棄 | 已分類 401／403／409／429 等可重試情況 | Build 未同步採用；混合拒絕通知有缺口 |
| 評估列可被後續提交覆寫 | 已改 fingerprint＋不可變 snapshot | engine／模型版本、來源與生命週期仍可完善 |
| 目標深度冒充實際深度 | 已儲存每局面的實際 depth、nodes | 結果總覽仍可說明目標與實際品質分佈 |
| engine 浮窗高於 modal | 已引入 `--z-*`，tool 層低於 overlay | toast 仍在 overlay 上方，要檢查互動遮擋 |
| palette 與導覽名稱不同 | palette 已使用 Library／Repertoire／Games／Scout | 個別提示仍有 Build 等內部舊稱 |
| 工具安裝與 lock 版本不同 | 本次版本已一致 | 維持 CI、開發與 bundle 驗證流程 |

同樣不應重新列為「尚未修正」的，包括 codec 的單 Board push/pop、lightweight repertoire listing、request-scoped tree cache、due 索引、設定分割槽、手機底部導覽及語意文字色 token。

## 3. UI 與資訊架構

### U-01｜P2｜保留一致命名，進一步統一動作和提示

**現況與證據：** `web-src/command-palette.js` 的主要 view labels 已和導覽一致，但 repertoire 項目的 hint 仍是 `Open in Build`。頁面也混用 Start、Resume、Analyze、Add to prep 等不同層次的動作。

**影響：** 熟悉棋類的人可以理解，但第一次使用者仍需自行建立「Repertoire＝Build」「Play vs human＝Maia／資料庫混合對手」的對映。

**改善方向：** 以動詞表統一建立、分析、加入準備、開始／繼續練習。顯示名稱與舊名搜尋 alias 分開維護。不要因命名統一而改掉內部 route ID；只需讓使用者看到的文字一致。

**驗收：** 導覽、palette、空狀態、handoff、選單及手機 More 使用相同功能名；每個 Start 能從附近文字看出啟動什麼；搜尋目前看見的名稱能到達對應功能。

### U-02｜P2｜Scout 首屏先回答準備重點，再展示統計

**現況：** 本次 1440px 截圖中，來源、速度、白黑分頁、得分、coverage、六條摘要、五個風格標籤、第一步分佈及路線表同時出現。右側還有棋盤、得分說明和應對動作。

**影響：** 統計完整，但使用者要先閱讀多個指標，才能決定今天準備哪條路線。MAIN／ATTACK、歷史得分百分比、樣本數與 needs prep 的重要性互相競爭。

**改善方向：** 首屏只突出「前三個準備重點」，每項包含路線、一句理由、缺口與一個主要動作。完整路線仍可檢視；風格、活動時間、信心和方法放在可展開的證據區。選中路線後，再看詳細棋盤及來源對局。

**驗收：** 使用者 30 秒內可回答「最可能遇到什麼、我的準備缺什麼、下一步做什麼」。專業使用者仍能追查支援樣本與模型依據。

![最新 Scout 首屏](review-assets/2026-09-29-followup/scout-report-white-current-desktop-1440.png)

### U-03｜P2｜手機訓練介面以當前題目為中心

**現況：** 390px active 截圖由棋盤、棋盤工具列、Your move 卡、三個模式、Card 進度、組成色條、legend 與動作區往下排列。底部導航固定，狀態 toast 也會出現在接近動作區的位置。

**影響：** 使用者需要捲動才能同時掌握局面與操作；進行中的題目仍和模式切換競爭注意力。這是任務安排問題，smoke 的「沒有溢位」不會捕捉它。

**改善方向：** 進行中把模式收成一行摘要或 session 選單。棋盤附近固定一句題目指令與必要的提示／下一題。佇列組成可折疊，完整統計留在結束時。需保留夠大的棋盤，不用過度縮小棋子換空間。

**驗收：** 390×844、360×640、橫向與軟鍵盤狀態下，下一步動作可找到；模式切換會清楚交代當前 session 如何處理；toast 不遮住關鍵操作。

![手機訓練狀態](review-assets/2026-09-29-followup/train-active-current-mobile-390.png)

### U-04｜P2｜大型走法樹保留焦點與捲動位置

**證據：** `views/build.js` 建立 normalized tree 並替換 tree 容器 `innerHTML`；`views/shared/movetree.js` 每個 move button 個別綁 listener，點選後呼叫 `blur()`。

**影響：** 大樹重新渲染可能增加 DOM 成本，也可能讓鍵盤使用者失去焦點。這不是本次已量測的效能故障；目前 smoke 的小樹不足以判斷 2,000 節點表現。

**改善方向：** 先用事件委派，選中變化只更新必要 class 與側欄。結構變更重渲染時儲存選中節點、展開狀態、focus 與 scroll。預設只展開當前路徑及近旁分支，是否需 virtualization 由量測決定。

**驗收：** 500／2,000 節點下記錄載入、選取、增刪分支耗時；連續鍵盤選取不會掉回 body，刪分支後不跳到列表頂部。

### U-05｜P3｜建立頁面狀態矩陣

建議逐頁列出 empty、loading、ready、partial、offline、saving、save failed、permission lost。Library 已有 retry 和 state smoke，應將這種「錯誤後可以繼續完成任務」的設計帶到 Analyze、Build、Scout。每種狀態只放一個最相關的恢復動作，例如重新登入、重試儲存、只重試失敗來源；不要全部變成 Try again。

**驗收：** 每個狀態能說明現在保留了哪些成果、接下來做什麼；錯誤訊息和恢復入口靠近出錯區域，沒有隻靠短暫 toast 的重要資訊。

## 4. 資料庫互動與持久化

### D-01｜P2｜health 的靜態統計與時間相關數字分開

**證據：** `repositories.py:list_owner_repertoire_listings()` 直接讀 `health_json`；`workspace_view.py` 開啟／修改與 Train summary 才重新整理。`node_mastery()` 的 due 判定則依當前時間。

**影響：** 沒有任何編輯或訓練，也可能在 due_at 到期後需要新數值；舊快取不能自己更新。Library badge、Dashboard 今日待複習與 Train 實際佇列可能不同。

**改善方向：** 靜態 trainable／shallow coverage 可以快取；due 等時間數字採 owner-scoped 聚合查詢或帶有效期限的快取。若儲存 health，附 `computed_at`、tree revision 和 progress revision。不要為了新鮮度讓 Library 重新載入每棵完整樹。

**驗收：** 時鐘跨過 due_at、跨日、另一裝置訓練後，列表與訓練入口的數字符合定義；列表 SQL statement 數不隨 repertoire 數形成 N+1。

### D-02｜P2｜Build 要有明確 revision 與衝突契約

**證據：** repertoire schema 有 updated_at，沒有顯式 revision；Build add／delete／action payload 未帶 base revision。已有區域性 SQL 更新，不能因此直接認定所有修改都會整樹覆寫。

**風險情境：** A 分頁刪除分支，B 仍在舊 parent 上新增；兩個分頁修改同一註解或主線；一個分頁生成時另一個分頁修改錨點。

**改善方向：** 對需要一致性的結構／metadata 修改送 base revision，回傳最新 revision。可合併的新增自動合併；不可合併的同欄位修改回衝突，保留本地草稿及清楚選項。operation ID 與 revision 用途不同：前者防重複，後者防過期更新。

**驗收：** 多分頁／多裝置衝突不會靜默丟掉任一方草稿；父節點被刪時，可選擇重選位置或保留線路供重新加入。

### D-03｜P2｜Analyze positions 應使用有邊界的型別契約

**證據：** `ClassifySavePayload.positions` 為 `list[dict[str, Any]]`；路由確認 item 是 object、有 fen，但評分等欄位後續直接轉 int。`browser_compute.py` 的 `_evaluation_from_client()` 對錯誤字串會 ValueError，而此路徑只捕捉 `ReplayEngineError`。本次在隔離 API 確認 `score_cp="bad-value"` 回 500。

**影響：** 客戶端 bug 或不完整舊 payload 會呈現伺服器錯誤；使用者不知道哪個欄位有問題。position 數量上限已存在，卻不等於每筆內容都受限。

**改善方向：** 建立明確 position payload 型別，驗證有限數字、合理 depth／nodes／mate、UCI 型式、PV 長度與 engine 字串長度。對局面集合檢查缺項與重複衝突。可保留需要相容的 legacy 欄位，但應有版本與清楚 fallback。不要把這項理解成重新在伺服器計算引擎結果。

**驗收：** 不合法 score、PV、depth 與缺少局面均回可理解的 4xx，沒有部分寫入；普通有效提交及 terminal depth=0 正常。

### D-04｜P3｜消除分析結果的重複寫入

**證據：** `analyze_classify_save()` 先呼叫 `save_game_batched(game, result, ...)`，再呼叫 `save_analysis_result(result)`。前者經 `_save_moves_batched()` 已在同一 transaction upsert analysis_results。

**影響：** 第二次 upsert 增加一次 transaction 與資料庫往返。若第一次已成功、第二次出錯，API 可能報失敗，但結果其實已存；這是可觀察性與成本問題，不是第一次儲存缺少原子性。

**改善方向：** 讓儲存動作只有一個責任入口，server timing 反映實際 transaction。移除前先檢查兩條路徑的資料欄位與歷史語意完全一致。

**驗收：** 一次 classify-save 只儲存一次 analysis record；儲存完成但回應丟失後，可用 operation identity 查回，不產生不必要重分析。

### D-05｜P2｜列表與歷史查詢應為大帳號準備分頁

**證據：** `list_owner_repertoire_listings()` 與 `list_analyzed_games()` 使用 `.all()`，未在該函式限制頁數；analysis 最新時間 subquery 先跨 games 分組，外層再 owner 篩選。

**影響：** 初期資料少不明顯，長期大量匯入時可能拉長首屏載入或聚合成本。本次沒有 PostgreSQL EXPLAIN，不能聲稱現有查詢已很慢。

**改善方向：** 為歷史清單加入固定 page size 與穩定 cursor；最新分析聚合儘可能先限定 owner 相關 games。按實際查詢計畫評估 owner／updated_at、game／analyzed_at 索引，不一次增加所有猜測索引。

**驗收：** 1,000／10,000 盤棋下量測 p50／p95、回應大小與 statement 數；載入下一頁不漏掉時間相同的記錄，也不重複。

### D-06｜P2｜不可變快照之後，增加資料生命週期

評估 fingerprint 修正值得保留，但也使不同結果產生新 snapshot。需盤點 position、evaluation、分析歷史與 train receipt 的增長和引用關係。刪棋譜／repertoire／帳號後，哪些應立刻刪，哪些仍被別人引用、哪些要延後回收，應有一致規則。

**改善方向：** 未被引用的資料採保守、可 dry-run 的回收；receipt 保留期間要長於允許離線重試的期間，避免清理後重播又計分。刪除使用者資料與共用引擎資料不是同一種 cascade。

**驗收：** 刪帳號／刪樹不影響其他帳號；回收前後有數量報告；離線重播仍保持冪等。既有備份指令碼應配合實際還原演練，不把「有指令碼」當成正式可恢復已驗證。

### D-07｜P3｜設定 JSON 的容量與用途要匹配

`api/models.py` 的 `user_settings.value_json` 使用 `String(4000)`，但存放的不只是簡單偏好，也包含部分使用狀態與摘要。SQLite 與正式資料庫對型別長度限制的行為未必相同。

**改善方向：** 盤點每個 key 的最大內容和是否成長。小型偏好保留簡單儲存；可成長資料應另有明確 schema／容量策略。若改 Text／JSON，也要設合理內容上限，而非任由單一 blob 無限增長。

**驗收：** 大帳號與 4,000 字邊界在正式資料庫方言下有測試；超限不會變成看不懂的儲存失敗。

## 5. 演算法與結果可信度

### A-01｜P2｜精熟與弱項判定需統一，反映近期進步

**證據：** `update_spaced_repetition()` 正確答案使 score 加一，上限 10；錯誤使 score 減半。is_mastered 依 score≥7 且累計 correct≥3。`progress.py:node_mastery()` 卻先用終身正確率<50% 判 weak；scheduler 的 weak 排序也使用終身比例。

**重現：** 100 次錯後連續答對 10 次，score=10、is_mastered=true，顯示狀態仍是 weak。這顯示原始統計、顯示分類與排程判斷對「精熟」的定義不同。

**改善方向：** 同一份有效精熟訊號供顯示與排程共用，考慮近期答案、連續正確、實際複習間隔與近期失誤。保留終身統計作歷史，不再讓早期失誤永久壓住近期進步。演算法調整需有版本與舊進度轉換規則。

**驗收：** 新卡答對、長期錯後改善、精熟後答錯、長期未複習等 scenario 的狀態一致；使用者知道改善多少才會離開弱項。

### A-02｜P2｜統計和排程共享「可到達且有效」的節點定義

**證據：** `progress._walk()` 走所有 children，再由 `_is_trainable()` 看單一節點 enabled；scheduler `_collect_candidates()` 在 disabled 節點直接停止往下。一般 disable_branch 會遞迴停用後代，但 enable_branch 對選中子樹啟用，不自動處理祖先；在停用節點下新增 child 也值得檢查。

**重現：** 合成 root→disabled parent→enabled own-move descendant：health trainable=1、untrained=1；scheduler cards=0。

**改善方向：** 共用 effective-enabled traversal，定義祖先停用是否讓所有後代不可到達。若允許單獨重新啟用後代，UI 要解釋或一併恢復祖先；不要讓健康統計自認為可練而訓練不出題。

**驗收：** 停用整支、啟用子支、在停用節點下新增、匯入區域性 enabled 樹後，health trainable 與 scheduler 候選集合一致。這項應列為邊界正確性，不誇大成正常所有停用操作都錯誤。

### A-03｜P2｜SRS 間隔與佇列配置要以學習結果調整

**現況：** 正確答案間隔約 1～10 天，最終固定最多 10 天；weak 前段最多 60%，其後 due→new（最多四個）→polish，再以 weak 補滿。已有 weak 配額，不能繼續宣稱完全沒有防排擠。

**改善方向：** 長期記得的內容可延長間隔；近期錯誤重練和真正跨日回憶要分開。提示／揭示後走對應保持不計初次回憶成績的現有精神。不要直接採用任意倍增公式；先比較固定基準與候選排程的延遲保留率。

weak 配額也不等於 new／polish 保底：大量 due 仍可用盡剩餘容量。是否保留少量新題，應依使用者想「先清欠帳」或「繼續擴充」決定，並可說明剩餘新卡。

**驗收：** 7／14／30 天延遲回憶、每日待複習數、完成率與弱項退出時間可比較；session 開始顯示「7 個弱項、5 個到期，今天先複習」等簡單理由，而非解釋整個演算法。

### A-04｜P2｜重新分析應更新引擎解說，不反覆附加

**證據：** `browser_compute.py` 用既有 `move.comment` 加換行再附分類 reason。PGN 去重讓重複分析讀既存 game，其中 comment 已包含上一輪解說。

**重現：** 隔離 API 同一盤連續兩次 classify-save 均回 200，第一步 comment 行數由 1 增至 2。純函式也重現兩段相同的 `matched Stockfish first choice`。

**影響：** 重新分析次數越多，解說越長；使用者手寫／匯入註解與模型解說混在同一欄位。當結果變化，舊 reason 與新 reason 可能同時存在。

**改善方向：** 原始註解、使用者註解與 generated explanation 分開，重跑只替換該次生成內容。儲存演算法版本與 analysis_id，避免靠文字辨認哪些段落可刪。

**驗收：** 同盤連續三次分析、深度改變、帶 PGN comment、使用者新增註解後重分析，原註解完整保留且當前解釋不重複。現有 reanalysis 測試第二次分類使用乾淨 deepcopy，尚不足以保護「從 DB load 後重跑」的路徑。

### A-05｜P2｜搜尋品質與模型缺項應進入報告內容

**現況：** 已儲存實際 depth／nodes，是重要修正。但 AnalysisResult 頂層 depth 仍是請求深度；瀏覽器 Maia 失敗時清空 assessments 並繼續儲存。

**影響：** 使用者可能把一個部分淺層／無 Maia 的結果，理解為全域性已用相同深度與完整功能分析。沒有 brilliant 不一定代表「不存在」，也可能是相關檢查未完成。

**改善方向：** 儲存 target depth、實際 depth 分佈、哪些局面接受淺層結果、Maia status／版本／rating、classification 版本、engine artifact identity。頁面只顯示簡短品質摘要，詳細 metadata 放進可展開說明。缺 Maia 時仍保留 Stockfish 結果，並提供之後補做的入口。

**驗收：** 報告可區分「完整」「部分淺層」「未做 Maia」；模型恢復後不必重跑所有客觀評價；演算法升級後舊報告可追溯。

### A-06｜P2｜Scout 的歷史證據不要呈現成確定預測

**證據：** 當前生產邊界是 `scout-selector.js` 的 Scout v2；`scout-preparation-value.js` 明確說明 observed-decision reach 不是 calibrated forecast，也已有去重覆蓋、Wilson 保守估計和有限 Maia prior。這些設計應保留，不應用退役研究版本來評價生產。

**改善方向：** 清楚區分歷史頻率、樣本支援、客觀評價、Maia 人類模型與準備價值。得分是贏＋和棋折算的歷史 score 時，避免被當成預測勝率。顏色建議應說明是過去對局的觀察，可能受對手強度、速度與時間影響；現有 confidence qualifier 不應被刪掉。

評估採用按時間切分的「過去準備、未來驗證」，並與簡單頻率 top-k 比較。在近期改變開局、小樣本、單一長局、多來源帳號和同路線共享決策等情境下分別觀察。

**驗收：** 預設 top-3 與完整預算的未來覆蓋、客觀可行性、重複覆蓋與單位準備時間收益有固定基準；不把最佳化後的內部 score 增長直接當成使用者勝率提升。

### A-07｜P2｜單 FEN 分析與歷史和棋條件分開

`game-analyzer.js:isTerminalPosition()` 為每個 FEN 新建 Chess 再查 isGameOver。單 FEN 可以識別將死、逼和與部分其他終局條件，但無法重建先前三次重複所需的歷史。

**改善方向：** prepare payload 傳入原棋譜歷史中的終局狀態／原因，或在需要時從初始局面與走子序列判斷。開局探索的「局面評價」和實戰棋譜的「當時已結束」應分開；可申訴和棋與自動結束的規則也要使用明確語意。

**驗收：** 重複局面、半回合計數邊界、將死／逼和、非法 FEN 等情境，報告與實際棋譜狀態一致。不要僅憑函式註釋就宣稱已經覆蓋歷史重複。

## 6. 功能設計與完整性

### F-01｜P1｜公開分享連結應可獨立撤銷

**證據：** `workspace.py` 的公開 token 是 repertoire id＋HMAC，無期限，也無獨立撤銷資料；讀取 `/shared/{token}` 未依據 team/private visibility 拒絕。UI 取消團隊分享後顯示 `Repertoire is now private`。

**影響：** 使用者容易理解成所有分享都結束，但公開連結仍可讀樹的名稱、走法與註解。公開 payload 已剝除訓練狀態、寫入仍檢查所有權，應保留這些保護；問題是分享治理與語意。

**改善方向：** 分享面板分開顯示「團隊」「持有連結的人」。公開分享可關閉、重新產生連結、設定期限。可用每 repertoire 的 share version／nonce 或獨立 link record，不能依賴輪換整個站點 secret 撤銷單一連結。

**驗收：** 撤銷後舊連結無法讀取；團隊許可權變化與公開連結的效果明確；不會連帶撤銷所有使用者連結。已由別人複製的樹無法追回，這一點應在複製語意中說明。

### F-02｜P1｜補齊密碼復原與登入方式說明

**現況：** 有 register／login／logout／me／providers 與 OAuth，但本次 auth 路由盤點未見密碼復原流程。

**改善方向：** 為電子郵件密碼帳號提供自行復原途徑；OAuth 帳號則說明可用哪種登入方式，避免誤導使用者以為已有密碼。復原 token 的期限、一次使用與會話失效策略要和帳號安全契約一致。電子郵件驗證是相關但不同的產品決策。

**驗收：** 忘記密碼、過期連結、重複使用、OAuth-only 帳號與復原後重登入均可完成；錯誤狀態不讓使用者反覆嘗試不適用的方法。

### F-03｜P2｜長任務保留 checkpoint 與儲存重試

**證據：** Analyze 的 evals 與 Maia assessments 在 runAnalysis 區域性範圍內，最終 classify-save 失敗後只顯示錯誤／登入提示，沒有儲存這些成果供後續恢復。已有取消 checkpoint，但不是持久化 checkpoint。

**改善方向：** 按 game／job identity 儲存輸入、引擎版本、已完成 evaluations、階段與未確認請求。儲存失敗先提供「重試儲存」，不預設重新分析。Generate 同樣應區分計算 plan 完成與 apply-plan 確認，儲存一次可重播操作。

**驗收：** 計算完成後斷網、登入過期、重整、伺服器已存但響應丟失時，都能恢復；不會重複新增或要求重新下載所有模型。

### F-04｜P2｜多棋譜 Analyze 匯入語意要明確

**證據：** `_import_pgn_for_analysis()` 呼叫批次 PgnImportService，後者逐盤儲存；最終只回傳第一個 imported id，或全部重複時的第一個 skipped id。混合「首盤已存在、第二盤新匯入」時，也可能選擇新匯入那盤。

**影響：** 使用者貼入多盤棋時可能後臺儲存多盤，但只分析其中一盤。若後面某盤錯誤，前面的儲存也可能已發生，頁面卻只顯示匯入失敗。

**改善方向：** 單盤模式先驗證只有一盤、再儲存；批次模式顯示盤數、已存在／新增／失敗並讓使用者選擇。不要將部分匯入偽裝成全失敗，或在無提示下選擇其中一盤。

**驗收：** 兩盤全新、首盤重複＋次盤新、首盤有效＋次盤無 moves，行為和文案一致，使用者知道實際儲存內容。

### F-05｜P2｜帳號資料匯出／刪除應形成可完成流程

**現況：** 有 repertoire JSON／PGN 匯出，隱私頁也提到可聯絡要求帳號資料匯出與刪除；本次未見完整自助帳號資料管理入口。不能把已有 repertoire export 說成完全沒有匯出。

**改善方向：** Account 的資料管理整合帳號、棋譜、開局、訓練進度的範圍與匯出格式。刪除要涵蓋分享、連結帳號、會話與相關資料保留邊界。若初期使用人工處理，也應提供明確入口、處理狀態與確認結果，不只有政策文字。

**驗收：** 使用者能從設定找到途徑並完成；資料範圍和實際輸出一致；刪除不會留下仍可使用的會話或未撤銷分享。

### F-06｜P2｜跨模組交接保留任務上下文

當前已有 Analyze→Repertoire、Scout→Add to prep、Games→Train／Analyze 的交接，應進一步儲存來源棋譜／路線、ply／anchor FEN、使用方、repertoire 與觸發原因。

**改善方向：** 讓「補這個失誤」進入對應局面，而非讓使用者重新找整盤棋。回到原頁能恢復選中路線與過濾條件。handoff 能在真正必要時確認目標，單一明確目標不多加一步。

**驗收：** 分析一個關鍵失誤到第一次練習的步驟與耗時可量測；重複點選不會複製同一線；白黑方、轉置與不同 root FEN 不會交錯。

### F-07｜P3｜團隊複製與實時分享語意需區分

團隊只讀與 fork 新 ID 已有基礎。使用者仍需知道「看教練最新樹」與「複製到自己帳號」的區別。複製後是否繼續收到更新，當前副本是什麼版本，應該一句話說明；沒有需求前，不必建立複雜雙向同步。

**驗收：** 教練改樹後，原共享檢視更新、副本保持獨立；成員許可權失效後不能再讀原樹；已有副本的保留行為符合明確產品定義。

## 7. 視覺效果與可讀性

### V-01｜P2｜棋盤座標對比需要單獨改善

以當前 `styles.css` 基礎 token 計算，而非採用舊棕色棋盤截圖：

| 主題／背景 | 文字色 | 背景色 | 對比約值 |
|---|---|---|---|
| 淺色／淺格 | `#6f8394` | `#e4e8eb` | 3.19:1 |
| 淺色／深格 | `#eef1f3` | `#97a8b6` | 2.15:1 |
| 深色／淺格 | `#5a6c7b` | `#b9c3cb` | 3.03:1 |
| 深色／深格 | `#d8dee3` | `#6f8292` | 2.93:1 |

座標有定位用途，應按有意義的小文書處理。一般文字 AA 最低對比為 4.5:1；這些基礎組合均低於該值。[W3C 對比最低要求說明](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)

**改善方向：** 座標移到棋盤邊框，或使用更明確的底板／墨色。需考慮 last-move、高亮、箭頭與棋子遮擋後的實際背景，不能只改一個顏色 token 就宣佈全面透過。

**驗收：** 明暗主題、翻轉棋盤、最後一步高亮、手機小棋盤均可清楚定位；計算完整實際組合並加入迴歸檢查。

### V-02｜P2｜提升閱讀舒適度，減少正文與輔助資訊競爭

**證據：** 當前 base 13px、small 12px、extra-small 11px，部分 rail 輔助文字更小。Scout 一行內經常有路線、時間、樣本、百分比、標籤與圖形。

**改善方向：** 主要任務文字與提示優先用更易讀的字號、字重與行距；時間與樣本保持輔助層級。SAN／UCI 可保留等寬，普通句子用正文字型。密度高時先減少常駐內容，再考慮擠小字號。

**驗收：** 200% 縮放及筆電小屏下主要文字不截斷；兩步之內找到輔助證據。以實際使用者閱讀速度驗證，不能只看 CSS 數值。

### V-03｜P2｜一個區塊只突出一個主要動作

Scout 同時有 Resume、Deep scan、Add all gaps、Analyze、Add to prep 與每行加號；Train Play 在還沒開始時也顯示 Takeback／Resign／Analyze 的 disabled 操作。

**改善方向：** setup 只顯示開始相關選項，進行中才顯示對局操作；主結果卡突出當前準備動作，批次匯入與深度分析放次要選單。多動作不是一定錯誤，關鍵是每個狀態的視覺優先順序明確。

**驗收：** 新使用者能不讀長說明就指出當前主動作；進階操作仍在可預測的位置；重要能力不能僅因簡化被隱藏到無法發現。

![Train Play setup 的常駐與未啟用操作](review-assets/2026-09-29-followup/train-play-current-desktop-1440.png)

### V-04｜P2｜層級修正後，檢查通知與模態組合

engine 浮窗低於 modal 已修正，但 `--z-toast:1200` 仍高於 overlay 1000、menu 1100。本次手機截圖也見 toast 接近底部動作用途區域；未針對每個按鈕做 hit-test，不能斷言本次所有這些按鈕都無法點選。

**改善方向：** 將普通成功提示與必須響應的錯誤分開。modal 期間普通 toast 可延遲或改置於安全區，重要錯誤則在對話方塊內呈現。手機主要 CTA 的安全區與底部導航一起規劃。

**驗收：** toast＋確認 modal、palette、More sheet、模型錯誤等組合有截圖與點選檢查；不能僅檢驗 z-index 數字順序。

### V-05｜P3｜統一圖示與視覺節奏，保持棋類辨識度

rail 圖示已有統一方向，但棋盤工具列仍可見 emoji 與符號混用。跨 Windows／macOS／移動系統可能呈現不同顏色與基線。

**改善方向：** 普通操作採用同一 SVG 圖示體系，棋子／走法保留棋類語意；圓角、間距與卡片 padding 使用少量穩定 token。現有 reduced-motion 設計應保留，不為「視覺效果」加入持續閃動或裝飾動畫。

**驗收：** 圖示文字替代與 tooltip 合理、手機可觸及；主要任務視覺迴歸包含明暗主題與錯誤／空狀態。

## 8. 使用者體驗簡潔化與儲存可靠性

### R-01｜P1｜Build 不應把所有 4xx 都丟棄

**證據：** `app.js:flushBuildMoves()` 先取出 batch 並清空 pending，catch 遇任何 400～499 都直接走「丟棄批次＋盡力重新讀取」；若沒有後續 pending，可能設為 saved。不同於已修正的 Train，Build 不區分 401、403、409、429。

**情境：** 在登入過期／CSRF 失效／短暫限流時新增分支，失敗批次沒有重新排隊。reload server truth 成功會消失；reload 也失敗時，本地畫面與後端不同，還可能顯示 saved。這是程式碼控制流程確認，完整 UI 中斷事故仍需 E2E 重現。

**改善方向：** 共用錯誤類別契約；驗證失敗保留草稿並清楚標記拒絕原因，暫時失敗保留完整 operation。重新登入與限流解除後再送，不能在未確認時切 saved。

**驗收：** 401／403／409／429 保留新增及刪除；真正不合法 payload 可隔離失敗項，不連帶清掉整批合法編輯；所有儲存提示都對應後端確認或本地持久化事實。

### R-02｜P2｜Train 混合失敗要分別呈現所有結果

**證據：** `flushGroups()` 可回傳 `retriable:true` 且 `rejectedGroups` 非空。`app.js:flushTrainSync()` 的 rejectedCount 通知卻只在 `!outcome.retriable` 分支執行；可重試分支只重新排 failedGroups。

**重現：** 第一組 422，第二組 503：第一組在 rejectedGroups，第二組在 failedGroups。UI 不在該輪提示第一組永久拒絕；之後第二組重試成功，也可能走 saved。

**改善方向：** 永久拒絕通知獨立於「是否還有待重試組」，持久保留已拒絕項供檢視／匯出／處理。儲存狀態可分「1筆未能儲存，2筆待同步」，不以單一紅／綠狀態壓縮全部結果。

**驗收：** 永久失敗→暫時失敗、成功→永久失敗→暫時失敗等組合，使用者都知道哪些已儲存、哪些會重試、哪些需要處理。

### R-03｜P1｜本地即時操作要補上可恢復儲存

**證據：** Build pending 與 Train pending 主要在 appState 記憶體；beforeunload 使用 keepalive fetch；signOut 先 POST logout 然後 reload，沒有先完成儲存協調。flush 已抽出批次時，pending 也不一定包含所有 in-flight 內容。

**影響：** 分頁關閉、瀏覽器被終止、斷網或登出後，未確認資料缺少持久化重播來源。keepalive 可讓請求在頁面解除安裝後繼續，但本身不是離線佇列或已儲存收據。[MDN keepalive 說明](https://developer.mozilla.org/en-US/docs/Web/API/Request/keepalive)

**改善方向：** 使用既有本地儲存策略建立 durable outbox，記錄 owner、operation UUID、payload、狀態與順序；先本地落盤再顯示可恢復狀態，後端確認後移除。登入帳號切換不得把 A 的待送操作發給 B。Build tmp→real ID 的對映與刪除依賴也需要儲存。

登出應先協調待同步內容；無法同步時可以保留本地待送成果並明確說明。不能把每次導航都變成確認框，只有真正不可恢復的風險才需阻擋。

**驗收：** 斷網操作→重整→同帳號登入後恢復；伺服器已成功但響應丟失不會重複計分；多分頁不會雙重送出；帳號切換不會串資料。

### R-04｜P2｜按錯誤種類恢復，而不是一律指數重試

Train 可重試狀態目前共用 backoff。401 需要重新登入，403 可能是 CSRF 或許可權，409 需要協調版本，429 需要等候；相同計時器無法解決所有原因。

**改善方向：** 網路／5xx 保持背景重試；401 暫停傳送並給登入入口；CSRF 更新後再送；許可權真正失效與 CSRF 分開；429 用服務回應的等待資訊；409 走明確衝突流程。儲存 pending 的動作不能依賴這些分類已經完美。

**驗收：** 沒登入時不會無限持續打 API；恢復操作後繼續同一任務；使用者看得到「等待登入」與「等待網路」的差異。

### R-05｜P2｜Scout 部分來源失敗需要留下可見證據

**證據：** `views/scout.js` 用 Promise.allSettled 匯流多使用者名稱，但只有 batchAccepted=0 且存在 failure 才拋錯；某來源失敗、另一個有資料時，不將各來源失敗顯示出來。

**影響：** 匯總報告看似覆蓋所有來源，實際可能只包含其中一個帳號。若從成功來源更新最舊時間，也需驗證失敗來源是否被共同 cursor 跳過；本次未宣稱已經發生漏抓。

**改善方向：** 來源 chip 顯示完成／部分／失敗與各自盤數，報告帶 coverage status；可只重試失敗來源，儲存 per-source cursor，不重抓成功資料。必要錯誤持久顯示，不只 toast。

**驗收：** 兩來源一方 404／429／串流中斷時，仍保留有效結果，但明確告知缺項；重試沒有重複盤棋，也不會跳過失敗來源的時間區間。

### R-06｜P2｜首次引導用一條任務完成，而非功能說明牆

建議從使用者目的選擇「分析一盤」「每天覆習」「準備對手」進入。只介紹當前完成任務需要的能力；模型、深度、threshold、coverage 等在使用者遇到時解釋。

**驗收：** 首次任務完成率、完成耗時、誤點與返回次數可觀察。引導可跳過，熟悉使用者不會每次再看；空狀態只給一個最相關入口。

### R-07｜P3｜繁中體驗優先覆蓋關鍵任務語言

目前主要介面為英文。若繁中是目標使用者群，先做登入、匯入、儲存狀態、錯誤、訓練指令與主要動詞的術語一致性，再擴充套件完整國際化。保留 SAN／UCI 與常見開局名，並提供必要解釋。

**驗收：** CJK font fallback 與長文字佈局正常；翻譯後 aria-label、錯誤和按鈕一致；不只翻譯導航而把關鍵錯誤留在英文。

## 9. 推薦的簡化任務流程

### 9.1 分析一盤，補一個弱點

1. 貼 PGN／選擇一盤實戰。
2. 預設使用明確的「快速／較深入」品質選擇，顯示預計成本；詳細深度留在進階設定。
3. 完成後首屏展示三個關鍵時刻，每個給「發生什麼、為何重要、可練什麼」。
4. 選擇一個加入已有或新 repertoire，預設錨點來自該局面。
5. 直接練這條線；退出後可回到原分析位置。

關鍵改善是減少整盤重建與重複選擇。完整棋譜、評估圖、模型證據仍保留為深入檢視。

### 9.2 每日五分鐘複習

1. Library 一個清楚的「繼續今天覆習」入口，旁邊顯示任務規模。
2. 進入後只有棋盤、當前指令、提示與必要操作。
3. 結束時給近期進步、未掌握重點與下次到期概況。
4. 網路失敗仍保留成果，用「本地已儲存，等待同步」與「帳號已儲存」區分承諾。

不要要求使用者先學會 weak／due／new／polish 的內部類別才開始練習。類別可以作為原因摘要與深入說明。

### 9.3 準備一個對手

1. 選擇來源與預期執子方。
2. 下載階段先給逐來源盤數與狀態，允許部分完成報告。
3. 首屏三項準備重點，標示歷史樣本與自己的缺口。
4. 點選後檢視棋盤，決定補入準備或進一步分析。
5. 加入後直接練習，並保留回到對手報告的路徑。

一般使用者預設三項，不需先讀完整風格報告；資深使用者可展開完整預算與所有證據。

## 10. 工程與測試配套

### 10.1 拆分責任，而非為了行數重寫

本次 `app.js` 12,109 行、`styles.css` 6,201 行、`views/scout.js` 2,208 行。已存在 lazy view 與純函式模組，不需要先遷移整個前端框架。

優先抽離儲存協調／outbox、任務生命週期、modal／通知層管理與 shared board controller。每個模組明確狀態擁有者、初始化與清理時機，減少導航、登入、引擎、儲存相互影響。研究程式碼的搬遷與清理要獨立安排，不能在 UI 整理時順便大範圍修改生產演算法。

### 10.2 最有價值的下一批測試

| 情境 | 應保護的行為 |
|---|---|
| Build 401／403／409／429 | 待儲存內容完整保留，未確認不顯示 Saved |
| Train 永久拒絕＋暫時失敗 | 兩種結果都通知，失敗項可追查 |
| 離線新增／訓練後重整 | 待送資料恢復，UUID 保持穩定 |
| 儲存後響應中斷 | 重試不重複計分或增樹 |
| 登出時有 pending／in-flight | 成果保留且不會跨帳號送出 |
| DB load 後重新分析三次 | 解說不累積，使用者註釋保留 |
| 分析 malformed score／PV／depth | 可理解的 4xx，資料不部分變更 |
| 停用祖先＋啟用後代 | health 與訓練有效節點相同 |
| 固定時鐘跨 due_at | badge 與訓練入口一致 |
| 多來源一方失敗 | 缺項顯示、只重試失敗來源 |
| 兩分頁同節點修改 | 明確合併／衝突，保留草稿 |
| 撤銷公開分享 | 舊連結失效，團隊與副本語意清楚 |
| toast＋modal＋手機鍵盤 | 主要操作可看、可點、焦點正確 |

這些測試比繼續擴大純成功路徑的數量更能提升使用者信任。多裝置效能測試則先聚焦實際低階筆電與手機，觀察 worker 數量、模型冷／熱啟動、記憶體與主執行緒輸入延遲。

### 10.3 可觀察性建議

記錄 task／operation identity、階段、成功與失敗原因、待同步最久年齡、拒絕項數、來源完成率、模型降級與儲存確認率。日誌避免直接記錄 PGN、token 與完整個人資料。

推薦產品指標：分析任務完成率、只重試儲存成功率、首次分析到第一次訓練耗時、每日複習完成率、Scout 建議到加入準備比例。推薦可靠性指標：未恢復運算元、重複計分數、跨帳號誤送數、分享撤銷後仍可讀取數；這些應為零或可明確解釋。

## 11. 建議實施順序與驗收目標

| 批次 | 範圍 | 先後原因 |
|---|---|---|
| 第一批：資料儲存與控制 | Build 錯誤分類、Train 混合失敗通知、durable outbox、登出協調、分享撤銷 | 先修會破壞儲存承諾與分享信任的行為 |
| 第二批：正確性一致 | 註釋去重、輸入契約、有效分支、精熟判定、health 新鮮度 | 讓統計、結果與實際功能一致 |
| 第三批：任務簡化 | Scout top-3、手機訓練集中、錯誤恢復、跨模組上下文、帳號復原 | 降低完成任務的步驟與判斷負擔；帳號復原也可獨立提早做 |
| 第四批：量測後最佳化 | 歷史分頁、查詢計劃、DOM 區域性更新、SRS 實驗、低階裝置引擎策略 | 用真實資料決定最佳化方向 |
| 持續維護 | 帳號資料管理、生命週期、視覺迴歸、術語／繁中與責任拆分 | 避免功能增加後再次失去一致性 |

各批次建議的小型交付必須有獨立迴歸範圍；不要把持久化、排程改版與視覺重構綁成一次大改。

### 11.1 建議目標（並非本次實測成績）

| 目標 | 衡量方法 |
|---|---|
| 儲存狀態可信 | Saved 只在對應後端確認後顯示；本地儲存另有狀態 |
| 中斷可恢復 | 斷網／重整／登入過期的 authorized 操作可完整重播 |
| 排程解釋一致 | effective trainable 集合一致；精熟／弱項不互相矛盾 |
| 結果可追溯 | 每份報告有 engine／model／algorithm identity 與缺項狀態 |
| 首次任務更簡單 | 觀察真實使用者完成時間、步驟數、錯誤與返回次數 |
| 手機主要動作可達 | 小屏、橫向、鍵盤與 toast 組合檢查 |
| 效能可衡量 | 真實資料量下記錄 API p50／p95、響應大小、DOM 與輸入延遲 |
| 分享可控制 | 單連結可撤銷，撤銷效果有迴歸測試 |

## 12. 主要證據位置與附件

| 主題 | 主要檔案／函式 |
|---|---|
| Build flush 與 unload | `web-src/app.js`：flushBuildMoves、hardFlushBuild、beaconFlushBuild |
| Train 混合失敗與重試 | `web-src/train-sync.js`：flushGroups；`app.js`：flushTrainSync |
| 登出 | `web-src/controllers/account.js`：signOut |
| 註釋與輸入轉換 | `src/prepforge_chess/services/browser_compute.py`：classify_precomputed_game、_evaluation_from_client |
| 分析路由與匯入 | `src/prepforge_chess/api/routers/analyze.py`：_import_pgn_for_analysis、analyze_classify_save |
| 批次分析儲存 | `src/prepforge_chess/storage/repositories.py`：save_game_batched、_save_moves_batched、save_analysis_result |
| 健康快取與歷史 | `repositories.py`：list_owner_repertoire_listings、list_analyzed_games；`services/workspace_view.py` |
| 精熟與分支遍歷 | `services/progress.py`、`services/scheduler.py`、`services/training.py`、`services/opening_builder.py` |
| 分享 | `api/routers/workspace.py`：mint_share_token、shared_repertoire、share_repertoire |
| 帳號功能 | `api/routers/auth.py`、`settings.py`、`legal.py` |
| 樹與焦點 | `web-src/views/build.js`、`views/shared/movetree.js` |
| Scout 來源錯誤 | `web-src/views/scout.js`：多使用者名稱 streamGames 匯流 |
| Scout 生產演算法 | `scout-selector.js`、`scout-preparation-value.js`、`scout-probability.js` |
| UI token | `web-src/styles.css`：字號、棋格／座標、--z-* |
| 目前命名 | `web-src/command-palette.js`、`web-src/index.html` |
| UI 檢查 | `scripts/smoke/ui-v2/run-all.mjs` 與各 viewport smoke |

附件目錄：[本次截圖](review-assets/2026-09-29-followup/)。包含桌面、筆電、手機下的 Train 與 Scout 多狀態；報告引用的圖片均為本次重新產生並檢視。

前次報告：[2026-09-29 原始改善評估](archive/audits/project-improvement-review-2026-09-29.md)。該報告檢查基準為 `4ff6aba`，本報告已將之後修正的內容區分。本報告同樣是檢查當時的建議快照，後續工作應重新核對當前程式，並以使用者最新要求決定範圍。
