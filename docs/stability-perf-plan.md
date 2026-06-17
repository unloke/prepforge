# 穩定性 / 效率 / UX / 伺服器壓力 — 執行計畫

> 目標:打口碑階段。讓產品「載入快、不崩、回訪秒開」,而不是收費。
> 本檔是可照做的 backlog;每個項目都附「做什麼 / 為什麼 / 改哪裡 / 完成定義」。
> 每步都能獨立 commit,且 commit 前跑完 gate(見最後)。

架構前提:伺服器**不算棋**(`analyze.py` 走 `ReplayEngine`/`ReplayMaia` 重放瀏覽器算好的評估),
所以伺服器壓力主要是**靜態大檔頻寬 + DB**,瓶頸在客戶端首載與穩定性。

已確認「已經做好、不要重做」:
- 45MB Maia 權重已有 IndexedDB 持久快取(`web-src/engine/maia3-weight-cache.js`):content-addressed key、SHA256 驗證、壞檔自動 evict、Settings 有 Reset。
- `.wasm/.onnx` 已送 `Cache-Control: immutable, max-age=1yr`(`static.py` `_cache_control`)。

---

## #1 — 前端錯誤回報(觀測,先做,解鎖其他判斷)  規模 S

**做什麼**:全域抓未處理錯誤,beacon 回傳後端寫 log。
**為什麼**:目前對前端崩潰完全全盲;沒有它,#4 與後續優先級都是猜的。

**前端**(`web-src/app.js`,放在啟動早期):
```js
function reportClientError(payload) {
  try {
    navigator.sendBeacon("/api/clientlog", new Blob(
      [JSON.stringify(payload)], { type: "application/json" }));
  } catch { /* best-effort, never throw */ }
}
window.addEventListener("error", (e) => reportClientError({
  kind: "error", message: e.message,
  src: e.filename, line: e.lineno, col: e.colno,
  stack: e.error && e.error.stack, ua: navigator.userAgent,
  coi: !!self.crossOriginIsolated, t: Date.now(),
}));
window.addEventListener("unhandledrejection", (e) => reportClientError({
  kind: "rejection",
  message: String(e.reason && e.reason.message || e.reason),
  stack: e.reason && e.reason.stack, ua: navigator.userAgent,
  coi: !!self.crossOriginIsolated, t: Date.now(),
}));
```

**後端**:新增 `src/prepforge_chess/api/routers/clientlog.py`,`POST /api/clientlog`:
- 體積上限(例如 8KB)防濫用;`sendBeacon` 不帶 CSRF header → 此端點**豁免 CSRF**(只寫 log、不改狀態,安全)。
- 不需登入(匿名訪客也會崩);但可選擇性附上 user id(若 session 有)。
- 用 structured logging 輸出(已有 Sentry dark-by-default → 會被吃進去)。
- rate-limit / 取樣以免被灌爆(可先簡單,之後看量再加)。
- 在 `main.py` 註冊 router。

**完成定義**:手動丟一個 `throw` → 後端 log 出現該錯誤;`pytest` 有一個 test 打 `/api/clientlog` 回 204/200;CSRF 豁免有 test 覆蓋。

---

## #2 — keep-warm ping `/healthz`(伺服器/UX)  規模 XS

**做什麼**:外部排程每 ~10 分鐘 ping 一次 `/healthz`,免得 Render free tier 睡著。
**為什麼**:免費方案閒置會睡,新訪客第一印象是冷啟動轉圈 30–60 秒。

**做法(擇一,不需改 app 程式碼)**:
- UptimeRobot 免費監控指向 `https://<prod>/healthz`(順便當 uptime/alert)。**建議**。
- 或 GitHub Actions cron(`schedule: */10 * * * *`)`curl` 一下。
- 或 Render Cron Job。

**完成定義**:連續 ping 紀錄可見;手動隔 20 分鐘後開站,首載無冷啟動延遲。
**註**:免費 Render 仍可能有月度運行時數限制,確認 ping 頻率不會把額度燒光。

