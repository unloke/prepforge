# PrepForge Chess 專案改善評估報告

**檢查日期：2026-09-29（America/Phoenix）**  
**檢查基準：工作目錄 HEAD `4ff6aba889cd4f2fba8a3464ee1fbb18c978506e`，並包含檢查時既存的工作目錄狀態。**  
**範圍：UI、資料庫互動、演算法處理、功能設計、視覺效果、使用者體驗簡潔化，以及直接影響上述項目的工程驗證。**  
**交付性質：分析報告。本次沒有修改產品程式碼、資料庫結構、套件設定或部署設定；僅新增本報告及截圖附件。**

## 1. 主要結論

目前專案已經具備完整的準備與練習迴圈：匯入棋譜、分析、建立 repertoire、練習、比對實戰、偵察對手、團隊分享。現有改善空間主要落在三個方向：**資料儲存可信度、分析結果的可追溯性，以及使用者完成一次任務所需的判斷與操作量。**

這次應優先處理以下五項：

1. **訓練同步把所有 4xx 都當成可丟棄的結果。** 登入過期、CSRF 問題、衝突等情境可能清掉待同步紀錄，最後仍顯示 Saved。此行為已直接重現。
2. **引擎評估是全域共用且可覆寫的資料。** 同一局面與搜尋設定的後續寫入，會直接改變之前引用同一筆評估的資料。此行為已用記憶體資料庫重現。
3. **Build／Train 的待同步內容主要儲存在記憶體。** 分頁關閉只使用 best-effort keepalive，登出又先終止登入狀態；資料儲存的承諾尚未涵蓋所有中斷情境。
4. **Analyze 的目標深度與實際搜尋深度沒有完整區分。** 逾時允許採用較淺結果，但儲存時仍用設定深度標記，影響結果可信度與快取身份。
5. **分享連結缺少單獨撤銷與期限。** repertoire 設回 private 並不等於既有公開連結失效，容易與使用者對「取消分享」的理解衝突。

UI 已有明顯整理成果：Library 表格、桌面側欄、手機底部導覽、設定頁分割槽、共享走法樹、主題 token、鍵盤棋盤與錯誤重試入口都已存在。下一階段應著重讓這些能力更一致，而不是增加更多面板或提示。

### 1.1 優先順序摘要

| 優先度 | 專案 | 主要影響 | 證據等級 | 建議先後 |
|---|---|---|---|---|
| P1 | X-01：同步 4xx 一律丟棄 | 訓練紀錄遺失、Saved 狀態失真 | 已重現 | 第一批 |
| P1 | D-01：共用評估被覆寫 | 歷史分析與多人結果完整性 | 已重現 | 第一批 |
| P1 | X-02：待同步資料不具持久化保障 | 重新整理、登出、中斷後遺失 | 程式碼確認；事故情境待 E2E | 第一批 |
| P1 | A-01：實際深度與標記深度不同 | 分類可信度、快取與重現 | 程式碼確認 | 第一批 |
| P1 | F-02：分享連結無單獨撤銷 | 分享範圍不可收回、UI 語意誤導 | 程式碼確認 | 第一批 |
| P1 | U-01：engine 高於 modal／palette | 模態視覺不一致、可能遮擋 | 瀏覽器及截圖確認 | 第一批 |
| P1 | F-01：缺少密碼復原流程 | 帳號可用性、客服成本 | 路由及 UI 盤點確認 | 第一至二批 |
| P2 | D-02：health 快取含隨時間失效的資訊 | Library 與今日待複習數不一致 | 程式碼確認；跨日顯示待實測 | 第二批 |
| P2 | D-03：Build 缺少 revision 衝突契約 | 多分頁編輯可能相互覆蓋 | 結構風險，待併發實測 | 第二批 |
| P2 | A-02／A-03：SRS 線性間隔與終身正確率 | 長期複習負擔、進步不易反映 | 程式碼確認 | 第二批 |
| P2 | U-02／U-04：命名與資訊密度 | 導覽理解、Scout 可讀性 | 程式碼及截圖確認 | 第二批 |
| P2 | V-01：棋盤座標對比不足 | 棋盤定位及低視力可讀性 | token 對比計算 | 第二批 |
| P2 | F-03／X-04：分析完成後儲存失敗無 checkpoint | 長時間運算成果難恢復 | 程式碼確認 | 第二至三批 |
| P2 | E-01：本機工具版本與 lock 不同 | 驗證結果不完全對應 CI | 本機命令確認 | 下次改動前 |
| P3 | 大樹區域性更新、設定說明、視覺回歸與研究碼整理 | 維護效率及進一步效能 | 程式碼／測試盤點 | 持續改善 |

**優先度定義：** P1 表示應優先排入下一輪，通常涉及儲存、結果完整性或主要任務；P2 是重要的可靠性與體驗改善；P3 是可逐步安排的維護或最佳化。本報告沒有將「目前功能不完整」直接等同於 production 已發生事故。

## 2. 檢查方法、實測結果與限制

### 2.1 這次實際做了什麼

- 閱讀目前 frontend、API router、domain service、storage schema／repository、browser engine 與相關測試。
- 與 2026-09-25、09-26、09-27 的既有稽核檔案交叉比對；舊檔案僅作為檢查線索。
- 執行前端全套單元測試、Python 預設全套測試，以及 UI v2 的 viewport／state smoke。
- 取得並檢視本次產生的截圖；畫面資料主要來自測試 fixture，而非使用者真實帳號。
- 以純函式呼叫重現 HTTP 4xx 的同步處理，以記憶體 SQLite 重現 engine evaluation 覆寫。
- 在本機瀏覽器開啟實際 Stockfish engine window 與 command palette，確認層級和 inert 狀態。
- 依目前 CSS token 重新計算部分文字對比；查閱官方 Fetch 與 WCAG 說明作為限制及驗收依據。

### 2.2 驗證結果

| 檢查 | 本次結果 | 可代表什麼／不能代表什麼 |
|---|---|---|
| `npm test -- --reporter=dot` | **109 個 test files、1,650 個 tests 透過** | 現有前端測試在本機安裝環境透過；不能代表所有失敗模式都受保護 |
| `.venv/Scripts/python.exe -m pytest -q` | **654 透過、11 略過、5 deselected** | 預設後端測試透過；5 個 E2E 依設定未執行，略過測試不算透過 |
| 六組重點 Python 測試 | **97 透過、5 略過** | training、codec、scheduler、workspace、auth、Scout boundary 的抽查也透過；包含於後續全套結果 |
| `npm run smoke:ui-v2` | **9／9 透過** | 八頁面 + 額外 state smoke，在 1440×900、1180×900、390×844 下透過既有斷言 |
| 畫面檢查 | 檢視本次六種頁面截圖及 engine／palette 截圖 | 足以指出資訊層級與部分可讀性問題；不是完整的使用者研究 |
| 現有 static bundle gate | 全部透過 | 對「目前已建置資產」量測；本次沒有重建 production bundle |
| 4xx 同步探針 | 401／403／409／429 均回傳不需重試且空 failedGroups | 明確證實該函式會把上述結果當作已處理 |
| 共用評估探針 | 兩次寫入相同 id；第一次引用讀到第二次的值 | 明確證實評估列可變及共用覆寫機制 |

Python 執行另出現 FastAPI／Starlette TestClient 對 httpx 的 deprecation warning；這次沒有將它列為產品故障。

### 2.3 必須保留的邊界

