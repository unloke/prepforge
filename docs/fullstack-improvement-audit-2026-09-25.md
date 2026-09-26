# PrepForge Chess 全方位改進審查報告(2026-09-25)

> 範圍:UI、資料庫互動、演算法處理、功能設計、視覺效果、用戶體驗簡潔化。
> 本報告只做審查與建議,不含任何程式修改。
> 方法:通讀 `web-src/`(SPA)、`src/prepforge_chess/`(api / services / storage / core)、
> `migrations/`、`docs/` 既有審計與計畫文件,並交叉比對既有測試與 gate 設計。
> 基準:branch `fix/audit-consistency-round1`,284 commits,539 專案檔,165 測試檔。

## 0. 總覽

整體而言,這個專案的工程成熟度高於多數同規模產品:

- 前後端一致性靠「同一套 win-chance 標尺」貫穿(`services/classification.py` ↔
  `web-src/coach/features.js` ↔ `web-src/views/analyze.js`,連 sigmoid 常數
  `0.00368208` 都在三處互相對照,並有註解互相錨定)。
- 資料層已有量化優化證據(`docs/build-db-performance-2026-09-23.md`:單一操作
  2003 SQL statements → 3)。
- 安全基線完整(CSP + COOP/COEP、CSRF double-submit、bcrypt(72-byte 前 SHA-256)、
  session token 只存 hash、OAuth token Fernet 加密、rate limit、webhook 簽章豁免 CSRF)。
- 本地端優雅:Build/Train local-first sync(嘗試收據、重試、離線 chip)、Maia 權重
  IndexedDB 快取、懶載入 chunk、bundle size gate、release gate 一條龍
  (`scripts/run-release-gates.mjs`)。

因此本報告聚焦「仍可再進一步」的部分;凡屬既有文件(`docs/stability-perf-plan.md`、
`docs/*-friction-audit.md`)已列的項目,會標註沿用,不重複展開。

---

## 1. UI(使用者介面)

### 1.1 現況亮點

- `BoardController`(`web-src/app.js:2222`)是成熟元件:roving tabindex、
  `aria-label`/`aria-pressed`、翻面後還原 focus、拖曳/點擊/右鍵畫箭頭、升變選擇器。
- 模態框具 `role="dialog"` + `aria-modal` + Escape + focus 管理
  (`showInputModal` app.js:4865、`activateModal` app.js:2956,背景設 `inert`)。
- status bar 依嚴重度切換 `role="alert"`/`role="status"` 與 `aria-live`
  (`setStatus` app.js:2826)。
- Command palette(Ctrl+K)、skip link、`data-testid` 全面鋪設(E2E/摩擦審計可直接掛鉤)。

### 1.2 可改進之處

