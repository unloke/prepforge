# UX 與資料讀寫續查 — 2026-10-04

基準：`73300673`（#117 已合併），對照 `async-persistence-review.md` 後重新查碼。這是新一輪審查，不代表已修復。未修改產品程式。

驗證分成「控制非同步完成順序的最小重現」與「程式路徑確認」。本輪沒有瀏覽器端到端錄影或真實大型帳號的效能量測，效能項目不承諾固定加速比例。

## 優先修正的問題

### F01 — P1：箭頭儲存沒有接回 revision，下一次正常儲存就可能 409

- 位置：`web-src/app.js:8461`、`src/prepforge_chess/api/routers/workspace.py:1116`、`src/prepforge_chess/storage/repositories.py:868`。
- 觸發：乾淨的 Build 棋譜 revision=4，畫一次箭頭成功，再畫一次。
- 後端更新節點時 `_bump_revision()` 到 5，API 也回傳 5；前端 `await postJson(...)` 卻丟棄結果，第二次仍送 `base_revision: 4`。沒有待同步 move 時，`hardFlushBuild()` 不會重新取得 revision。
- 最小重現確認送出 `[4, 4]`；模擬後端依實際 revision 契約拒絕第二次，前端回滾箭頭。這不是另一個分頁造成的衝突。
- 建議：成功後將 revision 更新到同一 repertoire 的狀態，與其他 Build mutation 共用寫入排序；不要直接移除 revision 檢查。
- 驗收：連畫兩次均成功；畫完再新增 move 不產生自己造成的假衝突；真正的跨分頁衝突仍被保護。

### F02 — P1：localStorage → IndexedDB 缺少舊 checkpoint 搬移

- 位置：`web-src/analyze-checkpoint.js:11`；前一版 `19ef18cf:web-src/analyze-checkpoint.js`。
- 舊版使用 `prepforge.analyze_checkpoint.v2.<owner>.<game>` 與 owner index；新版只讀 `prepforge-analysis-checkpoints` IndexedDB。現行 production source 沒有舊 key 的 reader 或 migration。
- 最小重現：放入有效舊 checkpoint 與 index，新版 `loadCheckpoint(null, owner)` 回傳 null。資料仍在 localStorage，但新版救回流程看不到。
- 建議：按 owner 做一次可重試搬移，交易成功後才刪舊資料；保護 IndexedDB 已有的新版本，並替缺少 request UUID 的舊 checkpoint 建立穩定識別。
- 驗收：升級、搬移中斷、quota failure、同一 game 兩種 store 都有資料、不同 owner 隔離。

### F03 — P1：Settings 的 GET 可以讓成功的 POST 永遠不更新畫面

- 位置：`web-src/settings-actions.js:7,43`。
- 觸發：儲存深度 20 尚未完成時重新進入 Settings；新 GET 在 POST commit 前讀到舊深度 12。
- GET 增加共用 `settingsRequestSeq`；POST 完成時因此被判定過期，忽略正確回覆。最小重現結果為 server response=20，`appState.settings.stockfish_depth=12`。同時也跳過 engine 的設定變更通知。
- 建議：read 必須協調 pending writes，例如等待 write queue 後再讀；維持 owner 隔離。不能只用「最後發出的請求」代表最新已儲存狀態。
- 驗收：GET 在 POST 前後各種完成順序、連續兩個 patch、儲存失敗後重讀。

### F04 — P1：History 舊帳號請求可以在切換帳號後重新填入清單

- 位置：`web-src/app.js:5079`。
- `loadAnalysisHistory()` 只有清單 request sequence，沒有 owner/session 檢查；production source 中沒有帳號切換時遞增 `analysisHistorySeq` 的路徑。
- 最小重現：A 的 History 請求發出，切到 B 並清空 host，A 的回覆到達後仍寫入 A 的玩家姓名與 game ID。
- 這是前端舊資料再顯示，不表示 B 能繞過後端 ownership API 取得分析內容。
- 建議：捕捉 owner/session generation，成功及失敗回覆都需驗證；退出帳號時清空與失效 pending history。

### F05 — P2：History 的第 51 局以後無法透過該清單開啟

- 位置：`web-src/app.js:5079`、`src/prepforge_chess/api/routers/analyze.py:415`。
- 後端預設 `limit=50` 並提供 `next_cursor`；前端固定 GET `/api/analyses`，只渲染 `analyses`，沒有讀取 cursor、載入更多或下一頁。
- 程式路徑確認；最小重現回覆附 `next_cursor`，前端仍無 continuation。
- 建議：Load more 或漸進載入；每頁沿用 owner/sequence 保護、game ID 去重、保留 scroll。