1. **沒有連線檢查 production PostgreSQL、Render 指標、真實 Stripe／OAuth 或使用者資料。** SQL 效能與多租戶影響的生產規模仍需後續量測。
2. **沒有修改或更新 node_modules。** 本機 ESLint 9.35.0、Vite 6.4.3、Vitest 4.1.8，與宣告／lock 的 10.11.0、8.3.1、5.0.2 不同；因此此次工具執行的可信範圍需限定為本機環境。
3. UI smoke 使用現有 `static/` 產物；原始碼檢查與建置產物檢查是兩種證據，不能據此宣稱每個原始碼變更都已包含於正式部署。
4. 本次沒有重新執行完整 axe E2E。既有 axe 指令碼可證明專案已有 gate，但既有「零違規」記錄不等於本次所有狀態、主題與 WCAG 2.2 專案都驗證完成。
5. 原有 `artifacts/desktop-workspace/` 截圖是舊版棕色棋盤與頂欄，**沒有用它們判定目前 UI**。本報告截圖重新產生於本次檢查。

### 2.4 已改善、不要重複當成待修的專案

| 舊問題 | 目前確認的改善 | 剩餘注意事項 |
|---|---|---|
| 每個節點重建兩個棋盤 | `codec.py:314` 已以單一 Board push/pop 還原 | 大樹仍需遍歷與序列化；不再沿用舊報告「降到 69ms」為本次量測 |
| 同一 request 重複讀 repertoire | `training_smart.py:131` 已有 request-scoped tree／index cache | 不等於跨 request cache；先量測再擴充 |
| repertoire 列表 N+1 | 批次讀取已存在；Library 還有 lightweight listing | 不要為 Library 再匯入全樹讀取 |
| Dashboard 每次 GET 都鎖設定 | `_weekly_recap` 先讀，僅換週時 mutate | 首次換週仍有寫入；屬語意與可觀察性改善 |
| due_at 無索引 | `idx_training_progress_due` 已存在 | 是否需要 owner 複合索引應看實際計劃 |
| settings 全部擠同一屏 | 已有 section nav 與多個分割槽卡片 | 手機橫向 section nav 的發現性仍可改善 |
| 淺色文字語意色對比 | 已有 `--warn-text`、`--good-text`、`--brilliant-text` 與測試 | 棋盤座標仍另有問題 |
| 頂欄七個分頁硬塞 | 已改 desktop rail＋mobile tabbar／More | 命名和圖示發現性仍需統一 |
| Terms 授權寫錯 | 已寫 AGPL-3.0-or-later | 此報告只確認程式碼文案，不判斷法律合規 |
| TOKEN_KEY 部署說明缺漏 | `DEPLOYMENT.md` 與目前 render.yaml 中均可見 | render.yaml 本來就有工作目錄修改；本次未更動 |
| proxy 配置可能忽略來源 IP | Dockerfile 已有 proxy headers／forwarded allow 設定 | 沒有 production 實測，不能聲稱真實 IP 限流已完全驗證 |
| 弱項佔滿整個訓練佇列 | scheduler 已有 weak 前段 60% 配額 | 滿載 due 時，其他類別的份額仍可討論 |
| Library 錯誤無重試 | 已有錯誤卡與 Retry，以及狀態 smoke | 其他模組尚未形成一致恢復方式 |
| 主 bundle 預算幾乎滿 | 本次現有產物為 256.2 KiB JS／111.7 KiB CSS | 不再引用舊報告 99.7%；原始碼尺寸與維護負擔仍存在 |

## 3. 現行架構與應保留的優點

目前是 **FastAPI＋SQLAlchemy Core／ORM＋PostgreSQL（正式）／SQLite（本機與測試）＋Vite 原生 JavaScript SPA**。Stockfish WASM 與 Maia3 ONNX 在瀏覽器執行；後端負責合法性／所有權驗證、分類及儲存。

| 部分 | 主要位置 | 評估 |
|---|---|---|
| 介面殼與共享棋盤 | `web-src/app.js` | 功能完整，但組裝檔仍過大 |
| 各頁 renderer | `web-src/views/` | 已有 lazy chunk 邊界，值得繼續使用 |
| 引擎生命週期／模型快取 | `web-src/engine/` | 可取消、校驗、worker 恢復與模型快取已有基礎 |
| 開局樹操作 | `services/opening_builder.py` | 會重驗瀏覽器 plan 的合法性與關係，邊界合理 |
| 訓練 | `training_smart.py`、`scheduler.py`、`progress.py` | 冪等收據與行鎖是重要資產，但客戶端錯誤分類和排程模型需改進 |
| 資料儲存 | `sa_tables.py`、`repositories.py`、`codec.py` | compact storage、bulk write、Alembic 和 dialect 測試基礎完整 |
| Scout | `scout.js`、`scout-prefilter.js`、`scout-preparation-value.js` | 已採用去重決策覆蓋與集合選擇；不應被舊版 comfort-zone 文件誤導 |
| 認證／團隊／付費 | `api/routers/` | 主流程已接好，賬號恢復與分享治理需要補齊 |

值得保留的設計包括：即時本地走棋、後端再驗證、穩定 UUID 的訓練重試、共享棋盤規則、延遲載入模型、明暗主題、鍵盤操作，以及前後端分類 golden fixtures。下面的建議均應在這些基礎上增量推進。

## 4. UI 改善

### U-01｜P1｜統一 modal、palette、engine 與通知的疊加層級

**證據：** `styles.css:3628` 的 modal-overlay 為 z=60，`:5960` 的 palette 為 z=80，`:4283` 的 engine-window 為 z=950。實際開啟 engine 後再按 Ctrl+K，engine 仍以亮色視窗顯示在遮罩上方。

**重要區別：** 當前 `app.js:2987` 的 `activateModal()` 已對背景加 `inert`。本次 engine 為 `inert=true`，其區域的 hit test 回傳 palette。因此，**已重現的是視覺層級問題，不能繼續照舊報告聲稱模態期間 engine 仍可被操作。** 非模態狀態下浮窗可能遮住其他操作，仍需另測。

**改善：** 建立少量有明確順序的 layer token；模態及其遮罩應整體高於浮動工具。必要時在 modal 開啟時收起浮窗。若引入原生 `<dialog>`，應是為了統一 top layer、focus 和 Escape 行為，而不是單純換標籤。

**驗收：** engine 開啟＋新 repertoire modal／palette／mobile More／toast 的組合均可操作；背景正確暗化；Tab 不進入背景；關閉後焦點回到原入口。

![本次重現：palette 開啟後 engine 仍亮在遮罩上方](review-assets/2026-09-29/engine-palette-audit.png)

### U-02｜P2｜建立單一功能命名錶，修正 command palette 的舊名稱

**證據：** `index.html:19` 的導覽名稱為 Library，`:23` 為 Repertoire；`command-palette.js:4` 仍為 Dashboard、Build、Replay，且沒有獨立的 Scout view。手機又用 Prep、Review，使用者需要記住多套對映。

**影響：** 搜尋「Library」「Repertoire」「Scout」與看到的導航名稱不一致；新使用者很難理解 Replay 與 Games／Scout 的關係。

**改善：** 各入口共享同一份 display label 與 aliases；保留舊詞作為搜尋別名。Palette 為 Games 和 Scout 各提供明確入口，內部可以繼續共用 replay 模組。

**驗收：** 導覽、palette、空狀態、handoff、麵包屑和 mobile More 使用一致名稱；新使用者可直接搜到當前看到的頁面名。

### U-03｜P2｜持續拆分 app.js，但按責任及狀態邊界拆

**證據：** 本次 `app.js` 為 **12,086 行**，仍包含 BoardController、engine widget、toast、modal、Build sync、Train sync、Games source、各頁 orchestration。多個 view module 已拆出，但共享狀態依然集中。

**影響：** 單一改動容易跨越訓練、生成、認證和導航；狀態清理與未儲存檢查很難全面覆蓋。X-01／X-02 的缺口正與這些邊界相關。

**改善：** 優先抽出儲存協調／operation queue、modal與layer管理、board controller、job progress，然後再抽各頁控制器。直接使用現有模組方式，不需要為此先遷移 React、引入全域性狀態框架或重寫所有 DOM。