| # | 問題 | 證據 | 建議 |
|---|------|------|------|
| U1 | `app.js` 仍是 11,671 行 / 376 個頂層函式的巨型組裝檔 | `wc -l`;`docs/stability-perf-plan.md` #5 已列拆分計畫但未執行 | 續走 #5:已抽出 `views/*`、`controllers/account.js`,下一波抽 `BoardController`、Toast 系統、modal 系統、Build local-first sync(`buildPending`/flush timer)、Lichess 輪詢監看、音效引擎成獨立模組 |
| U2 | HTML 以 `innerHTML` 字串模板組裝 57+ 處(app.js)、加上 views 共 100+ 處 | `grep -c innerHTML` | 雖有 `escapeHtml` 紀律,但每次新增欄位都是 XSS/破版風險;把模板集中到 view 模組或引入輕量 `html` 標籤模板 + 型別化 props |
| U3 | 棋盤無法純鍵盤走棋(`pointerdown` only);eval chart 僅滑鼠 click;初始 Tab 落在 `nav-build` | 三份 friction audit 都列 P2,至今未修 | 棋盤加 Space/Enter 走棋(已有 roving focus 骨架);eval chart 加左右鍵逐 ply;調整文件順序讓第一站是主 CTA |
| U4 | eval chart 固定 `viewBox 0 0 640 96` + `preserveAspectRatio="none"`;主 polyline 未加 `vector-effect="non-scaling-stroke"`(懸崖線有加) | `web-src/views/analyze.js:287-380` | 寬螢幕下線寬被水平拉伸變形;補 `vector-effect` 或改 `preserveAspectRatio="xMidYMid meet"` + 依容器重算 |
| U5 | 自製 modal 系統(3 個工廠函式)需自行管理 focus trap、捲動鎖、點外關閉 | app.js:4865 起 | 升級原生 `<dialog>` + `showModal()`,瀏覽器接管焦點圈閉與 inert;減少手寫 keydown 監聽 |
| U6 | 響應式斷點不一致:`560px` / `520px` / `720px` 三套閾值混用 | styles.css `@media` 共 28 處 | 統一為 1–2 個 token 化斷點(如 `--bp-md: 720px`),避免同寬度下元件行為互相打架 |
| U7 | `@axe-core/playwright` 已是 devDependency 但全專案零引用 | `grep -rn "axe"` 只命中 package.json | 在 release gate 加 axe 掃描(先 Dashboard/Analyze 二頁),把 a11y 從「人工抽查」變「CI 門檻」 |
| U8 | 視圖狀態靠全域 `appState` + 散落 `document.getElementById` | app.js 全域 `appState` | 視圖工廠注入模式(views/ 已採用)方向正確;下一波把 `appState` 收斂成明確 store(或分域 store),讓視圖只能透過 API 互傳 |

---

## 2. 資料庫互動

### 2.1 現況亮點

- SQLAlchemy Core 雙後端(Postgres prod / SQLite dev)、Alembic 為 schema 唯一權威、
  `UNSET_SEARCH_LIMIT=-1` 讓 UNIQUE 約束 NULL-safe(跨後端一致)。
- 寫入已批次化:`_save_moves_batched` 分塊處理 SQLite 999 / PG 65535 參數上限、
  評估去重 upsert + RETURNING、dashboard 六個 COUNT 合成單一條件聚合
  (`repositories.py:1233` 區、`workspace.py:106`)。
- 併發安全意識:`mutate_user_setting` 用 `with_for_update` 列鎖 + 丟失更新防護;
  train attempt receipt 用 `ON CONFLICT DO NOTHING` 達成 exactly-once。
- `set_repertoire_health` 用 `IS DISTINCT FROM` 避免無謂寫入。

### 2.2 可改進之處

| # | 問題 | 證據 | 建議 |
|---|------|------|------|
| D1 | `list_repertoires` 是 N+1:先取 id 清單,再逐一 `load_repertoire`(每次全樹 hydrate) | `repositories.py:826` | 目前只有 Lichess sync 用;改為批量載入(單次 SELECT 全部 nodes)或改用 `list_repertoire_metas`,避免同步大量 repertoire 時連線數與記憶體線性爆炸 |
| D2 | 舊版 `save_game` 仍走「DELETE moves + 逐筆 `_save_move_annotation`」非批次路徑,`pgn_import.py:107` 與 CLI `analysis.py:248` 還在用 | `repositories.py:244-281` | 大量 PGN / Lichess 匯入時每局多筆 statement;統一改呼叫 `save_game_batched`,或讓 `pgn_import` 匯入後一次性 flush |
| D3 | `GET /api/dashboard` 有寫入副作用(`mutate_user_setting` 回寫週 recap snapshot) | `workspace.py:183-220` | 讀端點寫 DB 會干擾快取、放大讀寫比;建議移到「完成訓練時」或背景排程寫入,GET 只讀 |
| D4 | 時間以 ISO-8601 **文字**存,靠字串序比較(如 `due_at <= now_iso`) | `repositories.py:41-67`;`workspace.py` dashboard tally | 跨後端一致是合理權衡,但失去 `timestamptz` 的索引效率/時區語意,且排序、範圍查詢隨資料量退化;中期規劃遷移 Postgres `timestamptz`(SQLite 端保留 ISO) |
| D5 | Postgres 驗證缺口:SQL 計數回歸只在 SQLite 跑;PG 僅「應然」 | `docs/build-db-performance-2026-09-23.md` 尾段自述 | CI 加 `postgres` service container,把 `test_build_sql_counts` 同套斷言在 PG 跑一次(dialect 差異如 `ON CONFLICT`、`IS DISTINCT FROM` 才會被真正驗證) |
| D6 | 評估去重 key 含 `time_ms`:`(position, engine, depth, nodes, time_ms)` | `codec.py` `analysis_identity` | 同一引擎同深度但耗時略異 → 重複列,快取命中率下降;評估「結果身分」是否應只取 `(position, engine, depth)` 或 `(…, nodes)`,`time_ms` 降級為統計欄位 |
| D7 | 備份/還原未驗證(ROADMAP Phase 6 未勾) | `docs/ROADMAP.md:509` | 啟用 Render managed Postgres 自動備份後,做一次 restore 演練並記錄;這是唯一真正不可逆的資料風險 |
| D8 | `hydrate_opening_tree` 每節點新建 `chess.Board`(O(n) 棋盤建構) | `codec.py:282+`;benchmark 顯示 2000 nodes hydrate ~315ms | 改單一 board DFS(push/pop 重放)可砍掉每節點一次 FEN parse;Build load 在大樹上仍有線性 payload 問題(見 A4) |