---

## #3 — Stockfish/ORT WASM 搬上 Hugging Face(效率 + 伺服器壓力)  規模 M

**現況**:`PREPFORGE_ENGINE_ASSET_BASE` 已設為
`https://huggingface.co/Andy108/prepforge-maia3/resolve/main/`,檔案已上傳。
但程式還寫死本機路徑:
- Stockfish:`web-src/engine/stockfish-provider.js:13` `ENGINE_URL = "/static/engine/stockfish-18-lite.js"`
- ORT wasm:`web-src/engine/maia3-worker.js:28` `ort.env.wasm.wasmPaths = "/static/engine/ort/"`

**策略**:只搬大的 `.wasm`(ORT 24M + SF 7M),小的 `.js` shim 留本機。

### 3a 後端:注入 `window.__ENGINE_ASSET_BASE`
- `static.py`:新增 `ENGINE_ASSET_BASE_ENV = "PREPFORGE_ENGINE_ASSET_BASE"`,
  仿 `_maia3_asset_base()` 加 `_engine_asset_base()`。
- **關鍵**:在 `_asset_base_script()` 把兩個變數**寫進同一段 inline script**
  (`window.__MAIA3_ASSET_BASE=...;window.__ENGINE_ASSET_BASE=...;`)。
- **CSP 坑**:`middleware.py:54` 的 `script_hashes` 由 `static.py` 的 `_document_csp()`
  **動態計算**(`_csp_script_hash(script_body)`,見 `static.py:131–164`)——hash 跟 inline
  script 內容綁定,不是寫死在 middleware。因此新變數必須併進**同一段** `_asset_base_script()`
  輸出;若拆成第二段 `<script>`,第二段沒 hash、會被 CSP 擋掉。
- 更新 `tests/test_api_static.py`:加 `__ENGINE_ASSET_BASE` 注入 / 未設時 no-op / script-breakout 轉義 的 test。

### 3b 前端:讓引擎讀 base
- 新增 `resolveEngineBase()`(仿 `maia3-provider.js:42` `resolveModelBase`):
  `globalThis.__ENGINE_ASSET_BASE` → 空字串 fallback 回 `/static/engine/`。
- Stockfish:`ENGINE_URL`/wasm `locateFile` → `${engineBase || "/static/engine/"}stockfish-18-lite.wasm`。
  小 `.js` 留本機。
- ORT:`ort.env.wasm.wasmPaths = engineBase ? \`${engineBase}engine/ort/\` : "/static/engine/ort/"`。
  注意 worker 看不到 `window.*`,base 要在**主執行緒解析後傳進 worker**(Maia 已是這模式,照抄)。

### 3c COEP 驗證(成敗關鍵,務必做)
頁面為了多執行緒 WASM 開了 `crossOriginIsolated`(`COOP + COEP: require-corp`)。
跨來源的 HF 檔案**必須帶 CORS / CORP**,否則被瀏覽器擋、引擎直接死。
- HF CDN 會送 `Access-Control-Allow-Origin: *`,理論可行。
- 部署後**在瀏覽器 console 確認**:`crossOriginIsolated === true`,且 Analyze 能起 Stockfish + Maia。
- 跨源 wasm 抓取確認用 CORS 模式(`crossorigin` / fetch mode cors)。

### 3d 版本失效(順手修掉潛在 bug)
HF `resolve/main/` 是**會變動的分支 ref**;重傳同檔名 → URL 不變 → 舊使用者吃到舊引擎快取。
- 解法:URL 釘到 commit hash,或檔名帶版本/hash(像 Maia 的 content-addressed)。
- 進階(可選):讓 SF/ORT wasm 也走 `loadVerifiedWeights` + IndexedDB(manifest+sha256),
  一次解決 HF 託管 + 持久快取 + 版本失效;但工作量較大,v1 可先用釘版本的簡單法。