### F06 — P2：處理一份 checkpoint 後，其他待救回分析的提示消失

- 位置：`web-src/app.js:6784,6801,14923`。
- 登入只挑最新 checkpoint；Discard 清完後直接隱藏提示，Retry 成功亦如此，沒有再查下一份。
- 最小重現：儲存 older/newer 兩局，Discard newer 後，提示 hidden、綁定 checkpoint=null，但 IndexedDB 仍留一份 older。
- 資料沒有被刪掉，重新載入登入流程可再次找到；問題是當次工作階段讓使用者以為已經全部處理完。
- 建議：處理完後刷新待救回項目，顯示下一份或按需開啟清單；同時讓使用者辨認所屬棋局。

### F07 — P2：Teams 選到 B，載入期間仍可操作 A 的按鈕

- 位置：`web-src/app.js:5231`。
- 選取 B 時只替 members 放 Loading；header 名稱、角色、管理按鈕及 onclick 要等 B 回覆後才替換。失敗時也只替換 members error。
- 最小重現：B 請求 pending 時按 Delete，仍觸發 A 的 handler。刪除本身有後續確認，但選取列與可操作目標已不一致；邀請、分享等按鈕也有相同暫留路徑。
- 建議：切換時讓上一個 detail 的動作失效；載入失敗時維持失效狀態，直到正確 detail 就緒。

### F08 — P2：checkpoint 清理失敗仍被當成已清掉

- 位置：`web-src/app.js:6654,6839`、`web-src/analyze-checkpoint.js:69`。
- 程式路徑確認：`clearCheckpoint()` 失敗回傳 false；分析儲存成功與 Retry 成功的分支都忽略布林值，接著隱藏救回提示。
- 若 IndexedDB transaction 失敗，伺服器已儲存但本機舊 checkpoint 尚在，下次啟動又顯示未儲存分析。穩定 UUID 能防重存，不能解決錯誤提示。
- 建議：把 server save 成功與 local cleanup 完成分開追蹤；以清理重試處理，勿誤報分析本身未存。
- 驗收：server save 成功 + clear transaction abort，重新開頁不把它當成需要重新分類的工作。

### F09 — P2：Teams 清單與共享棋譜沒有過期回覆保護

- 位置：`web-src/views/teams.js:72`、`web-src/app.js:5604`。
- 程式路徑確認：`loadTeams()` await 後直接覆寫 `appState.teams`，再自動開 detail；`loadSharedRepertoires()` 同樣直接替換 DOM。都沒有 owner 或 request sequence。
- 較早 refresh 比 mutation 後 refresh 更晚完成，就可把已更新的列表覆蓋回舊狀態；帳號切換也有舊資料重新出現的路徑。
- `openTeamDetail()` 自己已有 guard，無法保護上游列表寫入。
- 建議：每個列表維護 owner/sequence，視圖離開與帳號切換時取消或忽略舊請求。

## UX / 讀取 / 儲存加速改良

### P01 — 拆開 Library 的三段網路等待

- 位置：`web-src/views/dashboard.js:674,780`。
- 目前 `/api/dashboard` →（teams 空時）`/api/teams` → `/api/repertoires` 依序進行。棋譜清單不需要先等統計，也不需要等團隊名稱。
- 改為獨立載入，先顯示可用資料；Teams 名稱稍後補上。統計失敗也應讓 Library 清單仍可使用。
- 驗收：統計或 Teams API 刻意延遲/失敗，棋譜仍可先開；可量測「可操作清單」出現時間。

### P02 — 登入後先恢復本機工作，不要等遠端 Dashboard

- 位置：`web-src/app.js:14872`。
- 目前先 await settings，再 await Dashboard，才 `restoreOutbox()` 與 `loadCheckpoint()`。遠端慢時，本機已有的待同步/救回工作也被拖住。
- owner 確立後即可恢復本機狀態；遠端 settings/list 獨立載入。新增 await 邊界時須重新檢查 owner。

### P03 — 快取「已確認沒有 Teams」，避免每次重查

- 位置：`web-src/views/dashboard.js:675`。
- 現在 `!appState.teams.length` 同時代表「尚未載入」與「已載入但零個」。沒有團隊的使用者每次刷新 repertoire list 都再付一次 Teams request，而且它在主要清單前面。
- 增加 owner-scoped loaded/in-flight 狀態，create/join/leave 後失效即可。

### P04 — 背景 refresh 失敗時保留可用的 Library 清單