---

## 3. 演算法處理

### 3.1 現況亮點

- 分類以 win-probability loss 為軸、對齊 Lichess 閾值
  (`ClassificationConfig` 0.02/0.05/0.10/0.15),Brilliant 三層 gate
  (Maia 低機率 + reveal gap + 客觀強度)可解釋、保守,且有經典棋局驗證文件。
- Scheduler 為純函式(無 DB/引擎),card 弱/到期/新/潤飾四池 + `WEAK_SHARE=0.6`
  防飢餓,卡牌編碼沿用既有欄位不動 schema。
- Scout 統計基礎紮實(Wilson interval、MAD→σ、recency half-life、明確
  `SCOUT_SCORING_VERSION=7`)。
- 瀏覽器端算棋架構正確:引擎是 worker + WASM/ONNX,伺服器只重放/分類/持久化,
  並對不可信任 payload 嚴格驗證(`analyze.py::_brilliant_analyzer_from_client`)。

### 3.2 可改進之處

| # | 問題 | 證據 | 建議 |
|---|------|------|------|
| A1 | 前後端雙實作靠「註解契約」鎖定(如 `excellent_loss` ↔ `BRILLIANT_MAX_CANDIDATE_WIN_DELTA`),漂移只靠人工讀註解發現 | `classification.py` docstring | 抽 shared contract 測試:同一組 fixture evals 斷言前後端分類逐 ply 相等(`coach/review-regressions.test.js` 是好的起步,擴充為雙端 golden set) |
| A2 | `MoveClassification` 有 `BOOK` / `MISSED_WIN` / `MISSED_TACTIC`,但 `classify_move` 不產 BOOK,MISSED_WIN 由 `analysis.py:231` / `browser_compute.py:182` 事後補判,MISSED_TACTIC 無產生路徑 | `models.py:29-40` | 要嘛補 BOOK(前端已有 bookline 資料可標),要嘛把 enum 收斂到實際可達狀態,避免 API 消費者預期落空 |
| A3 | SRS 是自製 heuristic(weak/due/new/polish、`REQUEUE_GAP=3`、`MAX_SYNC_QUEUE=500`),非 FSRS/SM-2,無參數校準 | `scheduler.py`、`training_smart.py:60-67` | 先做儀表:收集「答對率 vs 距上次間隔」分布驗證間隔倍率;中期可引入 FSRS(開源、可離線)或至少把 magic numbers 集中為可調 config |
| A4 | 大樹成本線性成長:Build load 全樹 hydrate + 全樹 payload(2000 nodes 已 300ms+ 伺服器端,前端 JSON 解析/渲染另計) | benchmark 表 | 短期:payload 只送「目前展開路徑 + 同層兄弟」,子樹延遲載入;長期:node 列表分頁 API |
| A5 | 長任務優雅降級未做(無 `crossOriginIsolated`/iOS Safari 記憶體上限時) | `stability-perf-plan.md` #4(等 beacon 資料) | beacon 已上線,可開始做:啟動時 feature-detect → 明確文案 + 導向「僅瀏覽/訓練」模式;分析加「快掃(低深度)→ 深掃」兩段式,行動裝置不至於一次跑 1000 positions |
| A6 | Brilliant 只抓「犧牲/顯壞」型,安靜型妙手結構性漏抓 | `ARCHITECTURE.md` §9 自述限制 | 至少 UI 上明示偵測範圍;進階加 quiet-sacrifice heuristics(SEE 低於閾值 + reveal 高) |
| A7 | 研究/實驗程式碼與 production 共處 `web-src/`:scout-v12(已 retired 仍留 runtime 分支)、v13、shadow-prep、census、bias 系列合計逾萬行 | `engineering-health-state-map.md`;`views/scout.js:463-512` | 依既有決議把無 runtime import path 的研究檔移入 `research/`,v12 死碼刪除;v13 類實驗改 build flag 編譯隔離,讓 production bundle 與認知負擔都下降 |
| A8 | 超大輸入防護(1MB PGN / 1000 positions)有上限但使用者無感知 | `analyze.py:MAX_ANALYSIS_*` | 前端在貼上超限時說明「只分析前 N 局/前 N 手」的截斷規則,而非僅丟 400 |