**驗收：** 每個模組能說明「自己擁有哪份狀態、何時建立、何時清理」；登入退出和跨頁操作透過統一儲存介面；lazy view 不因無關 resize 或初始化被載入。

### U-04｜P2｜Scout 預設展示「要準備哪幾條」，細節漸進展開

**證據：** 本次桌面截圖同時顯示來源、速度篩選、color tabs、勝和負、coverage、summary bullets、Predictability／Pet lines／Breadth／Repertoire／Style、first-move tiles、完整路線與右側棋盤。

**影響：** 功能豐富，卻需要先讀統計與標籤才能找到行動。MAIN／ATTACK、線路支援數和 score pct 在同一行競爭注意力。

**改善：** 首屏給「前三個準備重點＋各自一句理由＋一個下一步」，其餘路線保留在可展開清單。統計、風格與模型證據放在 Evidence／概況內，不移除專業能力。選中路線再顯示詳細棋盤、來源樣本和建議應對。

**驗收：** 使用者能在 30 秒內回答「對手最常走什麼、我缺什麼、下一步按哪裡」；深度使用者仍能檢視每項資料來源。

![Scout 本次桌面畫面：行動與統計仍同時佔據首屏](review-assets/2026-09-29/scout-report-white-audit-desktop-1440.png)

### U-05｜P2｜大型走法樹採區域性更新，保留鍵盤焦點

**證據：** `views/build.js:184` 渲染完整展開樹後在 `:231` 替換 `innerHTML`；`views/shared/movetree.js:87` 為每顆 move button 繫結事件，選擇後呼叫 `blur()`。

**影響：** 大量節點時，選中狀態更新也可能重建許多 DOM／listener；操作後的列表焦點可能消失。當前小 fixture smoke 不能代表 2,000 節點體驗。

**改善：** 先用事件委派，選中變化只更新 class 和必要麵包屑；重新渲染時保留 focus／scroll／collapsed ids。大型樹預設展開當前路徑與緊鄰分支；只有量測證明必要時再引入 virtualization。

**驗收：** 500／2,000 節點基準記錄 render 與選取耗時；用鍵盤連續選擇路線不會掉到 body；增刪分支後檢視不跳到頂部。

### U-06｜P2｜手機優先照顧正在進行的任務

**證據：** 390px Train 截圖中，棋盤約佔上方一整塊螢幕，下方依序是 coach、三種模式、進度、queue legend 與 action；Games 也先顯示大棋盤，再顯示偏離說明和行動。

**影響：** 使用者需要上下捲動來回看局面與操作；訓練進行中仍看到模式切換，會增加退出／切換的判斷負擔。

**改善：** 手機訓練中保留緊鄰棋盤的一句指令和必要的提示／下一題，模式設定摺疊成摘要；錯誤詳情留在抽屜。Games 的偏離說明和 Train／Analyze 行動與棋盤保持一起。不要單純縮小棋盤到影響走子。

**驗收：** 390×844、360×640、橫向、軟鍵盤開啟時，主要動作可找到；底部導航與浮動通知不蓋住動作；修改訓練模式時清楚說明當前 session 處理。

## 5. 資料庫互動改善

### D-01｜P1｜共用 engine evaluation 不應被任意後續寫入改變

**證據：** `sa_tables.py:65` 的評估沒有 owner；唯一鍵為 position、engine、depth、nodes、time_ms。`repositories.py:1647` 使用 `on_conflict_do_update` 更新 score、mate、bestmove、PV、WDL。`ReplayEngine` 接受瀏覽器提交的數值，engine 常用通用名稱 `stockfish (browser)`。

**本次重現：** 相同初始 FEN／engine／depth=16，第一次 score=25／PV=e2e4，第二次 score=-900／PV=d2d4；兩次 id 都是 1，第一次 id 的讀取已變成 -900／d2d4。

**影響：** 正常重新分析也可能改變歷史引用；多個使用者共用相同 key 時會共享更新。由於輸入來自客戶端，風險不只限於真實引擎的自然差異。這不代表其他使用者的 PGN 被讀取，但它是**共用結果完整性**的問題，也可能使儲存的 classification 與回讀 evaluation 不一致。

**改善選擇：**

- 歷史分析關聯不可變的 evaluation snapshot；可重用快取另有一層，不能直接改變歷史資料。
- 評估 identity 至少包含 engine／artifact 版本、實際搜尋條件及影響結果的選項。
- 未驗證的 browser submission 可 owner-scoped，或與可跨使用者共享的可信 cache 分開。
- 同 identity 出現不同結果時，採用明確的保留／新建策略，並留下來源，不靜默覆寫。

**驗收：** 使用者 A 的歷史評估不會因 B 的提交改變；同一個使用者重跑分析也不會改寫舊報告；舊 classification 與其計算輸入永遠對應。

### D-02｜P2｜將 health 快取中的靜態統計與時間相關數字分開

**證據：** `list_owner_repertoire_listings()` 在 `repositories.py:922` 直接回傳 `health_json`。更新主要來自 `workspace_view.py:109` 的開啟／修改，與 `train.py:210` 的 summary。health 包含 due 與 mastery，`node_mastery()` 的結果依賴當前時間。

**影響：** 即使沒有寫入，時間跨過 due_at 就會改變節點狀態；Library 不開 repertoire 時，其快取仍是舊值。Dashboard 即時計數可能與各 repertoire 的 queue chip 不同。

**改善：** 儲存 health 的計算時間、演算法版本和下一次失效時間；static count 可快取，due count 用輕量 owner-scoped aggregate 或定時重新整理。UI 顯示未知／過期狀態，不用舊數字假裝即時。

**驗收：** 控制測試時鐘跨過 due_at，單純重新整理 Library 就能顯示正確數量；Dashboard 與列表一致；剛匯入未計算的 health 不顯示成「沒有練過」的確定事實。

### D-03｜P2｜Build 加入多分頁／多裝置 revision 與衝突處理

**證據：** `workspace.py:691` 的 AddMovesBody、`:776` 的 ApplyPlanBody 沒有 expected revision；相關 mutation主要先讀樹、計算變化、再儲存。本次未找到 repertoire-level version 或等價的衝突契約。

**影響：** 兩個分頁從相同狀態編輯、修改 mainline／comment 或刪除對方的 parent 時，沒有明確方式告訴使用者「你的基準已過期」。目前批次寫入及合法性驗證有價值，但不能替代併發語義。

**改善：** mutation 附 expected_revision 和 operation_id；可安全合併的新增自動 merge，刪除／mainline／annotation 衝突返結構化 409，由 UI 給重新套用或比較差異入口。

**驗收：** 兩個分頁的新增不會重複；已刪除父節點上的新增不默默丟失；相同 operation 重試不增加重複結果；annotation衝突可被發現。本項需真實 PostgreSQL 併發測試，不能僅依據 SQLite透過定案。

### D-04｜P2｜訓練批次同步保留冪等性，同時減少每題往返

**證據：** `training_smart.py:686` 逐 attempt 處理；`:719` 每筆開啟 transaction、檢查 receipt、鎖 progress、鎖 session、更新 progress 和 session；結束後再處理 queue／card_index。當前是「一個 HTTP request 可包含多筆」，但 DB 層並非單次 bulk transaction。

**影響：** 網路斷線後積累很多 attempts 時，SQL 次數和 commit 次數隨每筆增加。又因為後段錯誤可能發生在前面 attempt 已 commit 後，回應需說明部分成功，而不能只返通用失敗。

**改善：** 預先驗證整批結構和 queue 上限；批次載入 receipt 與相關進度；在有限大小 transaction 中按固定順序加鎖並更新。可以保留逐題冪等 semantics，但 response 回報 accepted／duplicate／rejected ids。不要為了減少 SQL 犧牲現有 exactly-once保護。

