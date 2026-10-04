# Async persistence follow-up：重新驗證與修正

基準 HEAD：`73300673`。本次依目前 production 呼叫链與可控制完成順序的 regression tests 重新驗證；不以原始 probe 的 stub 結果代替實際 wrapper 行為。

| 項目 | 最新 HEAD 判定與處理 |
| --- | --- |
| F01 | 原敘述不成立：`postJson()` 已呼叫 `advanceBuildRevision()`，連續成功註記会接回 revision、重設同版本待送 moves。補上使用真正 wrapper 的測試。另於 P06 加入 Build mutation 排序，保護同分頁不同操作同時寫入；舊 conflict base 仍會保留。 |
| F02 | 依使用者指示排除。IndexedDB 是唯一 checkpoint storage；沒有 localStorage migration、reader 或 fallback。移除 `requestId || savedAt` 舊識別 fallback，清理需明確 request UUID。 |
| F03 | Confirmed。Settings GET 等待 queued writes，read sequence 與 write sequence 分開，防止成功 POST 被舊讀取吞掉；owner/session generation 隔離。 |
| F04 | Confirmed。History 的成功、錯誤與點擊 handler 都驗證 owner/session；帳號變動清空清單並使舊請求失效。 |
| F05 | Confirmed。History 支援 Load more、next cursor、game ID 去重、保留 scroll；每頁沿用同一 owner/session 保護。 |
| F06 | Confirmed。Discard、Retry 與新分析存好後會重新挑選剩餘 recovery；提示顯示玩家或 game ID。 |
| F07 | Confirmed。開始切換團隊即清掉舊 action handlers、角色、共享內容；新 detail 失敗時仍沒有舊操作可按。 |
| F08 | Confirmed。保存成功與 device cleanup 分開。以同 UUID 持久標記 serverSaved，刪除失敗顯示 Retry cleanup；重新開頁以輕量 owner-scoped receipt GET 確認，兩次本機交易皆失敗亦不會直接誤報未儲存。Cleanup retry 不再呼叫 classify-save。 |
| F09 | Confirmed。Teams directory 與共享棋譜各有 request/owner/session guard；離開 Teams 會使 pending detail/list 請求失效。 |
| P01 | Confirmed。Library listing、statistics 與 optional team names 獨立發出／呈現；statistics 失敗仍能開 repertoire。 |
| P02 | Confirmed。Owner 確立後立即 restore outbox 與 checkpoints，settings/dashboard 遠端載入並行，不擋本機工作恢復。 |
| P03 | Confirmed。Owner-scoped team directory 區分未載入、in-flight、已載入空清單；mutation refresh 會重讀並使較早請求失效。 |
| P04 | Confirmed。已有 listing 的 refresh 失敗保留 rows、selection 與 scroll，另顯示短暫錯誤及 Retry；首讀失敗才顯示整塊 error。 |
| P05 | Confirmed。Annotation 改為 repertoire/node 定點 UPDATE，沒有 tree hydration；同一 transaction 保留存在性與 revision CAS。API ownership gate 不變。 |
| P06 | Confirmed。每一 owner/repertoire/node 保留一個 in-flight 與最新待送快照。舊成功只更新 confirmed/revision，不會畫回舊編輯；最後失敗回復最近 confirmed。所有 Build revision mutations 共用寫入排序。 |
| P07 | Confirmed。匯出直接讀 Blob，免除 text/JSON.parse/JSON.stringify；專用期限 5 分鐘，錯誤仍沿用 API error handling，owner/session 變動不下載。伺服器提供 attachment filename。 |
| P08 | Confirmed。Due now／24h 用同一 owner-scoped recursive traversal 聚合兩個窗口；沿用 untrained、weak、due 的 precedence、有效祖先與 own-side 規則，Dashboard 仍只合計 active repertoires。 |
| P09 | Confirmed。IndexedDB owner/savedAt/gameId 複合索引倒序 cursor，latest metadata/payload 在同一 readonly transaction；相同 timestamp 以 game ID 穩定排序。 |

Checkpoint 現行 IndexedDB 的索引更新屬正常 storage schema 演進；没有讀取舊 localStorage 或舊 checkpoint 格式的 compatibility layer。

Annotation drafts 仍屬本頁工作，没有新增 durable annotation outbox。帳號匯出仍需保留完整 Blob；本次沒有宣稱端到端串流或實測大型帳號的記憶體減幅。IndexedDB 無法使用時，receipt 查詢失敗會明示結果未確認，不假裝清理成功。

SQL regression：annotation route 的 opening-tree SELECT 次數為 0；due windows 與原本兩次查詢結果一致，statement 次數為 1。這些是成本形狀驗證，不是整頁固定加速比例。

Production 主 bundle 約 341 KB raw；本輪 recovery receipt、pagination、寫入排序與快照合併把上限由 338,000/106,000 B 調整成 342,000/109,000 B（raw/gzip），保留窄幅 gate。

??????? 151 files?2030 tests ????? 798 passed?32 skipped?6 deselected?Ruff?ESLint?production build?bundle gate?static freshness ????? UI viewport/state smoke ??????States ???statistics ????? Library???????????????? Retry?