---

## 4. 功能設計

### 4.1 現況亮點

- Analyze→Build→Train 的「移交」動線已成形(分析結果一鍵轉 repertoire、
  release cross-flow 8/8 通過)。
- Teams(角色、邀請連結、repertoire 分享/複製)、share-link fork、
  Stripe Free/Pro(quota gate 統一入口 `_enforce_repertoire_quota`)皆有骨架與測試。
- 訓練端有完整產品面:Smart queue、Line rehearsal、Play vs human、
  Feeling Lucky、streak/週 recap。

### 4.2 可改進之處(依產品風險排序)

| # | 問題 | 證據 | 建議 |
|---|------|------|------|
| F1 | **帳戶復原缺口**:無 email 驗證、無忘記密碼/重設流程;email+password 是主帳戶,忘密碼即永久鎖死(Google OAuth 是唯一旁路) | `api/routers/auth.py` 僅 register/login/me | 上線前必補:驗證信 + 重設密碼流程(同為 SaaS 基本期待);至少先加「聯絡支援」救援路徑 |
| F2 | Billing code done、Stripe keys 未接,Free/Pro 行為未在真實金流下驗證 | `ROADMAP.md` Phase 4 🔶 | 接 key 後驗證:checkout→webhook→plan 切換→portal→webhook 重放冪等(`stripe_events` 表已有,需實測) |
| F3 | Dashboard 推薦是靜態三行文案,而 payload 已有 `due_reviews`/`weak`/`open_mistakes` 等個人訊號 | `workspace.py:99-103` `_RECOMMENDATIONS` | 依訊號組個人化排序(「今天到期 5 張」> 通用文案);甚至可直接深鏈到 Train 的對應卡組 |
| F4 | 互通/匯出缺口:缺 repertoires 全量備份匯出、SRS 進度匯出(Anki/CSV)、分析報告 PDF/分享頁 | `repertoire_export.py` 只有單檔 JSON/PGN | 「Settings → 匯出我的全部資料」是付費產品的信任基建;SRS 匯出有助遷移友善形象 |
| F5 | Analyze `classify-save` 是單一大 payload(最多 1000 positions + assessments),中斷即需整段重送 | `analyze.py` 兩段式 POST | 分段提交(每 100 ply checkpoint)+ 進度暫存,弱網/行動網路可續跑;與 Build/Train 的 local-first 體驗一致 |
| F6 | Lichess 新局監看是輪詢(`scheduleLichessPoll`) | `app.js:3879-3950` | 依 `document.visibilityState` 暫停背景輪詢 + 指數退避;省使用者頻寬也省 Lichess API 配額 |
| F7 | 跨分頁/跨裝置同時編輯同一 repertoire 的衝突語意未定義(Build sync 以 move 為單位,後寫覆蓋) | `hydrateBuild`/`buildPending` 機制 | 起碼用 `BroadcastChannel` 做分頁互斥(第二個分頁唯讀提示);再進階才是 revision 檢查 |
| F8 | Teams 有角色但缺團隊活動視圖;分享 repertoire 的權限(只讀/可編輯)介面語意不顯 | `routers/teams.py`、`updateBuildReadOnlyUi` | 團隊時間線(誰改了哪條線)與明確的權限圖示;教室情境會需要 |