**驗收：** 1／20／100／500 attempts 的 statement、commit、p95 測試；兩 device同步仍不 lost update；中途錯誤的已提交狀態可明確重試。

### D-05｜P2｜熱路徑最佳化先量測，避免過早引入全域樹快取

**證據：** `load_repertoire():859` 讀取全部 nodes／evaluations後 hydrate；訓練已有 request-scoped cache。同期來源不再適合引用舊版本 247ms 熱路徑數字。

**影響：** 大 repertoire 與多 repertoire mixed start 仍可能消耗 CPU、記憶體及序列化，但目前無法據靜態程式碼判斷 production p95。

**改善：** 區分 DB 查詢、hydrate、tree walk、JSON serialization；對常見與最大規模量測。先減少重複遍歷、只載入需要的 data；若跨 request cache 確有價值，必須以 owner／repertoire／revision為 key，且不能共享可變物件給不同寫入者。

**驗收：** 50／500／2,000 nodes與多 repertoire案例的 p50／p95／payload bytes；安全門檻用「比目前量測改善多少」定義，而非憑空要求一個毫秒值。

### D-06｜P2｜資料生命週期要涵蓋評估、position、receipt 與帳號

**證據：** 刪除 repertoire 會刪除其樹相關資料；未找到 positions／engine_evaluations 的 orphan清理路徑。`TrainAttemptReceipt:204` 沒有 owner／session FK或 retention描述；`UserSetting:195` 明確沒有 users FK。

**影響：** 經常重新分析、刪除 repertoire、長期訓練會留下無法透過 owner直接清理的資料。後續賬號刪除容易漏資料；receipt若任意過期，離線舊請求又可能重複計分。

**改善：** 給資料表定義保留及引用策略；orphan GC先 dry-run統計，再小批清理；收據清理與可接受的離線重放期限繫結。賬號刪除需明確訓練、settings、連結帳號、團隊、billing與共用cache如何處理。

**驗收：** 刪除測試賬號後沒有其私人資料殘留；GC不會刪除仍被任何 move／opening node引用的evaluation；超過 retention的操作按明確協議拒絕或降級。

### D-07｜P3｜設定資料型別與容量要符合實際用途

**證據：** `api/models.py:200` 的 `value_json`為 String(4000)，儲存多個結構化用途。當前 departure ledger上限300個 ID；以8字元 ID 加 JSON分隔估算約3,600字元，尚在此限制內，**不能直接聲稱目前這個 ledger必然爆量**。

**改善：** 為每種 setting 定義 schema／size上限；變動較多或確實較大的值考慮 Text／JSONB。身份、進度與日誌不長期藏在無結構的 key/value blob裡。

**驗收：** 各key最大合法payload可在 PostgreSQL寫入；超限返回可理解的錯誤；SQLite寬鬆行為不掩蓋正式環境的長度限制。

### D-08｜P3｜統一 UTC 持久化規則，索引依查詢模式驗證

**證據：** domain時間部分是 ISO text，identity／billing用 DateTime(timezone=True)。Dashboard使用字串範圍比較；訓練也會把 naive datetime當作 UTC。

**改善：** 短期明確規定寫入都為統一UTC offset與precision；測試禁止混入不同offset格式。是否遷移timestamp應獨立評估收益。已有due單欄索引後，是否增加 owner／repertoire／due複合索引用 PostgreSQL EXPLAIN ANALYZE決定，不以「有索引」取代實測。

**驗收：** UTC、不同client時區、跨日及夏令時間的due判斷一致；不同ISO表示不會因字典排序錯置；查詢計劃與索引維護成本有記錄。

## 6. 演算法處理改善

### A-01｜P1｜儲存實際搜尋品質，不能只記目標深度

**證據：** `game-analyzer.js:95` 等待搜尋時設 `acceptShallowOnTimeout: true`；`:77` 的 evalFromSnapshot只保留score、mate、bestmove、PV，沒有actual depth。`app.js:5672` 提交setting depth；`replay_engine.py:83` 再以 `config.depth`建立評估。

**影響：** 設depth=16的任務可能儲存實際depth較淺的結果但標記為16；對使用者「重新算深一點」、D-01去重、分類可靠性與跨裝置比較都不利。

**改善：** 每個結果帶 requested_depth、actual_depth、nodes、elapsed、timeout／complete、engine artifact version。允許淺結果但明確標示，並讓精算只重跑不足局面。分類變化可解釋為質量變化。

**驗收：** 模擬30秒timeout且只有depth=8時，報告和DB不得聲稱該局面depth=16；復算後可追蹤新舊版本；部分不足不會把整局報告偽裝成完全完成。

### A-02｜P2｜SRS 長期間隔應依保持效果調整

**證據：** `training.py:507` 答對score+1，上限10；interval_days為round(score)，所以長期穩定記住的局面也至多10天后再複習；答錯為10分鐘後。

**影響：** 對幾百到幾千個穩定局面，長期每日due量趨於龐大。假設1,000個局面都進入10天間隔且review均勻，約需100個局面／日；這是演算法推算，不是本次使用者資料。

**改善：** 先記錄首次回憶、提示、耗時、距離上次review與結果；對穩定成功採用可增長間隔，對剛錯的材料保留短期複習。可以比較簡單乘法間隔與更成熟的記憶模型，但選擇要以保留率／負擔驗證。保留scoring version，平滑遷移已有進度。

**驗收：** 30／90天模擬中穩定材料不長期佔滿佇列；使用者實際次日／一週後回憶率不會因拉長間隔顯著下降；演算法升級不重置舊使用者進度。

### A-03｜P2｜弱項判定不要只看終身正確率

**證據：** `progress.py:48` 在attempts>=2且終身correct/attempts<0.5時判weak；`scheduler.py:279` 的weak排序也使用終身比值。

**影響：** 初期20次答錯、之後10次正確，仍只達到33%且判weak；反之100次正確後最近連錯5次，仍95%而不由此判weak。模型對「剛學會」與「最近退步」都不夠靈敏。

**改善：** mastery主要看最近／連續回憶與時間；終身accuracy保留為統計。記錄 recent streak／加權accuracy／lapses，區分learning、recovering與真正weak；Dashboard和scheduler共用同一函式。

**驗收：**「早期差、近期好」能逐步退出weak；「長期好、近期連續錯」能進入恢復佇列；相同資料在 Library、Build、Train 的狀態一致。

### A-04｜P2｜排程須讓使用者知道為什麼還有新卡或polish

**證據：** `scheduler.py:319` 先取weak最多前段60%，再due、new_cap內的新材料、polish，最後weak補足。due很多時可能吃完餘量；polish沒有保底。這是現有策略選擇，不是已證明的邏輯錯誤。

**改善：** 以「今天5分鐘／正常複習／學習新材料」表達不同目標；顯示剩餘due與未覆蓋的新卡。若產品希望保留正反饋，可分配少量穩定材料；若需清due，不必強行填polish。避免用一組永不變化配額服務所有使用者。

**驗收：** 滿載due、全weak、全new、全mastered案例有明確結果；使用者不會以為Start後就一定清完所有欠賬；佇列解釋與實際選擇相符。

### A-05｜P2｜依歷史成立的和棋條件，要與單 FEN 分析區分

**證據：** `game-analyzer.js:46` 以`new Chess(fen).isGameOver()`判終局；註釋提到threefold，但單FEN不包含重複局面的歷史。

**影響：** 單局面介面可以判斷無子可走、material或halfmove相關情況，卻不能完整推斷重複次數。不能把這種分析當作整段棋譜歷史規則的完整判斷。

**改善：** 整局分析可攜帶棋譜歷史／repetition metadata；單局面模式明確只判斷可從FEN推得的狀態。若為快取減少fullmove欄位，仍須保留會影響規則或模型輸入的資訊，不直接將所有FEN壓成四欄。