- 位置：`web-src/views/dashboard.js:712`。
- 背景刷新失敗直接 `renderLibraryListError()`，即使原本已有完整快取也把清單替換掉。
- 保留上一份清單與選取項目，以短暫錯誤狀態及 Retry 呈現刷新失敗；首次載入才使用整塊 error state。這可減少不必要的清空、重畫與操作中斷。

### P05 — 每次箭頭儲存不必重建整棵 opening tree

- 位置：`src/prepforge_chess/services/opening_builder.py:1152,1382`。
- response 已是小 payload，但 `set_annotations()` 仍 load 完整 repertoire，再遞迴找一個 node，最後只更新該 node 的兩個欄位。
- 可改為 repertoire/node 對應的定點查詢與更新，在同一交易保留 ownership/revision/存在性檢查。大 repertoire 下節省的是後端讀取與物件重建成本。
- 驗收：不同樹大小下的 SQL rows、hydration 時間，並測 foreign node 與 revision conflict。

### P06 — 箭頭連續操作合併待送快照，避免排隊重畫舊版本

- 位置：`web-src/app.js:8472`。
- 現在每次 gesture 都排一個完整 arrows/circles 快照，前一個成功還會 `setAnnotations()` 畫回該版本。慢網路下，畫面可能先被舊成功回覆覆蓋，再等後續儲存；也會累積請求。
- 同 owner/repertoire/node 可保留一個 in-flight + 一個最新待送快照；成功回覆更新 confirmed/revision，但不得覆蓋更晚的可見編輯。若離頁仍要保留草稿，需要明確 durable queue 設計。
- 先修 F01，再測 reversed/delayed responses、最後一次失敗、切 node、離頁。

### P07 — 帳號匯出不要在瀏覽器 parse 完再 stringify 一次

- 位置：`web-src/views/settings-account.js:189,340`、`web-src/app.js:3396`、`src/prepforge_chess/api/routers/account.py:48`。
- 後端已 StreamingResponse，但前端通用 `api()` 先讀完整 text + JSON.parse，download 再 pretty JSON.stringify + Blob；瀏覽器端仍有完整物件與大字串配置，且受一般 GET 30 秒期限約束。
- 使用專用下載路徑，讓 server 提供附件 filename 並由瀏覽器接手；若仍要 Blob，至少免去 parse/stringify，搭配下載用途的期限/取消。
- 驗收：大帳號匯出的峰值記憶體、長任務、下載完成時間、途中失敗。不能宣稱目前後端 streaming 已等於端到端低記憶體。

### P08 — Dashboard 的 due now / due soon 合併同一次遞迴查詢

- 位置：`src/prepforge_chess/api/routers/workspace.py:190`、`src/prepforge_chess/storage/repositories.py:1236`。
- 目前分別以 now 與 now+24h 呼叫 `due_counts_by_repertoire()`；每次都跑 `mastery_counts_by_repertoire()` 的 recursive CTE，還計算完整五種 mastery buckets，最後只取 due。
- 可在同一 owner-scoped traversal 以兩個時間條件聚合；保留 weak 優先、有效祖先、own-side 與 active repertoire 語意。
- 驗收：結果對等，並量測 query count/plan/執行時間；不能只把 due_at 比較抽出來而改變 scheduler 語意。

### P09 — checkpoint 最新查詢用索引，不必 getAll 後排序

- 位置：`web-src/analyze-checkpoint.js:39,60`。
- 新版已避免讀全部 payload，但最新 lookup 仍讀 owner 全部 metadata，再 JavaScript sort，然後另開 DB/transaction 讀 payload。取消 count cap 後，成本仍隨待救回項目數增加。
- 建立 owner + savedAt 複合索引，倒序 cursor 取首筆；把 metadata/payload lookup 放同一 readonly transaction，减少開關連線，也避免兩次交易間最新項目消失後直接回 null。
- 驗收：大量 metadata、同時刪除最新 checkpoint、相同 savedAt 的穩定排序。

## 驗證與交付

- `node artifacts/async-persistence-followup-probe.mjs`：六組最小重現全部符合上文描述；測試只使用 fake IndexedDB、stub DOM、deferred promises，不碰真實帳號資料。
- `npx vitest run web-src/analyze-checkpoint.test.js web-src/async-persistence-regression.test.js web-src/analyze-owner-regression.test.js web-src/views/dashboard-error-state.test.js`：4 files / 36 tests passed。
- 最小重現部分直接擷取目前 app.js 的函式，與既有 regression suite 採相似方法；它確認函式層行為，不取代瀏覽器與 API 整合測試。F01 的後端 revision bump/409 契約另以 source trace 核對。
- 建議先做 F01/F02/F03/F04，再接 P01/P02/P07/P08。其餘可依實際使用頻率排序。
