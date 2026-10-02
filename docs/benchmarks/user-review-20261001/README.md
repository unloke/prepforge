# 用戶問題發現 benchmark · 2026-10-01

這是一個「agent 能不能自己發現用戶已指出的問題」基準。只檢查、交報告、人工對表評分；不修程式、不設自動判分器，也不把這些問題鎖成未來產品規格。

## 固定版本

- Git tag：`benchmark/user-review-20261001`
- Commit：`aecebd3257ad375ed26b808da87b13bffc5aa582`
- 本機程式碼快照：[source.zip](../../../artifacts/benchmarks/user-review-20261001/source.zip)
- ZIP SHA-256：`BE1A304C450E2EDDBD66FC9991E0D927CAFFB76FBCA2A9D4C7CC5FB2DFA282A2`
- 固定資訊：[manifest.json](manifest.json)

凍結時受 Git 追蹤的工作檔沒有修改；ZIP 只包含該 commit 的受追蹤檔案，包括已提交的前端 build、engine 資產與依賴 lock files。未追蹤的 agent 設定、worktrees、審查產物，以及忽略的資料庫、帳號、環境變數、Maia 權重不在快照中。因此這是原始碼與已提交資產的基準，不是整台機器或線上服務的備份。Tag 不應移動；以完整 commit 與 ZIP hash 為準。

ZIP 留在本機 artifacts，不重複提交整份程式碼。其他 checkout 可由固定 commit 重建（需要傳到遠端時，另傳此 tag）：

```powershell
git archive --format=zip --output=source.zip aecebd3257ad375ed26b808da87b13bffc5aa582
```

原 ZIP 使用 annotated tag 產生；改以 commit 重建的 ZIP 封裝 metadata／hash 可能不同，檔案內容仍須對應同一 commit。若要求核對原 ZIP hash，使用 `benchmark/user-review-20261001` 作為 archive 來源。

## 一次可用的流程

1. 用戶保留 [評分答案](scorecard.md)，只交給受測 agent [檢查指令](agent-prompt.md) 與 ZIP。將 ZIP 解壓到新的目錄並開新 agent session；不要提供本次對話、答案檔或其他 agent 的報告。若用 Git，另建 detached worktree：

   ```powershell
   git worktree add --detach D:/auto_art/PrepForge-benchmark-20261001 aecebd3257ad375ed26b808da87b13bffc5aa582
   ```

   Worktree 仍可透過原 repo 看到答案；需要較乾淨的盲測時使用 ZIP，並限制受測 agent 只讀解壓目錄。不把「能找到答案檔」算發現能力。

2. 在隔離目錄依凍結版 `README.md` / `docs/DEPLOYMENT.md` 啟動。最小本機例子（兩個 PowerShell 終端共用同一測試資料庫設定）：

   ```powershell
   npm ci
   npm run build
   uv sync --extra server --extra dev
   $env:DATABASE_URL="sqlite:///benchmark.sqlite3"
   uv run alembic upgrade head
   uv run uvicorn prepforge_chess.api.main:app --host 127.0.0.1 --port 8000
   ```

   只使用隔離測試資料庫與測試帳號。Maia、外部棋局載入與登入依部署文件配置；資產來源使用 commit-pinned URL，記錄實際 manifest/hash。缺模型或服務時保留該項為「未測」，不要用 mock 成功冒充實際結果。

3. 用戶先備好測試帳號、Games 棋局、可完成 Scout 黑白各 12 場的同一份輸入，以及一盤至少 30 ply、可以正常 Analyze 的 PGN。把 PGN／Scout 輸入另存到這次 run 的目錄，記錄檔案 hash、對手名稱、篩選條件及實際載入數。同一批比較都用這份資料；避免外部即時資料變動。首次可用公開棋局建立資料，但建立後就保存再使用。

4. 預設 Chromium、100% zoom、`1366×768` 及 `1440×900` viewport；這是本基準指定的桌面尺寸，用戶原文沒有提供尺寸。若問題只在其他尺寸出現，明列尺寸與條件。記錄 CPU、瀏覽器版本、engine/模型狀態與設定。每次 run 使用新 browser profile／相同起始資料，並分開記錄首次載入與暖快取。若要比較 agent，使用相同工具权限與檢查時間（例如每次 60 分鐘）。

5. 把 `agent-prompt.md` 的正文貼給 agent。Agent 輸出 `findings.md` 與證據，不讀答案、不自評。不要在過程中提示遺漏的問題。必要時可以自行用 browser 操作與小型追蹤腳本，沒有必要新增測試框架。

6. Agent 交卷後，用戶或另一個評閱 session 讀答案，複製 [結果模板](results-template.md)，逐項填入匹配的 finding、證據、分數與理由。交付原始 `findings.md`、證據及 `results.md` 給用戶自行解析。原始報告不可在看答案後補寫；新的發現另列，不回填本次分數。

## 解讀分數

答案有 12 項、總分 100；包含功能、呈現及架構優化，分類分數要一起呈現。這是用戶回報的參照答案，尚未在本次凍結工作逐項獨立重現。來源碼證明已修復或條件不成立時，保留反證並交用戶判斷，不能要求 agent 為拿分捏造問題。

完整測試才把總分當作 `/100` 比較。環境缺失或有證據的答案爭議，另外報「可評項得分／可評滿分」與排除原因，不自行換算成完整版本的表現。僅未找到而沒有阻擋或反證，算 0 分。

用戶提到 Coach 語氣已改善、可以縮小，這兩點是正面背景，不是扣分項。「Scout 一樣 hidden bug 沒解決」没有額外描述；目前只把具體的 24／12 配額問題列入答案，不憑空增加一項。