**驗收：** 重複局面、50步／75步邊界、en passant、castling及從自訂FEN開局的golden cases；前後端有一致的歷史語義。

### A-06｜P2｜Scout 以當前生產演算法重新做效果評估

**證據：** 目前 `scout-preparation-value.js:58` 使用prefix tree的集合DP，去重共享opponent decisions，並限制最多12條路線。原始碼亦明確條件reach不是校準的未來預測。舊comfort-zone檔案所描述的過濾不在目前prefilter路徑中，不能據它判定現在推薦錯誤。

**影響：** 數學目標可驗證，不等於實際備戰效果已驗證；Wilson lower observed frequency、route plausibility、Maia prior和engine opportunity含義不同。若使用者把介面百分比都讀成預測勝率，會誤用資訊。

**改善：** 鎖定生產scoring version；按玩家與時間留出未來比賽，比較未來opponent decision命中、unique覆蓋、推薦穩定性、rare樣本誤報與真實補齊收益。已有benchmark保留，但不要把candidate-stage結果說成最終勝率提升。

**驗收：** benchmark明確哪個commit／selector、訓練樣本截止日與holdout；不同rating／time control／樣本大小分層；調參不反覆利用同一最終holdout。UI把observed、model、engine三種證據分開說明。

### A-07｜P2｜分析與解釋結果附演算法／模型版本

**證據：** classification已有跨語言golden與crosslang測試；Scout有scoring version，但持久化的analysis／evaluation身份尚未完整表達模型、artifact、規則版本。

**影響：** 同一PGN在升級後標記不同，使用者無法辨認是深度、引擎更新、Maia評級還是閾值變化；修正演算法後舊結果的有效期也無法自動判斷。

**改善：** 記錄analysis_schema、classifier、coach、Stockfish artifact、Maia manifest、rating及feature-config版本。引數源共享或生成，只把真正影響結果的配置納入identity。

**驗收：** 任意歷史報告能確定其計算來源；版本變更觸發有選擇的recompute；當前golden protection繼續存在，不再重複提出「現在沒有前後端契約測試」。

### A-08｜P2｜Maia 不可用時，保留結果也要保留缺項資訊

**證據：** `app.js:5588` 執行Maia，`:5646` 捕捉非取消錯誤後將assessments置空，繼續儲存；使用者可能只看到Analysis ready。

**影響：** 正常關閉Maia、模型下載失敗、推理失敗與「真的沒有 brilliant」在報告上可能難分辨。繼續提供Stockfish分析是合理降級，但失敗原因不應失去。

**改善：** 儲存maia_status與簡短reason；使用者看到「基礎分析已完成，人類走法模型部分暫不可用」，能單獨補算該階段。詳細 technical error只進log／可展開diagnostics。

**驗收：** 模型off、404、cache損壞、worker crash、推理timeout各有可理解狀態；不把模型缺項表示為零個結果的確定事實。

## 7. 功能設計改善

### F-01｜P1｜補齊帳號復原，明確既有登入方式

**證據：** auth router目前為register、login、logout、me、providers；相關UI／router盤點未找到forgot password／reset password／email verification流程。

**影響：** 密碼使用者忘記密碼後缺少自助恢復；Google與password並存時，也需要清楚告訴使用者當初使用哪種方式。

**改善：** 單次、有期限reset token、一般化申請回應、session撤銷選項與成功回到原任務；email verification可依公開註冊／付費產品需求安排，不應阻擋尚不需要驗證的離線試玩。

**驗收：** token不能重用、過期失效、錯誤郵件不暴露賬號存在、重設後使用者可回到原repertoire。付費使用者不因忘密碼而失去可恢復訪問。

### F-02｜P1｜公開連結與團隊分享必須可區分、可撤銷

**證據：** `workspace.py:465` 明確說明share token stateless、無expiry、跟repertoire同壽命；token由id＋HMAC決定。`shared_repertoire():521`驗證token後讀取meta，沒有以private／team狀態禁止舊連結。UI `app.js:5000` 又可顯示「Repertoire is now private」。

**影響：** private是team可見性變化，不代表公開連結失效；但使用者很可能把private理解成「已停止外部訪問」。此外public viewer會讀最新樹，後續增加的私人備戰註釋也可能被原連結看到。

**改善：** 獨立的share resource／token version，提供到期、撤銷、重新生成；區分「team成員可見」和「任何持連結者可見」。給live share與snapshot share清楚選項。

**驗收：** 撤銷一個link後舊URL立即失效，不影響其他link或team；設private的行為與提示一致；複製為自己資料及共享原件的區別清楚。

### F-03｜P2｜Analyze／Generate 提供checkpoint與儲存重試

**證據：** Analyze先在瀏覽器算全部位置，`app.js:5672`一次classify-save；評估Map未見durable checkpoint。Build生成雖然有cancel與嚴格plan校驗，也主要算完再提交plan。

**影響：** 使用者可能等數十秒／數分鐘，最後網路／認證錯誤就失去一次計算的可恢復入口。取消計算與取消已儲存也需要區分。

**改善：** 優先持久化未儲存的完整結果與引數，提供「只重試儲存」；較長任務再分段checkpoint。以job／operation_id防重複寫入，追蹤computed、queued、committed。無需因此把棋力計算搬回伺服器。

**驗收：** 最後儲存失敗可以復原，不重跑已算局面；重新整理後繼續；同一任務不產生重複analysis；取消前後的儲存承諾明確。

### F-04｜P2｜資料匯出／刪除要成為可完成的帳號流程

**證據：** 已有repertoire package／PGN出口，但未找到全賬號匯出／刪除API與UI；privacy文字只寫可request，沒有具體入口或聯絡路徑。

**改善：** 可匯出使用者自己的分析、repertoire、progress、settings與關聯資訊；刪除前說明team ownership／複製資料／billing的處理，提供適當再認證。若暫時人工辦理，提供真實可用的請求入口及狀態，不僅保留一句文案。

**驗收：** 匯出可重新載入；刪除不會漏private settings／token；處理狀態與完成憑證可查詢。此項是功能完整性評估，不是法律違規判定。

### F-05｜P2｜跨模組傳遞明確上下文，減少整局重建

**證據：** 已有Games→Train／Analyze、Scout→Add to prep、Analyze→New repertoire from this game。這些是完整閉環的基礎，但目前多數動作仍是單獨入口，使用者需要理解複製範圍及後續目標。

**改善：** handoff統一傳遞game／ply／FEN／color／target repertoire／reason。Analyze允許選擇「加入當前變化」或「以整局建新repertoire」；Scout預設加入選中的少量線路而非自動補齊全部；完成後提供直接練這些新增局面的入口。

**驗收：** 從錯誤局面進入Build後，顏色、起點、現有manual分支與備戰內容正確；使用者無需重找剛看的ply；返回來源可恢復選取。

### F-06｜P2｜Scout 多來源部分失敗要可見

**證據：** `views/scout.js:1961`使用allSettled；有比賽到達時，一部分identity失敗不會中止報告，只有沒有任何比賽時才throw。這種容錯合理，但使用者應知道覆蓋了哪些來源。

**改善：** 來源chip顯示完成／部分失敗／重試中；報告註明真實來源與時間窗，提供單獨重試失敗來源，避免整份從頭下載。

**驗收：** 兩個賬號中一個404／429／中途掉線，現有結果保留且明確顯示覆蓋缺口；合併遊戲不重複計數。

### F-07｜P3｜團隊功能明確管理角色與複本語意

**證據：** teams已有owner／admin／member、invite／revoke／role update和共享repertoire。UI smoke主要覆蓋owner與member，不能據此聲稱所有許可權state都完整驗證。

**改善：** roster清楚區分誰可管理團隊、誰能編輯具體repertoire、誰只可複製；分享前說明共享原件會繼續變化、Copy後不會自動跟著更新。若要共編，先完成D-03再開放更多寫許可權。