### 3e Dockerfile 瘦身(搬完才做)
確認 HF 路徑可用後,`Dockerfile` 可不再 COPY 那 31MB wasm → image 變小、deploy 變快。
**保留本機 fallback**(env 未設時仍能跑),別把本機檔全刪。

**完成定義**:設了 env 的環境下,Network 顯示 wasm 從 HF 載入;`crossOriginIsolated === true`;
Analyze/Build 引擎正常;未設 env 時 fallback 本機仍正常;`npm test` + `pytest` 綠。

---

## #4 — 引擎「優雅失敗」訊息(穩定/UX)  規模 S  ⚠️ 等 #1 資料再決定

**做什麼**:偵測引擎確實起不來(無 `SharedArrayBuffer` / `crossOriginIsolated === false`)時,
顯示一句清楚訊息(「此瀏覽器無法執行引擎,但你仍可瀏覽棋譜/訓練」),而不是白屏。
**為什麼**:現代裝置普遍跑得起來;真正炸的只有 iOS Safari 記憶體上限與缺 SAB 的環境。
**所以**:**先別憑空寫**。等 #1 的 beacon 收到真實資料,確認有人踩到再做、並對準實際的失敗樣態。

---

## #5 — 拆分 `web-src/app.js`(10,140 行 → 單一 304KB chunk)  規模 L

**做什麼**:沿 feature 縫把各 tab 抽成 lazy-import 模組,縮小首屏 JS。
**為什麼**:首屏少載 JS = 載入更快;同時降維護成本。
**前提**:拆分模式**已存在** — `explorer.js`/`coverage.js`/`scout.js` 已是 `await import()`
(`app.js:5860 / 9404 / 9626`),這是沿用同一招擴大,不是從零。

抽出對應(按 `render*` 段落):
| 模組 | app.js 區段(行) | lazy 載入時機 |
|---|---|---|
| `views/teams.js` | renderTeamsList… 3638–3960 | 切到 Teams tab |
| `views/analyze.js` | renderAnalysis/Tree/EvalChart 4978–5680 | 切到 Analyze tab |
| `views/build.js` | renderBuilderTree/Breadcrumb/BranchBar 5683–6230 | 切到 Build tab |
| `views/train.js` | train 相關 | 切到 Train tab |
| `views/shared/movetree.js` | renderMoveToken/Line/Variation 5191–5358 | 共用 |
| (留主 chunk) | renderDashboardToday 2820–2960 | 首屏 |

**執行順序(一步一 commit,純位移不重構)**:
1. 先抽 `views/teams.js`(最獨立、後加、依賴最少)→ 建立 pattern、驗證 lazy import + 測試綠。
2. 抽 `views/analyze.js`(最大塊)。
3. 抽 `views/build.js`。
4. 抽 `views/train.js`。
5. 抽共用樹狀渲染 `views/shared/movetree.js`。
6. app.js 最後只剩 router + 共用 state + 首屏 dashboard。

**守則**:一次一個 view;先搬不改邏輯,測試綠再 commit;每步跑 `node scripts/check-bundle-size.mjs` 看主 chunk 縮小。
**完成定義**:主 chunk 明顯變小;切 tab 時對應 chunk 才載入;`npm test` 全綠;行為無變化。

---

## 各步通用 Quality Gate(commit 前)

```powershell
uv run ruff check src tests          # 或 .\.venv\Scripts\python.exe -m ruff ...
uv run pytest -q
$env:DATABASE_URL="sqlite:///ci_check.sqlite3"
uv run alembic upgrade head
uv run alembic check
npm test -- --run
npm run build
node scripts/check-bundle-size.mjs
```

## 建議順序
1 → 2 →(#1 資料回來後評估 4)→ 3 → 5。
#1/#2 便宜且立刻有口碑價值;#3 卸載伺服器頻寬 + 加速回訪;#5 最大但最慢,放後面。