---

## 5. 視覺效果

### 5.1 現況亮點

- 完整設計 token:暖琥珀品牌色雙主題(深色是獨立調校而非反相)、棋盤/箭頭/
  座標專用變數、focus ring、語意色(danger/warn/good/brilliant)齊備
  (`styles.css:1-100`)。
- 動畫節制且有意義:squarePulse、boardFlip、streakPop、confetti、scout 進度 shimmer;
  `prefers-reduced-motion` 有三處獨立處理,且「帶資訊的動畫」刻意保留並註解原因
  (styles.css:2426)。
- 評估圖譜視覺敘事好:step-after 懸崖 + 錯誤著色 + 45–55% 平穩帶,直覺對齊 Lichess。

### 5.2 可改進之處

| # | 問題 | 證據 | 建議 |
|---|------|------|------|
| V1 | **eval chart 顏色硬編碼**,未走主題 token:主線 `#b9722a`、軸線 `#d6d2cb`、面積 `rgba(209,139,63,…)` | `views/analyze.js:287-380` | 深色主題下軸線過亮/主線偏暗;改用 `var(--accent)`/`var(--line)` 系列或 `currentColor`,讓圖表跟主題一致 |
| V2 | 圖表缺 hover/選取態:無 tooltip(該手勝率%、分類、SAN)、無「目前 ply」游標 | 同上 | hover 顯示卡 + 當前位置垂直游標;行動裝置改長按 |
| V3 | 圖表無 brilliant/mistake 的符號標記,只靠懸崖顏色 | 同上 | 加星號/嘆號 glyph,色盲用戶不只依賴顏色(評估全站分類 chip 也適用「色盲模擬」檢查) |
| V4 | `styles.css` 單檔 8,065 行、16 組 keyframes | `wc -l` | 拆 partials(tokens/base/layout/components/views);加 stylelint 規則禁在元件檔硬編 hex,改用 token |
| V5 | 基礎字級固定 `14px`,數字欄位未用等寬數字 | `styles.css:56` | 評分/百分比/倒數等數字用 `font-numeric: tabular-nums`(stats 卡對齊感);支援使用者字級偏好不破版 |
| V6 | 棋子組有樣式 picker(berlin 等)但無「高對比/無障礙」組 | `app.js:3339-3377` | 加一組高對比棋子(深底/描邊),WCAG 非文字對比也顧到 |

---

## 6. 用戶體驗簡潔化

### 6.1 現況亮點

- Command palette、Undo toast(showUndoToast + commitPendingUndos)、
  status 分級自動清除、拖放匯入、懶載入視圖(切換快、首屏小)。
- 設定頁把 Maia 下載(~46MB)、引擎狀態、深度/強度滑桿都收進 Settings 並附說明,
  Maia analysis 預設關閉(Stockfish 永遠可用)——下載成本由使用者 opt-in,正確決策。
- 空狀態即首次引導(dashboard 空時顯示後端的 next-action 清單)。

### 6.2 可改進之處