**驗收：** admin、member、removed member、expired／revoked invite的可見按鈕與API結果一致；離隊後原件訪問與已合法複製的資料如何處理有明確產品規則。

## 8. 視覺效果改善

### V-01｜P2｜棋盤座標需要獨立於配色最佳化

**本次token計算：**

| 主題 | 座標／格色 | 對比 |
|---|---|---:|
| Light | coord-on-light／square-light | 3.19:1 |
| Light | coord-on-dark／square-dark | 2.15:1 |
| Dark | coord-on-light／square-light | 3.03:1 |
| Dark | coord-on-dark／square-dark | 2.93:1 |

**證據：** `styles.css:89`與dark override的實際值；這是無highlight時的token基底計算，不是每個棋盤狀態的畫素取樣。

**影響：** 座標通常很小，是定位局面的工具；當前普通文字對比均不足4.5:1。相對地，此次warn-text／warn-soft為5.66:1、good-text／good-soft為5.74:1，舊文字色問題已有改善。

**改善：** 將座標移至棋盤邊框／外側，或為各格提供可讀的文字底板；考慮主題切換、last-move highlight與pieces遮擋。保留棋盤寧靜配色，不必為了標籤把所有格色改得很強烈。

**驗收：** 普通大小文字以4.5:1為目標，且實際棋盤overlay也複驗；標準依據見[W3C Contrast (Minimum)](https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum)。

### V-02｜P2｜把閱讀舒適度與資訊密度分開

**證據：** 基礎font為13px，小字12px、xs11px；部分Scout game metadata為10px。當前採用tabular numbers是優點，不應重複舊報告「未使用等寬數字」。

**改善：** 主要行動／錯誤說明／coach正文優先提高到更舒服的字號及行高；10–11px僅用於真正次要metadata。提供舒適與緊湊密度，或至少確保瀏覽器200% zoom不會隱藏正文。

**驗收：** 低解析度laptop、手機、200% zoom的long names／中文註釋可讀；增加字號不會強行clip主要資訊。字號小本身不直接等於WCAG違規。

### V-03｜P2｜一個區塊只保留一個最顯著的動作

**證據：** Library Today已有due與Train，Next steps又顯示due與Train now；Scout有Deep scan、Add all gaps、每行＋、右側Add to prep；訓練setup／play有多個同層操作。

**改善：** 首要操作固定藍色primary；二級navigation與secondary actions用較輕樣式。Library next steps優先呈現不同任務；Scout選中一條後，右側主動作與列表＋保持一致；危險操作維持選單和可撤銷。

**驗收：** 使用者能指出當前頁面「下一步主要動作」；不存在兩個同樣醒目、卻執行相近動作的入口。無需強行把所有按鈕都收進選單。

![Library：今日待複習與 Next steps 重複呈現同一訓練任務](review-assets/2026-09-29/library-audit-desktop-1440.png)

### V-04｜P3｜統一圖示與狀態符號，但保留有辨識度的棋類語言

**證據：** rail已有SVG，棋盤bar仍使用⏮／⇅／💡等字形或emoji；Train streak與blitz也用emoji。跨平臺視覺表現不相同。

**改善：** 共享工具列採用同一SVG來源、stroke與尺寸；棋類分類符號「?!」「??」可繼續保留，但須有可見或輔助文字。火焰／慶祝若是有意品牌表達可以保留，不必機械去掉所有emoji。

**驗收：** Windows／macOS／Android 的工具列語意與尺寸一致；圖示按鈕有aria-label；觸控不依賴hover title理解。

### V-05｜P3｜維持既有節奏與低干擾動效，增加視覺回歸證據

**證據：** radius、語意色與reduced-motion已有基礎；styles.css目前6,190行，多個page stylesheet已有分離。現有smoke主要檢查DOM、overflow、console，不做screenshot diff。

**改善：** 圓角／間距繼續以現有token統一；勿為統一而抹平不同內容型別。優先建立關鍵screen的可稽核視覺baseline，focus／選取用穩定視覺反饋，長任務用真實進度。完成慶祝只在值得慶祝時出現並尊重reduced-motion。

**驗收：** 動作前後不無故layout shift；出現coach內容、toast、modal、長檔名時沒有遮擋；review可看到主題與手機截圖的差異。

## 9. 使用者體驗簡潔化與儲存可靠性

### X-01｜P1｜按錯誤種類處理同步，不能把整個4xx類別丟棄

**證據：** `train-sync.js:43` 的 `flushGroups`在`:50`直接略過所有400–499。`app.js:10236`若不需重試就可能將狀態設為saved。

**直接重現：**

| 注入HTTP狀態 | retriable | failedGroups | 目前含義 |
|---:|---|---|---|
| 401 | false | [] | pending被當作處理完 |
| 403 | false | [] | 同上 |
| 409 | false | [] | 同上，衝突也被吞掉 |
| 429 | false | [] | 若該錯誤路徑產生429，同樣會被吞掉 |
| 500 | true | 保留原group | 可重試 |

**注意：** 當前smart/sync router本身未標逐endpoint limiter；429探針證明錯誤處理有缺口，並不宣稱正式環境目前常對該endpoint回429。401／403與實際登入、CSRF邊界則直接相關。

**改善：** 401儲存待辦並重新登入；403區分CSRF與永久許可權；409保留衝突並提示處理；429遵循等待時間；確定session已永久刪除的404／410才按明確規則終止，並回報有未儲存紀錄。Response提供具體accepted／rejected，而不是隻有成功／失敗。

**驗收：** 只有收到伺服器確認儲存的attempt才從durable queue移除；Saved不能由「沒有要重試的group」自行推出；重新登入後使用原UUID補送且不重複計分。

### X-02｜P1｜將「本地即時」補成「可恢復的本地儲存」

**證據：** `app.js:387`的buildPending和`:424`的trainSync.pending為記憶體狀態；`:7398`與`:10268`解除安裝時fire-and-forget keepalive；`account.js:377`登出直接logout然後reload，沒有先統一drain pending。`beforeunload`時登入已可能結束。

**影響：** offline後重新整理、browser crash、OS終止、session過期後退出，都沒有足夠的恢復保證。Build解除安裝分別發delete與add也沒有await，呼叫順序不代表server提交順序。

**改善：** 小型owner-scoped IndexedDB outbox，寫入操作時先持久化；每項帶operation id、相依性、owner、revision。後臺重送成功後清除。登出先檢查待辦，允許同步／保留本機草稿／明確丟棄。先完成最容易丟失的Train attempts，再擴充套件Build。

**瀏覽器限制：** Fetch規範對同一fetch group的in-flight keepalive body總量設64 KiB門檻，不能把大批次解除安裝儲存當可靠承諾。依據：[WHATWG Fetch Standard](https://fetch.spec.whatwg.org/#http-network-or-cache-fetch)。

**驗收：** offline連續訓練→重新整理→恢復網路後attempts補齊；換賬號不會把A的outbox傳送到B；刪除／重加的相依順序可靠；出現401不清草稿；large pending不依賴unload一次送完。

### X-03｜P2｜所有錯誤狀態都給出任務相關的恢復入口

**證據：** Library有retry，Scout error renderer `views/scout.js:95`只是alert文字；一般API helper支援非JSON錯誤，但不少呼叫仍將raw message透出。

**改善：** 根據offline、expired session、validation、rate limit、missing model等型別，給「重試」「重新登入後繼續」「補算」「檢查來源」「返回編輯」；恢復入口放在失敗動作附近，長時間錯誤不只留在會消失的status pill。

**驗收：** 使用者不用重做整段任務就能恢復；重試不會重複建立；400的輸入錯誤指到具體輸入；technical stack／asset配置訊息只在診斷詳情中出現。

### X-04｜P2｜長任務進度要說明目前完成了什麼

**證據：** 目前已有Stockfish／Maia／classify／save／render階段和server timings，這是優點；但任務成果主要最終提交、Maia錯誤可被降級吞掉。

**改善：** 把「計算完成」「已在本機保留」「正在上傳」「伺服器已儲存」區分。主文用任務語言：「已分析80/120個局面，尚未儲存」；下載與模型階段可展開，避免預設充滿WASM／ORT／worker等實現術語。

**驗收：** 使用者能確定關閉頁面是否會損失成果；90%之後仍耗時不被誤認為卡死；儲存失敗仍有成果與重試；取消按鈕只在真的可取消時顯示，保留當前已有lockJob邏輯。

### X-05｜P2｜訓練入口按目的說明，不讓使用者猜模式

**證據：** 三模式目前為Smart queue、Line rehearsal、Play vs human；已有mode blurb，因此不應聲稱沒有說明。更大的語意問題是Play vs human實際是Explorer／Maia模擬，而非匹配真人。

**改善：** 對外用「複習弱項」「完整路線」「模擬人類走法」或同等明確表達；固定一句差異說明。Feeling Lucky改「從關鍵局面開始」，舊名稱可留為別名。將Blitz10秒解釋為訓練挑戰，誤時計錯規則放在開啟時可見。

**驗收：** 第一次使用的人能選對想做的訓練；不會期待真人對戰；開啟限時或換模式不會誤以為原練習仍持續。

### X-06｜P2｜初次引導以完成一條真實任務為核心

**現況：** signed-out與empty state已有Get started路徑；不必新增全屏介紹或多步tour。

**改善：** 三條短路徑即可：「分析一盤」「建立自己的開局」「練習已有repertoire」；提供小而真實的示例資料，登入後能接續它。第一條路線完成時才指出如何訓練或從實戰檢查，避免剛開始就講mastery／coverage／health／Maia引數。

**驗收：** 無賬號使用者能理解價值；新賬號5分鐘內完成一個可儲存任務；首個repertoire＋首個練習題的成功率可記錄。這裡的5分鐘是建議目標，不是本次測得的完成時間。

### X-07｜P2｜手機保留上下文，降低雙向卷動與隱藏導航的負擔

**證據：** 截圖中Train／Games主要動作在大棋盤下，底部status疊在頁面最下方；Settings section links橫向延伸，Connections／About在初始螢幕外。

**改善：** 正在訓練的指令與必要操作靠棋盤；details可摺疊，頁面header顯示任務來源。橫向section nav給邊緣提示並將active link捲入可見區，或手機用section選擇器。保留足夠觸控區域，不為「簡潔」把所有可點選東西縮成tiny icons。

**驗收標準：** WCAG2.2 AA target-size最低門檻是24×24 CSS pixels，存在間距等例外；常用手機主操作以44px左右作為更舒適的產品目標，兩者不要混為同一個法定／規範要求。依據：[W3C Target Size (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum)。

![Train 手機操作區位於大棋盤下方](review-assets/2026-09-29/train-active-audit-mobile-390.png)

![Games 手機：偏離說明與後續操作位於棋盤下方](review-assets/2026-09-29/games-triage-audit-mobile-390.png)

### X-08｜P3｜繁中使用與國際化從主要任務文字開始

**證據：** HTML lang=en，文案散在index與JS，主要字型fallback為Inter／Segoe／system；沒有查到統一i18n資源層。

**改善：** 若繁中使用者是目標，先建立功能label／錯誤／empty／training mode的resource字典，明確CJK fallback與行高；棋譜SAN／UCI及標準開局名可原文保留。確保日期、數字、local day和客戶端時區顯示一致。

**驗收：** 長中文repertoire名與comment不裁切；頁面lang與所選語言相符；英文alias仍可在palette搜到；local day跨午夜與streak對應。

## 10. 跨領域工程與測試改善

### E-01｜P2｜讓本機、lockfile與CI的工具版本一致

本次`npm ls --depth=0`實際列出invalid：

| 工具 | package／lock宣告或鎖定 | 本機安裝 |
|---|---|---|
| ESLint | 10.11.0 | 9.35.0 |
| Vite | package ^8；lock 8.3.1 | 6.4.3 |
| Vitest | package ^5.0.2；lock 5.0.2 | 4.1.8 |

package與lock彼此一致，問題在本機安裝目錄過期。**不能因此斷言npm ci會失敗；也不能把本機Vitest透過說成Vitest5已驗證。**

下次實作前在隔離環境依lock安裝，確認Node版本與CI一致，並重跑適當測試／build。無需在這次只交報告的任務中變更依賴。

### E-02｜P2｜補齊關鍵失敗路徑的E2E，而不是繼續只增happy-path數量

已有單元測試與viewport gates不少，新增價值最高的是以下狀態：

| 狀態 | 應保護的結果 |
|---|---|
| Train sync遇401／403／409 | 保留未提交attempt，Saved不失真 |
| offline→reload→online | 能恢復outbox、保持UUID冪等 |
| logout時仍有pending | 使用者選擇有明確後果，不靜默失去 |
| 同repertoire兩分頁相反操作 | conflict可見、資料不互相覆蓋 |
| 使用者A／B同FEN評估 | A歷史snapshot不變 |
| Analyze淺結果／最後儲存失敗 | actual depth正確、只重試儲存 |
| share revoke／改private | 訪問結果與使用者承諾一致 |
| Scout多來源只有部分失敗 | 來源完整性可見且可補送 |
| modal＋engine＋toast組合 | layer與焦點不矛盾 |
| 時間跨due_at／午夜 | 今日queue和Library快取一致 |

### E-03｜P3｜增加視覺及真實裝置證據，但控制CI成本

優先選少量代表狀態：Library populated／empty、Build branch edit、Train active／summary、Scout dense／empty／partial failure、Analyze results、Teams各角色、Settings手機sections。

明暗主題＋desktop／mobile用可審閱snapshot，不必為每個組合都做昂貴E2E。對於touch drag、軟鍵盤、browser background、Maia memory峰值，應至少有真實手機或對應瀏覽器紀錄；Chromium desktop viewport不代表所有mobile執行行為。

### E-04｜P3｜讓observability回答「儲存成功率」與「任務完成率」

已有clientlog與部分timing基礎。建議補的指標是：pending queue age、sync失敗型別／恢復率、分析compute完成到persist成功差距、cold／warm engine啟動時間、Maia降級次數、Scout來源完整率、large-tree p95。

以operation id關聯一趟任務，記錄結構化型別與耗時，避免把PGN／private comment／token直接寫入log。開發者應該能區別「正常離線等待」「登入過期」「永久資料衝突」，而不只看到一串泛用error message。

### E-05｜P3｜規範研究結果與生產事實的邊界

目前production selector已有獨立入口，research test配置也存在。繼續將舊v12／v13／v15研究與當前production清楚區分；舊report寫明superseded的commit與scoring version。特別是comfort-zone舊驗證檔案和目前演算法不同，不能讓它成為後續修改的錯誤依據。

## 11. 建議的簡化流程

### 11.1 「分析一盤，補一個弱點」

**建議體驗：** 選擇／貼上棋譜 → 用預設深度分析 → 先看最多三個重點 → 選一局面 → 加到現有repertoire／建立小路線 → 直接練剛加入的內容。

需要保留「專家」能力，但預設不要要求使用者先調Maia rating、深入理解classification閾值、選擇所有分支或將整盤比賽變成開局庫。Analysis history、完整圖表、all plies依然可展開。

![Analyze 本次畫面：棋盤與分析結果已有良好結構，可進一步突出重點局面](review-assets/2026-09-29/analyze-results-audit-desktop-1440.png)

### 11.2 「每日短時間複習」

**建議體驗：** Library顯示今日應複習 → 一個主要Train按鈕 → 預設短session → 只顯示當前回憶任務 → 錯誤立即說明但不大幅跳版 → 完成時顯示本次改善與仍待複習數。

避免在session中讓mode selector、queue分類、up-next、streak、accuracy、line labels全部等重。熟練者仍能檢視佇列，但新使用者應先知道「現在輪到我走什麼」。

### 11.3 「對付一個對手」

**建議體驗：** 輸入／選對手 → 自動使用合理樣本 → 看到樣本完整度 → 首屏前三條準備重點 → 每條一句理由／實際樣本數 → 加入prep → 練這些路線。

Deep scan應是「需要更可靠的戰術／評價證據」時的可選提升，不是使用者看到任何建議前必須理解的按鈕。多來源未完成必須標示，不能把不完整profile包裝成完整判斷。

## 12. 建議執行順序與範圍控制

### 第一批：修正會破壞信任的行為

1. X-01同步錯誤分類、明確accepted／rejected與儲存狀態。
2. D-01引擎評估snapshot／共享cache邊界。
3. X-02訓練outbox與登出drain；Build加入持久化和依賴順序。
4. A-01實際深度／結果品質與身份。
5. F-02link撤銷／private語意。
6. U-01layer表與組合驗證；U-02命名統一。

**先決條件：** 在與lock一致的隔離環境重跑適當gate；不能用本次舊node_modules結果作為修改後的唯一準入條件。

### 第二批：資料呈現一致與任務簡化

- D-02health時間失效、D-03revision contract。
- A-03近期掌握度；A-02間隔策略設計與模擬。
- U-04Scout摘要、U-06／X-07手機task layout、V-01座標可讀性。
- F-01賬號恢復、F-03儲存重試、A-08Maia缺項狀態。
- X-03統一恢復入口、F-05上下文handoff。

### 第三批：用量測決定的效能與維護工作

- D-04同步DB往返最佳化、D-05大樹熱路徑、U-05DOM更新。
- D-06生命週期與賬號刪除、D-07設定schema。
- A-06生產演算法留出驗證、A-07版本化。
- U-03逐模組拆分、E-03視覺baseline、E-04任務指標。

**不建議第一時間做：** 整站框架遷移、把所有引擎計算搬回伺服器、在未量測之前加入複雜全域性cache、用全屏tour解釋一切、為視覺「更豐富」增加更多顏色／卡片／陰影。

## 13. 驗收指標建議

以下是後續可用的指標與建議目標，不是本次量測出的產品成績。

| 領域 | 指標 | 建議驗收方向 |
|---|---|---|
| 儲存 | acknowledged attempts／queued attempts | 所有合法attempt最終得到明確ack或可見永久拒絕；不會無聲丟棄 |
| 儲存 | outbox age、offline恢復 | 斷線重新整理後能恢復，不能跨賬號誤送 |
| 完整性 | 歷史evaluation穩定性 | 他人提交及後續復算不能改變既有snapshot |
| 計算質量 | actual／requested depth、timeout ratio | UI與DB表示相符，不足局面可補算 |
| 首次價值 | 首個可儲存任務完成率／時間 | 以5分鐘可完成示例為起始目標，再依據使用者測試調整 |
| 每日訓練 | 到達第一題的運算元 | 從Today主動作起，一次進入預設session或一個必要選擇 |
| Scout | 判斷下一步時間 | 30秒內找到最優先prep任務與其理由 |
| 效能 | large tree p50／p95、payload | 先量測baseline，再設可追蹤改善；不以SQL數量單獨評價 |
| 視覺 | 文字對比、zoom／layer組合 | 基本正文對比達標；200% zoom主要內容不失去；模態層級一致 |
| 手機 | 主要動作可見與觸控 | 至少覆蓋360／390、短高度與軟鍵盤；目標大小與間距可解釋 |
| 維護 | 原始碼／artifact／環境版本 | 修改可在CI相同版本重現；研究結果與production版本清楚 |

## 附錄 A：直接重現方法

### A.1 同步4xx

以Node匯入現有`flushGroups`，傳一組attempt，並令postGroup分別丟擲status=401、403、409、429、500。觀察`retriable`與`failedGroups`即可重現X-01。

```javascript
import { flushGroups } from "./web-src/train-sync.js";

const groups = [["s1", [{
  node_id: "n1", correct: true, attempt_uuid: "a1"
}]]];

const result = await flushGroups(groups, async () => {
  throw Object.assign(new Error("probe"), { status: 401 });
});
// 當前：{ retriable: false, failedGroups: [] }
```

這不觸碰真實賬號或網路，也不修改source。該行為可以由現有測試透過並不代表產品語意正確。

### A.2 共用評估覆寫

使用現有`connect_database()`／`apply_schema()`建立`:memory:`資料庫；用repository儲存相同FEN、engine、depth的兩份不同score／PV；讀取第一份返回id對應行。

```text
first_id = 1
second_id = 1
first_reference_now = { score_cp: -900, pv: "d2d4" }
```

本次用repository內部寫入方法確認storage行為；沒有攻擊真實帳號。多人API端的完整重現應以隔離測試賬號與真實PostgreSQL補充。

### A.3 浮窗與palette

本次瀏覽器執行顯示：

```text
engineVisible = true
engineZ = 950
paletteZ = 80
engineInert = true
topAtEngine = "palette"
```

最後兩項說明hit testing已受inert保護；截圖說明paint層級仍錯誤。這兩個結論必須區分。

## 附錄 B：主要檔案定位

| 主題 | 定位 |
|---|---|
| UI shell／共享狀態 | `web-src/app.js`，12,086行 |
| modal focus／inert | `web-src/app.js:2987` |
| palette名稱 | `web-src/command-palette.js:4` |
| 大樹渲染 | `web-src/views/build.js:184`、`views/shared/movetree.js:87` |
| 顯示token／座標 | `web-src/styles.css:1`、`:89` |
| modal／engine／palette層級 | `web-src/styles.css:3628`、`:4283`、`:5960` |
| Train錯誤分類 | `web-src/train-sync.js:43` |
| Train queue／儲存狀態 | `web-src/app.js:10202` |
| Build unload | `web-src/app.js:7398` |
| Train unload | `web-src/app.js:10268` |
| 登出 | `web-src/controllers/account.js:377` |
| 請求helper | `web-src/app.js:2893` |
| Analyze pipeline／儲存 | `web-src/app.js:5536`、`:5646`、`:5672` |
| 實際深度遺失 | `web-src/engine/game-analyzer.js:77`、`:95` |
| 儲存深度 | `src/prepforge_chess/services/replay_engine.py:83` |
| 共用評估schema／覆寫 | `storage/sa_tables.py:65`、`storage/repositories.py:1620` |
| Lightweight listings | `storage/repositories.py:922` |
| health計算與快取 | `services/workspace_view.py:109`、`api/routers/train.py:210` |
| Training request cache | `services/training_smart.py:131` |
| Training sync transaction | `services/training_smart.py:624` |
| SRS | `services/training.py:507` |
| weak判定 | `services/progress.py:48` |
| scheduler配額 | `services/scheduler.py:243` |
| 分享token／viewer | `api/routers/workspace.py:465` |
| setting／receipt模型 | `api/models.py:183`、`:204` |
| Scout集合選擇 | `web-src/scout-preparation-value.js:58` |
| Scout部分失敗 | `web-src/views/scout.js:1961` |
| 測試及構建准入 | `.github/workflows/ci.yml`、`scripts/smoke/ui-v2/` |

後端短路徑均相對`src/prepforge_chess/`。行號只對應本次檢查的工作目錄版本。

## 附錄 C：其他本次截圖

![設定頁手機：分割槽已存在，但橫嚮導航後段較不易發現](review-assets/2026-09-29/settings-top-audit-mobile-390.png)

這些截圖使用fixture資料展示結構；使用者名稱、棋譜、勝率與訓練量不代表真實使用者，也不作為演算法效果證據。