| # | 問題 | 證據 | 建議 |
|---|------|------|------|
| X1 | 進階面直接外顯:Analyze 側欄同時有 Coach/Engine widget/depth/Maia toggle/bookline;Scout 有 research 控制項 | index.html 各 view | 預設「簡單模式」;進階控制收進 ⋯/Adv 切換。產品的差異化在 Coach 敘事,不該被引擎參數搶版面 |
| X2 | 首次體驗只有三行文字建議,無步驟式引導 | `dashboard.js` `recommendationsHtml` | 3 步 checklist(匯入一局 → 建 repertoire → 訓練 5 張)帶完成勾選與深鏈;完成後自動讓位給個人化內容 |
| X3 | **無 i18n**:所有字串硬編於 index.html 與 JS 兩處,無 `Intl`/catalog | `grep` i18n 僅 scout-stats 命中 | 若目標市場含中文圈,抽 string catalog(先 zh-TW/en);順帶統一日期/數字格式 |
| X4 | 模式總數偏多:Train 三模式 + Feeling Lucky + 顏色/強度;Build 有 generate/coverage/explorer/health;Scout 有多層報告 | index.html:233-289 | 用「今日任務」單一入口收斂預設動線,其餘保持但降級為次級入口;符合 ARCHITECTURE「10 秒內開始有用的工作」原則 |
| X5 | 已知 P2 摩擦未清:sync chip 滯後、dashboard 計數不刷新、fork bar 只在父節點、Train reload 後 session 不續、smart mode chip 30px | 三份 friction audit | 建議開一輪「P2 burn-down」並把這些幾何/狀態斷言加進 release gate,免得重複被審計發現 |
| X6 | 錯誤呈現為單一 status 行(6–8s 自動清除),無重試入口;toast 與 status 兩套並存 | `setStatus` | 統一「通知中心化」:可重試錯誤給 Retry 按鈕、可復原給 Undo(已有);長任務錯誤不自動消失 |
| X7 | 首次 46MB 權重下載已 opt-in,但下載中的等待感(尤其行動網路)資訊不足 | settings-maia 區 | 顯示下載進度/大小與「稍後自動完成」;離線可用性說明寫進 Settings |
| X8 | 375px 下頂欄 7 個 tab 擁擠(雖有 More menu 兜底) | index.html topbar | 小螢幕把次要 tab(Games/Scout/Teams)收進 More,主四項維持可見;斷點統一見 U6 |

---

## 7. 優先級建議總表

| 優先 | 項目 | 理由 |
|------|------|------|
| **P0** | F1 帳戶復原(email 驗證 + 忘記密碼) | 主帳戶機制不可復原,是上線阻斷項 |
| **P0** | D5 Postgres 驗證 + D7 備份還原演練 | 唯一不可逆的資料風險;SQLite 測試覆蓋不到 PG dialect 差異 |
| **P1** | U3 鍵盤走棋/圖表鍵盤、U7 axe gate、U4/V1/V2 評估圖譜(鍵盤、主題色、tooltip) | 三份既有 audit 重複點名 + 無障礙基本盤 |
| **P1** | U1 續拆 `app.js`(stability #5)、A5 引擎優雅降級(stability #4) | 已有計畫文件,只差執行 |
| **P2** | A1 前後端分類合約測試、A2 enum 收斂、A3 SRS 校準、A4 大樹分頁 | 演算法正確性/可擴展性 |
| **P2** | D1/D2/D3/D6 資料層收尾、F5 分段提交、F3 個人化推薦、X3 i18n | 成長後才痛的點,現在成本最低 |
| **P3** | A7 研究檔隔離、V4 CSS 拆分/token lint、V5/V6 視覺細節、X1/X4/X8 介面收斂、F6/F7/F8 | 衛生與長尾,可隨維護節奏消化 |

---

## 8. 結語

這個專案最值得保留的資產是「一致性紀律」——同一組閾值在前後端互相錨定、
schema 由 Alembic 獨裁、安全面有結構性防護(如 wheel 永不打包 ONNX 的
exact-filename 設計)。上面列的改進點大多屬於「把已建立的紀律推到最後一哩」:
資料層的 PG 驗證與備份、UI 的無障礙與鍵盤、產品的帳戶復原與個人化。
建議依 P0 → P1 順序,以現有 release gate 為每步的完成定義。
