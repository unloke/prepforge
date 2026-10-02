# PrepForge Chess：UI、資料互動、演算法與使用體驗詳細檢查報告

檢查日期：2026-09-30（America/Phoenix）。  
檢查基準：HEAD `2dec2e5` 加上檢查當下工作目錄的未提交變更。  
交付範圍：評估、建議、驗證紀錄與截圖；本次沒有修改產品程式、正式資料庫、套件或部署設定。  
讀者：產品負責人、前後端開發者與後續驗收人員。

## 1. 整體判斷

專案已具備相當完整的棋類準備流程：匯入棋譜、瀏覽器分析、建立開局準備、記憶訓練、實戰比對、偵察對手與團隊分享。介面有一致的卡片、棋盤、配色及手機導覽；資料層已有所有權隔離、不可變評估快照、批次儲存、訓練收據及部分併發保護。**最值得改善的是資料可靠性契約的最後一段，以及讓每個畫面更直接指向當前任務。**

目前不需要因為單一檔案很大就全面換框架，也不宜把演算法、資料同步與視覺重構一起改。優先順序應是：確認使用者做過的事能正確保存與恢復，再校準結果與排程語意，最後依量測改善密度及效能。

本次最重要的發現如下。

| 項目 | 發現 | 證據程度 | 建議優先度 |
|---|---|---|---|
| R-01 | outbox 已確認操作可以被舊分頁重新帶回；stored tombstone 沒有參與下次排除 | 純函式重現 | P1 |
| R-02 | 同一操作的新內容在合併時被舊內容壓過，與註解聲稱的 incoming wins 不符 | 純函式重現 | P1 |
| D-01 | 後端有 revision 欄位與檢查，但目前 SPA 未送 base_revision；檢查和寫入也未在同一原子條件內 | 程式碼確認；併發交錯待 E2E | P1 |
| F-01 | 密碼復原介面與 token 已存在，但寄送函式只 print；復原連結也進入日誌 | 程式碼確認 | P1 |
| F-02 | 保留原 cookie 的隔離客戶端，session 閒置 31 天仍被認為已登入 | API 重現 | P1 |
| R-05 | 收據可清理到 90 天，但所聲稱的 30 天離線重播上限未在 outbox／sync 路徑實施 | 程式碼確認；啟用清理後有風險 | P1，啟用清理前 |
| D-02 | 相同 FEN 的互相矛盾評分提交成功，最後一筆覆蓋前一筆 | API 重現，200 並存入 999 cp | P2 |
| A-01 | 混合訓練的全域大小限制會被逐 repertoire 向上取整突破 | 服務重現，要求 12、產生 14 題 | P2 |
| R-04 | 訓練拒絕組同時保存在 rejected 和 durable pending，重載後可能反覆送出及反覆通知 | 呼叫鏈程式碼確認 | P2 |
| U-02／V-03 | 手機進行中仍展示模式與組成統計，通知占用下方操作及結果空間 | 本次截圖 | P2 |
| E-01 | Settings smoke 仍尋找已整合進 Account 的 Connections 導覽，整套 UI gate 8／9 | 兩次一致失敗＋新版 DOM／成功 States 對照 | P2 |

P1 表示涉及資料承諾、帳號可用性或明確保護邊界，適合先排入工作；P2 表示重要正確性、主要任務效率或驗收缺口；P3 表示可按實際用量改善。優先度不是正式事故判定，也不是每項都必須立刻上線的指令。

## 2. 檢查方法與證據邊界

### 2.1 本次完成的檢查

由 `docs/README.md`、架構文件、目前 source、API、repository、訓練／Scout 模組及既有測試開始；舊報告只用作待核對線索。工作目錄有未提交變更，且檢查期間部分文件狀態也有變動，因此本報告是目前工作副本的觀察，不是只對 HEAD 的判斷。

| 檢查 | 本次結果 | 可證明的範圍 |
|---|---|---|
| `npm test -- --reporter=dot` | 110 個檔案、1,655 個測試通過 | 預設前端測試的現有斷言 |
| `.venv/Scripts/python.exe -m pytest -q` | 687 passed、12 skipped、5 deselected；約 113 秒 | 預設後端測試；略過／排除不算通過 |
| `npm run lint:js -- --quiet` | 通過 | 指令要求的 ESLint error 檢查，沒有宣稱全部 warning 為零 |
| `.venv/Scripts/python.exe -m ruff check src tests` | 通過 | Python 靜態規則 |
| `npm run smoke:ui-v2` | 8／9 通過，Settings 失敗 | 目前 static bundle 搭配 fixtures 的跨 viewport／互動 |
| Settings 單獨重跑 | 同一 Connections locator timeout | 不是一次性的時序成功／失敗差異 |
| 額外截圖 | 共 31 張，Library、Train、Scout、Analyze、Settings | 1440×900、1180×900、390×844；Settings 只到失敗前桌面畫面 |
| outbox／checkpoint／色彩探針 | 已完成，結果見附件 | 記憶體假儲存與純函式，不碰真正瀏覽器儲存 |
| API／服務探針 | 已完成 | 臨時 SQLite；相同 FEN、session 過期及混合題數 |

Python 有 Starlette TestClient／httpx deprecation warning。它是測試工具維護訊號，本次不把它當產品故障。未重跑 research／archive tests，也沒有把歷史研究期望值當成目前產品要求。

### 2.2 尚未驗證的事情

未連接正式 PostgreSQL、Render、郵件服務、Stripe 或真實 OAuth 帳號；未量測正式帳號的資料量、SQL 執行計畫、負載及 p95。未重新建置產品 bundle，避免變更既有 static 產物；UI 檢查服務現有 static 檔案，source 檢查則針對現在的原始碼，兩者不宣稱已逐位元對應。

未完成 Safari／iOS、真實低階手機、完整 axe、螢幕閱讀器、200%／400% 縮放與軟鍵盤驗證。截圖可看出版面安排，不能單獨證明真實使用者完成任務的時間。跨分頁 read–modify–write 的競態是結構性風險，未在兩個真實分頁同時排程到特定交錯順序。

### 2.3 已存在的改善，應保留而非重新列為缺功能

| 能力 | 目前確認到的實作 | 還需注意 |
|---|---|---|
| Build 錯誤分類 | auth／CSRF／rate limit 等保留草稿；invalid batch 逐項隔離 | 合併、重播、拒絕資料的完整生命週期 |
| 本地待同步佇列 | owner-scoped localStorage、Build temp ID、Train UUID | 跨分頁、容量、期限與 UI 管理 |
| 登出協調 | 登出前保存／flush，pending 另有提示，logout 失敗不直接 reload | 有些結果只存本機時，文案與真實可恢復性 |
| 分享控制 | enabled／revision／expiry、rotate／revoke endpoint | 使用者理解公開連結、團隊與副本三種語意 |
| 帳號資料 | Account 畫面、資料匯出與刪帳號流程；刪除 Core／ORM 已同交易 | 大帳號匯出、本機副本清理 |
| 密碼復原 | forgot／reset UI、限流、單次 token、更新密碼後撤銷 session | 真正寄信尚未接好 |
| 分析驗證 | score、depth、nodes、mate、UCI／PV 型式與數量邊界 | 相同原始 FEN 重複提交及資料語意 |
| 分析說明 | generated_comment 和原註解分開，再分析替換產生內容 | 過去資料與來源／版本呈現 |
| 分析品質 | target／actual depth、quality／algorithm metadata | 使用者能否容易理解部分完成 |
| 訓練統計 | mastery-v2、effective children、列表 live due SQL | 快取整體一致性、SQL／Python 規則分歧 |
| 歷史清單 | owner-scoped ranking、固定頁數與 keyset cursor | 大帳號實際 query plan |
| Scout 多來源 | 每來源 watermark／outcome，partial 提示及 retry 設計 | 驗證長串流與 resumed 狀態 |
| 分析恢復與跨模組 | checkpoint、Retry save、handoff context／return state | 容量回收、上下文 owner 邊界及恢復清單 |

## 3. 資料保存與前後端同步

### R-01｜P1｜已完成操作在下一次 outbox 合併中復活

**現況。** `sync-outbox.js:164` 的 `done` 只讀這次傳入的 `settled`，沒有把 `base.settled` 一起納入。stored tombstone 確實被保存到輸出，但下次合併不使用它來排除 pending。

**重現。** 先保存 tmp-1，再以 settled=tmp-1 確認；此時 pending=0、stored tombstone=[tmp-1]。接著讓持有舊快照的分頁合併 tmp-1，pending 回到 1。結果保存在 `outbox-probe-result.json`。

**影響。** 最直接的是多餘重送、錯誤的 unsaved 狀態及重複通知。Train 的 server receipt 能擋住多數重複計分，但不等於 durable queue 行為正確；Build 的內容去重也不應代替操作確認。如果節點之後被刪，舊新增重播的效果還需獨立確認。

**建議。** settled identity 必須參與後續合併規則；定義 tombstone 保留與其他分頁草稿年齡的關係。不能假定所有 stale snapshot 都只有幾秒，分頁可休眠數小時。`clearOutboxWhenQuiescent()` 直接移除 key，也會失去 tombstone，因此要一起驗證。

**驗收。** A 確認後 B 寫回舊 queue、A 清空後 B 恢復、休眠一天再回前景、超過 200 個確認記錄等情境，都不會重新變成未確認工作。收據與 client queue 各自應有測試。

### R-02｜P1｜相同操作的舊內容優先，更新無法可靠保存

**現況。** `mergeById()` 先把 base 放入結果，再忽略相同 ID 的 incoming；但 `mergeOutboxState()` 的註解說 incoming wins。探針把同一 tmp ID 的 parentRef 從 tmp-parent 改為 real-parent，合併後仍是 tmp-parent。

**影響。** 在前一批新增已回覆 ID map、後續操作修改 parentRef 或 node 狀態時，durable copy 可能保留較早內容。部分路徑可用 idMap 補救，不代表每個欄位都能由 idMap 重建。這會造成「現在畫面能操作，但重整後狀態不同」的風險。

**建議。** 分清操作本身不可變的 identity，以及可更新的序列化狀態。相同操作到底採最新內容、合併欄位或禁止 mutation，需要真正一致的規則；不要只改註解。最好讓操作保留原輸入、由 dependency／idMap 決定送出參數，避免同一資料有兩套真相。

**驗收。** 確認 parent → 更新 pending child → 保存 → 重整，child 仍接在正確 parent；同 UUID 的訓練 payload 不能被隨意改成不同結果。

### R-03｜P2｜localStorage 合併與跨分頁 lock 不是原子操作

**證據。** `saveOutbox()` 是 get → merge → set；`acquireFlushLock()` 也是 get → 判斷 → set。沒有跨 context 的 compare-and-set。兩分頁都可能先讀到同一份舊資料，再互相覆蓋；兩邊也可能都取得「成功」結果。30 秒 stale lock 沒有 lease 續期，慢網路請求可能超過期限。Train flush 沒有使用這個 Build lock。

**影響。** 去重只能處理兩次收到相同操作，不能找回「最後一次 set 把另一分頁剛新增的操作覆蓋掉」的資料。註解稱一個 flusher 並不是完整安全證明。

**建議。** 先把跨分頁 correctness 建立在 transactional store／適合的 lock 與 server idempotency，通知協調則另用 storage event 或 BroadcastChannel。選擇實作前需確認瀏覽器支援與降級方式；不要只因這份報告就加大型同步框架。

**驗收。** 兩分頁同時新增不同 op，結果是聯集；同時 flush、請求超過 30 秒、持鎖分頁 crash，都能恢復。多帳號 lock／queue 狀態互不影響。

### R-04｜P2｜Train 永久拒絕組沒有完整退出 durable pending

**證據。** `flushTrainSync()` 的 `unsettled` 同時包含 failed 和 rejected attempts，`settledAttempts` 因而不包含 rejected。rejected 另存 `trainRejected`，卻沒有明確從已保存的 pending 移除；而 outbox merge 採聯集，不能用空 pending 表示刪除。相較之下，Build isolation 把 rejected 也加入 settled。

**影響。** 重載可能既顯示「保留供檢查」，又自動把同組再送出去；不存在的 session 或 malformed payload 反覆失敗。現有 `rejectedCount` 通知已修掉混合失敗漏報，但生命週期仍不完整。

**建議。** 每個 UUID 有單一狀態：pending、in-flight、acknowledged、needs-action／rejected。移到 needs-action 應退出 auto retry queue；保留原資料與原因，供使用者處理。

**驗收。** 422＋503 混合 flush → 重整，只重送 503 那組；422 那組可查、可匯出、不反覆計入 pending。下一次成功也不應抹掉仍存在的拒絕提示。

### R-05｜P1（清理前）｜離線重播期限和 receipt 保留契約沒有接上

**證據。** `data_lifecycle.py` 宣告 OFFLINE_RETRY_DAYS=30、RECEIPT_RETENTION_DAYS=90，並在註解聲稱 SPA 最多重播 30 天。現在 outbox entry／SmartSyncAttempt 沒有建立時間欄位；restore／sync 也沒有 30 天年齡檢查。receipt 清理則可按 90 天刪除。

**影響。** 若管理者啟用 receipt cleanup，超過 90 天的舊裝置可能再送已計分 UUID；收據已不存在時，若原 session 和 node 還在，可能再次計分。這是「有清理功能且被啟用後」的風險，本次沒有刪任何收據，也沒有證明正式環境已執行清理。

**建議。** 將重播期限定成實際協定，或保留足以永久辨認已確認操作的摘要。僅依不可信任的客戶端時間拒絕也不充分；需定義 session 世代、server 接受窗口及過期草稿如何匯出。未建立這個契約前，先維持收據安全保留。

**驗收。** 超過 30／90 天重播、裝置時鐘錯誤、清理前後相同 UUID、長期未結束 session 都不重複計分；到期資料有可理解的處理選項。

### R-06｜P2｜已保存拒絕資料缺少完整的使用者處理入口

**證據。** 現有 code 保留 `buildRejected`／`trainRejected`，恢復後能通知，但本次盤點沒有找到完整的逐項檢查、重新指定位置、匯出及已處理清除介面。rejected tail 只保留最近 100 筆；idMap 則沒有對應的明確回收。

**影響。** 「kept for review」若沒有 review 的地方，使用者無法判斷哪條走法或哪次訓練出問題。超過上限的舊拒絕資料會被截掉，與永不丟棄的文案也不一致。

**建議。** 做小型儲存狀態面板，按 repertoire／session 列出待同步與需處理工作、原因、最舊時間及具體動作。不要預設把整份技術 JSON 給使用者；提供走法／日期／來源即可。限制資料量前先提供匯出或可見的清理政策。

**驗收。** 使用者能找出那一筆錯誤並完成處理；處理後 pending／rejected／badge 都一致；100 筆邊界不会無聲遺失。

### R-07｜P2｜訓練 session 的位置與日期尚未完整持久化

**證據。** outbox snapshot 保存 attempts，未保存 current card_index、local queue、dirty position 的 session 快照；這些資料只在 flush 時從 `appState.smart` 組 payload。每筆 attempt 也未帶 performed_at／當時 local_date，flush 使用當下日期，`record_attempt()` 使用收到請求時的 server now。

**影響。** 沒有 graded attempt 的跳題／requeue／位置前進，在 response 未到或突然關閉時可能無法恢復；午夜前離線練習、午夜後送出，streak 記錄日期與使用者實際練習日期可能不同。延遲一天以上也會使 due_at 從送達時開始算。

**建議。** 讓 session progress 和 graded attempt 分別有持久化資料；定義學習事件時間、收到時間、使用者時區的用途。紀錄時間不是讓客戶端任意修改歷史，而是要有合理的可接受窗口。

**驗收。** 只有 skip／位置改變後重整可恢復；23:59 離線作答於隔日同步仍按定義記錄；跨時區與裝置時間不準有固定處理方式。

### R-08｜P2｜checkpoint 的數量上限只限制索引，不回收內容

**重現。** `analyze-checkpoint.js:52` 的 writeIndex 只留下最新 50 個 ID，沒有刪除被排除的 checkpoint body。記憶體 localStorage 探針寫 51 份後：index=50，body=51。

**影響。** 舊 body 不再出現在一般清單，卻持續占用 quota。單份 MAX_CHARS=4,000,000 是字元限制，不是整個 origin 的儲存預算，也不能保證瀏覽器能保存。同步 JSON.stringify／setItem 在大分析下還可能影響主執行緒；本次未量測實際卡頓。

**建議。** index evict 和 body delete 有一致規則；設定總容量、已確認／可重算內容的優先回收，以及多份未保存結果的可見清單。大資料是否轉 IndexedDB，依容量及主執行緒量測決定。

**驗收。** 第 51 份後 body 不成無索引垃圾；quota fail 時提示只在記憶體，不假稱重整可恢復；刪除帳號／清理本機資料涵蓋這些 key。

## 4. 資料庫與 API 互動

### D-01｜P1｜revision 需要成為真正的前後端寫入契約

**證據。** workspace router 支援 `base_revision`，repository 會 bump revision；但目前 `web-src/app.js`／`views/build.js` 找不到送出 base_revision 的實作，Build add-moves／delete-nodes 的 payload 也未帶它。因此正常 UI 的寫入仍走「省略欄位就允許」相容路徑。

另外 `_check_base_revision(meta, value)` 在 route 先讀 meta、檢查，後續 service 再開 transaction 寫入。即使 caller 補送欄位，A／B 都讀到 revision=r 並通過檢查，仍可能先後寫入。這是檢查和使用間的競態，不能只靠 bump 解決。

**建議。** 全部需要衝突保護的 UI mutation 明確帶 revision，server 在同一 transaction 內比較和寫入，例如條件更新／合適的鎖定。新增可合併、同欄位修改、父節點刪除及生成計畫要各自定義；不要把每次新增都變成必須人工決定的衝突。

**驗收。** 同時修改註解不靜默覆蓋；刪 parent 後另一頁新增保留本地草稿；過期生成錨點有明確衝突；非衝突新增可以安全合併。回傳 revision 必須與實際 payload 同版。

### D-02｜P2｜相同原始 FEN 的矛盾資料先被 dict 覆寫

**重現。** positions 內同一 FEN 先傳 score_cp=20，再傳 999，後續其他局面有效。classify-save 回 200，讀回第一步 eval_before=999。

**根因。** router 以 `position_map[item['fen']] = item` 建 dict，完全相同字串的 duplicate 已在此處覆寫。service 的 normalized duplicate 檢查只看留下來的 dict；它能檢查兩種不同拼法，不能找回已覆寫項目。

**建議。** 在保留 list 的階段做 identity／重複一致性檢查，再建立 map。相同內容可去重，互相矛盾內容應拒絕；FEN normalization 的 identity 也要和 engine 資料用途一致。

**驗收。** 相同／不同拼法 FEN 都適用；20＋999 回可理解 4xx 且不寫入；相同內容重復可接受。測試不要只測 normalization 後不同字串。

### D-03｜P3｜分析結果仍重複儲存

**證據。** analyze route 在 save_game_batched(game,result) 後，又呼叫 save_analysis_result(result)；前者的批次 move save 已 upsert analysis_results。現有 timing 也為兩個階段分開計時。

**影響。** 多一次 transaction／往返；第二步出錯可能讓 API 報失敗，但第一步已成功。這不代表第一筆分析沒有原子性，而是成功／失敗的回應語意變複雜。

**建議。** 先對照兩條 path 的欄位和用途，再由單一責任入口存完。若需要多個分析版本，應有明確 run identity；Retry save 不應意外建立一份使用者以為不同的新分析。

**驗收。** 每次分類只做必要一次分析 record 儲存；response lost 後可確認結果存在，重試不產生不必要歷史。

### D-04｜P2｜training sync 的每筆交易與整批回應需要相容

**證據。** `sync_progress()` 在 attempts loop 裡逐筆 `engine.begin()`，每筆 receipt／progress／session 同交易；整批卻只回 `{synced: written}`。遇後面一筆 UUID payload conflict，之前合法那筆可能已提交，route 再回 409。節點不存在時則直接 continue，沒有逐項 outcome。

**影響。** client 只能把全組當作成功或失敗。重試有 receipt 保護，卻不能讓使用者知道哪筆已存、哪筆因刪 node 略過；409 的永久 UUID collision 也不等於 reload tree 能解決的 revision conflict。對不存在節點回 200，可能顯示 Saved 卻沒有記錄該次答題。

**建議。** 選擇全批預驗證＋atomic commit，或清楚逐 UUID outcome；需要分 chunk 的長佇列可延用後者。明確區分 duplicated、applied、skipped_deleted、rejected_conflict，避免所有 409 一律自動重試。

**驗收。** 第一筆成功＋第二筆 collision、node 被刪、超過 MAX_SYNC_ATTEMPTS=500、回應中斷後重試，都能得出完整且穩定結果。長離線 queue 應按上限分批，不把合法工作全組隔離。

### D-05｜P2｜live due 和 cached health 的整體語意要一致

**證據。** 列表不再只讀 stale due；已用 owner-scoped recursive CTE 重算有效可訓練 due，這是改善。可是只替換 cached health 的 due，mastered／learning 等其餘欄位仍是舊快取。`node_mastery()` 先判斷 due 再 mastered，所以跨過 due_at 時，一個節點會從 mastered 移到 due，而列表可能仍保留舊 mastered。

**影響。** 若 UI 把這幾個數字當互斥分類，總和可能大於 trainable；mastery_pct 也可能與最新狀態不同。也可能產品想讓 due 與 mastered 重疊，那就不應用同一套互斥 heatmap 語意。本次確認結構與計算邏輯，沒有把它寫成已在正式帳號看到的數字故障。

**建議。** 對「精熟程度」與「複習到期」分成獨立軸，或保持全組互斥、一起刷新時間相關分類。增加 computed_at、tree revision、progress revision；維持列表輕量，不因一致性而載入每棵完整樹。

**驗收。** 固定時鐘跨 due_at 前後，列表／Dashboard／Train 對數字定義一致；SQL 和 Python 對 weak／due／有效祖先的判定有差異測試，不只是各自測一遍。

### D-06｜P2／P3｜以實際 query plan 決定大帳號最佳化

**現況。** analyzed history 已有 owner scope、ROW_NUMBER tie-break 和 cursor，不能再說沒有分頁。repertoire listing 仍一次 `.all()`；live due 會 traverse owner 的樹；account export 載入全部 games／repertoires，再重建 PGN／package 成單一 JSON。user_settings.value_json 仍是 String(4000)。

**建議。** 分別量測列表、完整樹、訓練 start、分析 save、匯出。對 1k／10k games、100／500 repertoires、500／2k／10k nodes 記錄 statement 數、plan、payload、時間及記憶體。大匯出可串流或有可恢復的背景工作；設定 key 應盤點最大 encoded 長度，成長型資料另定容量策略。

**驗收。** PostgreSQL 與 SQLite 不同限制有測試，4000 字邊界回可理解錯誤；先看 plan 再加 index；cursor 更新／同時間值不漏記錄。這是待量測改善，沒有證據說現有正式 DB 已慢。

## 5. 演算法、排程與分析結果

### A-01｜P2｜混合訓練預算必須在全域兌現

**重現。** 建立七個各有兩個 due move 的 active repertoire，呼叫 mixed session_size=12／new_cap=3；實際 line_order 有 14 張卡。這次測試各卡只有一個 target，因此不是 card／target 單位差異。

**根因。** per_size=max(2,ceil(total_size/repertoire_count))，逐 repertoire 建 plan 後全部 mix，沒有全域再分配／截斷。per_new=max(1,ceil(total_new/count)) 同樣可能讓新題超過全域 cap。

**影響。** repertoire 越多，短 session 越容易變長；每天可投入五分鐘的使用者可能被安排超額。每棵樹先分固定額度，還可能讓較不急迫 repertoire 和大量逾期者分到相近份額。

**建議。** 明確 session_size 是 target 還是 card；先用全域 urgency 分配有限 budget，再保留適度 repertoire 切換與新題額度。數量控制和排序多樣性分開處理。

**驗收。** 1／3／7／20 repertoire，部分空樹、全部 due、全部 new、極不平均進度，都不超過全域 size／new cap；UI 預估時長能反映合併 target 數。

### A-02｜P2｜SRS 雖已一致，仍可更接近真正的長期記憶

**現況。** 正確加一、錯誤減半，score 上限 10；正確間隔約 score 天，因此最長約 10 天；錯誤後 10 分鐘到期。近期恢復不再被終身正確率永久壓低，這項改善應保留。

**限制。** 連續十分鐘內答對多次、隔數天仍答對，目前對 score 的貢獻相近；反應時間、提示／揭答、實際 retention gap 沒有成為完整評分訊號。熟悉的資料長期仍每 10 天複習，可能占用太多時間。這是演算法適用性限制，不是「一定應換成某個現成模型」。

**建議。** 先記錄 elapsed interval、是否提示、首次成功與 requeue 結果，再分析 retention 與每日負荷。排程改版要保留算法版本及舊進度映射，採 shadow comparison／小規模使用者觀察，避免一次重設所有到期日。

**驗收。** 長間隔成功可更合理延長；重複抄答不虛增精熟；初學者不被弱項困住；同時量測次日／一週首次正確率及每週需複習題數。

### A-03｜P2｜Scout 的歷史證據和預測信心應分開呈現

**現況。** production scoring version=9、scout-v2；使用 observed route、對手決策條件次數、共享前綴去重的 DP，最多每色 12 條。Maia 最多兩個 pseudo-games 用於葉節點 opportunity，不拿來捏造對手 reach；這個邊界合理。experimental v13 是可達 runtime，不是已全面移除的 archive。

**限制。** conditionalReach 是頻率乘積，不是校準過的未來機率；完整棋局 W/D/L 涉及開局後的失誤、實力及配對因素，不能直接等同該線在開局就有問題。截圖中 5～8 局的 80%／33% 比大語氣敘述更需要樣本脈絡。

**建議。** 首屏顯示「過去 N 局中出現」「引擎發現可利用機會」「你的準備缺口」，各自說清楚；對小樣本使用低信心文字／區間及 last seen，避免精確百分比製造確定感。弱點與比較值要說明母群、棋色、速度及時間窗。

**驗收。** 使用者能分辨歷史勝率和開局評價；一局弱點不会用強結論；重新選速度後分母、route support、baseline 同步。算法正確的 DP 不等於預測品質已驗證。

### A-04｜P2／P3｜以時間外驗證與穩定性量測評估 Scout

**現況。** production utility 不直接以 recency、clock、game length 排序；前置 engine 候選上限 300／色、depth=8、concurrency=3，預設 time budget=Infinity，但候選數量仍有限，不能稱無限工作量。

**建議。** 用過去資料選推薦，拿之後的對局檢查實際遇到的對手決策覆盖，避免訓練／評估重用同批局。比較短期／長期窗口、候選上限與 depth 的 tradeoff；以新增 1／5／20 局後的推薦變動觀察穩定性。不同速度、rating、樣本量應分組。

**驗收。** 報告 coverage、推薦穩定度、引擎花費與 missing reads；若近期權重有收益才納入。不要只為讓畫面推薦看起來更長或更多樣而改 selection objective，也不要恢復已淘汰的 quota。

### A-05｜P2｜分類與解說要清楚表達運算品質及局面語意

**現況。** generated_comment 分離、actual depth、quality／version 已存在；其價值取決於使用者是否看得到「部分淺搜」「Maia 未完成」「重試只保存」。數字型式驗證不等於評分和 PV 的棋類語意完全正確。

**建議。** 檢查 cp／mate 的視角、終局 depth=0、repetition／50-move 規則、不同 history 下相同棋盤、PV 第一手和合法性；先定義哪些資料會影響分類。對 engine／model downgrade 顯示局部狀態與版本，説明較淺結果可做快速回顧、關鍵位置可加深。

**驗收。** 白黑方 cp 符號、mate、promotion、terminal、重複局面都有一致測試；server source metadata 不使使用者誤以為伺服器重新驗算了瀏覽器評分。coach 有證據時講具體計畫，缺證據時不生成假戰術理由。

## 6. UI 與資訊架構

### U-01｜P2｜每個頁面選一個最重要的下一步

**觀察。** Library 同時有 Train、Import PGN、New repertoire、onboarding 及多個統計。它已比複雜儀表板清楚，但若目標是每天準備，重要的是「今天複習什麼」。Scout 同時有 Resume、Reset、Deep scan、Add all gaps、Analyze、Add to prep；操作各有用途，卻需要使用者先推導順序。

**建議。** 以狀態決定主動作：有 due 就開始短複習；空 Library 就建立第一份 repertoire；Scout 有結果就準備一條最重要的線；已補進準備就練習。其他功能保持可見的次要入口，避免靠移除功能假裝簡化。

**驗收。** 新使用者在 10～30 秒內說出這頁目前要做什麼；每個主要按鈕附近有動作結果。首次準備、日常複習、比賽前偵察分別做任務觀察。

![Library 桌面現況](review-assets/2026-09-30-current/library-current-desktop-1440.png)

### U-02｜P2｜手機訓練進行中應以棋盤、題目與必要操作為核心

**截圖。** 390×844 畫面上半是棋盤，下方 Your move、三種模式、Card 進度、queue 色條、四種 legend；通知與固定底部導覽在下方。必要操作接近可視區邊界，模式切換還會取得顯著藍框焦點。

**建議。** setup 保留模式選擇；active 收成一行 mode／session 選單，棋盤後直接一句題目與 Hint／Next。queue 組成放可展開摘要，完整統計放結束頁。不要過度縮小棋盤換出一排儀表。

**驗收。** 360×640、390×844、橫向與鍵盤開啟下，完成一題不必反覆找下一步；模式切換清楚告知本次如何保留；既有快捷鍵仍正常。

![手機訓練現況](review-assets/2026-09-30-current/train-active-current-mobile-390.png)

### U-03｜P2｜Scout 先呈現準備計畫，完整統計作證據層

**觀察。** 新版已有 Expect／Predictable until／Style 等摘要，比舊版的多區塊報告集中。但 route table、歷史 score、coverage、缺口、主線／弱點標籤與右側棋盤仍同時競爭。手機所檢視截圖停留在路線列表後半及 Line detail，表明長單欄往返是主要成本。

**建議。** 預設顯示三個可行的準備重點，每項只有路線、樣本脈絡、缺什麼和一個主動作；其餘 route 可展開。手機點 row 後就近顯示棋盤及 action，附「返回路線」；避免一定要捲到列表末端才看到詳情。Add all gaps 應有目標樹與預覽，避免一次造成訓練負債。

**驗收。** 30 秒內回答最常遇到的線、自己的準備缺口和下一步；選中第二條線後無需搜尋遠處 detail；資深使用者仍能追到來源對局及公式。

![Scout 桌面現況](review-assets/2026-09-30-current/scout-report-white-current-desktop-1440.png)

### U-04｜P2｜走法樹的選取應保留鍵盤焦點與局部狀態

**證據。** `selectBuildNode()` 每次選取都 `renderBuilderTree()`；view 重新建立 tree HTML 並取代 innerHTML，每個 move button 分別綁 listener；shared renderer 點擊後無條件 blur。大樹選取成本增加且 focus 可能回到 body。

**建議。** 先將單純 current/path 更新變成局部 class 更新，結構改變才重渲染；採事件委派並保留 focus、scroll、展開狀態。滑鼠點击與鍵盤 Enter 不應都 blur。是否 virtualization 由大樹量測決定。

**驗收。** 500／2,000／10,000 節點量測選取／增刪；連按 Enter、箭頭或 Tab 不掉焦點；新增後看得到新線，刪除後回合理父節點。

### U-05｜P2／P3｜狀態、名稱和導覽應以使用者看到的功能為準

**證據。** command palette 主頁名已一致，但 repertoire hint 仍寫 Open in Build。共用 sync chip 的 rejected 文案為 Some attempts couldn't be saved，放在 Build 的編輯情境不夠準確；network／server chip 多數仍標 Offline。`setStatus()` 接收 options object，但某同步呼叫傳字串 warning／info，該處 severity 會回預設。

**建議。** 建立短動詞與狀態文案表：開始訓練、加入準備、重試儲存、重新登入、處理衝突。以用途決定 edit／attempt 名稱及下一步；舊 Build 作搜尋 alias，畫面統一 Repertoire。若有繁中市場再规劃在地化，不因使用者用中文就假定產品必須全面翻譯。

**驗收。** 搜尋頁面可見名字能找到；保存／只在本機／等待登入／需處理不混淆；關鍵失敗有持續入口，不只短暫 toast。

## 7. 視覺效果與可讀性

### V-01｜P2｜棋盤座標對比仍偏低

**計算。** 依現在 CSS token 計算亮度比：light theme 3.19:1（light square）、2.15:1（dark square）；dark theme 3.03:1、2.93:1。這是 token 配對的數值，不是整頁 axe 掃描結果。座標本身小且常用來定位，低對比有實際閱讀成本。

**建議。** 為兩種格色提供更清楚的座標，必要時採外框座標或微底色，讓數字不和棋子競爭。產品內部可把一般小文字 ≥4.5:1 作驗收目標；本次沒有宣稱整頁符合或不符合某標準認證。

**驗收。** light／dark、白黑方向、不同棋盤尺寸、promotion、highlight 下均可辨識；測棋子輪廓和移動高亮，不只背景 token。

### V-02｜P2／P3｜保留簡潔配色，調整小字及過密輔助資訊

**觀察。** 現有藍色主動作、灰色表面與黃色提示一致，沒有必要為視覺效果增加大量漸層。CSS 有 9.5／10／10.5／11px 小字；Scout 的 last played、sample、結果分布等一起出現，輔助資訊在手機更難掃讀。

**建議。** 優先提升關鍵樣本／錯誤／下一步到易讀字級；非必要 metadata 可展開，不只是加深所有文字。數字使用穩定寬度；移動樹 SAN 和統計用適合字型，標籤大小與間距統一。

**驗收。** 100%／200% 放大能掃到重點；長玩家名、長 repertoire 名、棋譜註釋不破版；主動作與一般 row 的視覺權重有別。

### V-03｜P2｜通知層要避開手機操作與 modal 任務

**證據。** CSS z-toast=1200 高於 z-overlay=1000；本次 Train 截圖 queue ready 通知在動作區附近，Analyze 完成截圖同時有底部狀態和 Analysis ready 卡，占據結果下方及導覽空間。通知顯示在截圖時點，未用點擊探針證明它一定擋住某特定按鈕。

**建議。** 成功通知以短 inline 狀態／不攔截點擊的區域顯示；重要失敗留可恢復卡。modal 開啟時全域通知不要搶互動與焦點；一次只保留最相關任務訊息，手機保留 bottom nav 和 safe area 空間。

**驗收。** 完成分析後能立即操作棋盤／結果；modal＋toast＋鍵盤同時出現仍能確認／取消；通知不覆寫較重要的錯誤狀態。

![手機分析完成的通知位置](review-assets/2026-09-30-current/analyze-results-current-mobile-390.png)

### V-04｜P2／P3｜用少量有意義的視覺反馈取代多個同時跳動狀態

**現況。** 主題、focus-visible、部分 reduced-motion 已存在。接下來應检查棋子移動、progress toast、confetti、hover-expand rail 是否都遵循相同規則；本次未逐一跑 reduced-motion／screen reader。

**建議。** 題目正誤以局部文字＋圖示＋色彩，不能只靠紅綠；只在達成有意義 session 結果時慶祝。第一個操作前導覽名稱要容易發現，hover rail 可保留，但 keyboard／觸控入口須同等清楚。載入 placeholder 應維持容器尺寸以減少版面跳動。

**驗收。** reduced-motion 下可完整完成任務；色覺差異仍能看懂 heatmap 和 W/D/L；以低速網路測懶載入、模型 loading 及 row 更新的位移。

## 8. 功能設計與帳號體驗

### F-01｜P1｜密碼復原必須完成實際寄送，不能只顯示已寄出

**證據。** auth.py `_deliver_mail()` 只有 print，包含 user.email、subject、完整 body；forgot route 建立 token 後以 `/?reset_password=<raw>` 組 relative link，回 `{status:'sent'}`。production 沒有特殊寄信分支，只有 dev token 回傳被關閉。

**影響。** 用目前 repo 直接部署，使用者按 Forgot password 看見寄送文案，卻收不到電子郵件。raw reset token 也進 server logs；在有效期限內，能讀到這個 token 的人可能使用復原流程。這是 code 能確認的行為，沒有推測正式環境的日誌讀取權限或是否另外接了 mailer。

**建議。** 接真正的 delivery adapter／queue，使用配置的公開 origin 組完整 URL；只記非敏感 delivery identity、狀態與錯誤，不記 token 或整封 body。寄送失敗可重試，對外仍維持不洩漏帳號是否存在的回應。

**驗收。** staging 郵件實际可收、可點、一次有效、到期失效；mailer 故障有可觀察與補送機制；OAuth-only 的回復也能送達；日誌不含 reset token。

### F-02｜P1｜session 期限應由伺服器驗證，而非只靠 cookie 到期

**重現。** 登入後把 AuthSession.last_seen_at 設為 31 天前，保留 client 現有 cookie，再 GET /api/auth/me；回 200 且仍有原 owner ID。設定 session_ttl_days 預設 30。

**根因。** `current_user_optional()` 找到 row 後更新 last_seen_at，沒有先檢查 idle expiry。`_purge_expired()` 在建立 session 的路徑清理，不是每次驗證的保護。一般瀏覽器 cookie 到期通常不送出，但手動保留／重送 cookie 的客戶端仍可觸發此路径。

**建議。** 認證依賴先驗證 server-side expiry，之後才刷新 last_seen；定義 absolute lifetime 與 idle lifetime 是否需要共存。登出所有裝置、密碼復原及刪帳號繼續保持一致。

**驗收。** 邊界 29／30／31 天、naive／aware datetime、保留 expired cookie、首次請求不会復活過期 row；未過期正常工作和 offline outbox 恢復都不受影響。

### F-03｜P2｜分享與副本控制要在 UI 說清楚

**現況。** 分享撤銷、旋轉及到期已實現；public read 清掉 owner 的 health／mastery；fork 為獨立副本。這些不是缺功能。

**建議。** 分享面板分三個簡短區域：公開連結狀態、團隊可讀範圍、別人已複製的副本。說明撤銷影響原连結，不能刪除別人的獨立副本；Copy link 旁顯示啟用／到期狀態。rotate 是使舊連結失效，應有清楚結果。

**驗收。** private／team／public、撤銷後再建立、到期、移出團隊、已 fork 都有 UI 行為；共享閲讀不洩漏私人训練信號。

### F-04｜P2／P3｜帳號刪除與資料匯出應包含本機保存的使用者工作

**現況。** server 刪帳號已將 domain／identity 放同交易；Account UI 有 export 和 DELETE 確認。然而 deleteAccount() 成功後只通知及 reload，本次未找到清理 owner outbox／analyze checkpoint 的對應動作。

**影響。** 本機分析和草稿可能留在共用裝置，且 owner key 未來不再可登入。owner scope 是產品 UI 隔離，不是本機加密。server export 也不必然包含还未同步的 device-only 工作。

**建議。** 刪帳號前說明保存／匯出 pending 工作的選擇，完成後清除對應 owner 的本機資料。另提供「清除此裝置資料」和「匯出未同步工作」，與登出保留草稿的設計區分。不要在普通登出時一律刪掉草稿。

**驗收。** 刪帳號後該 owner 的 outbox／checkpoint／索引消失；其他 owner 不受影響；離線且需匯出時能保留選項；server 大帳號匯出有容量及效能保障。

### F-05｜P2｜把模型與引擎設定轉為任務選擇

**觀察。** Settings 目前有 Engine、Maia3、Playing strength；截圖同時顯示 Browser only、available、Cache missing、fp16 和深度滑桿。专业使用者能理解，初學者需要額外推導「要不要下載、這個會改善什麼」。

**建議。** 先說功能效果：快速回顧、深入關鍵位置、人類風格對手。細節可展開，首次需要 Maia 時說明下載量／能否繼續／取消後結果。Cache missing 且功能關閉時用中性的「尚未下載」，避免看起來像錯誤。保留手動深度和 rating。

**驗收。** 冷 cache、已有 cache、離線、下載失敗、模型關閉及 worker crash 都有清楚行動；低階裝置能選較輕模式，而不是被迫啟用所有引擎。

![Settings 目前的 Account 與引擎設定](review-assets/2026-09-30-current/settings-top-current-desktop-1440.png)

## 9. 使用者體驗簡潔化：建議流程

### 9.1 第一次使用

先讓使用者完成一個有成果的小任務：建立／匯入一條準備線 → 試練三題 → 看懂已保存及下一次複習。Lichess 連結有價值，但若使用者有 PGN，不應因沒連結就覺得 onboarding 無法完成。完整 coach／模型設定先維持合理預設。

建議觀察：第一次成功練習所需時間、未完成離開的步驟、誤點及返回次數。onboarding 的 Done 應對應真正事件，且每日熟練使用者可以收起。

### 9.2 日常複習

Library 首屏用「今天有 X 題，約 Y 分鐘」及開始。訓練中只看當前題，結尾再看首次正確率、改善、未確認儲存和下一次。若同步失敗，區分「練習已完成」與「雲端記錄尚未確認」；不應把未收到成果的 after health 當成真實零改善。

`finishSmartSession()` 目前等待 flush 但不檢查 false，仍讀 server summary，view 再比較 before／after。建議未確認時以本機成績作 provisional，標明稍後更新雲端；避免一邊答對很多、一邊成效顯示沒進步。

### 9.3 實戰失誤到新的準備

Games 明確指出第一個有價值的離開準備位置，提供一個動作；Analyze 展示關鍵理由，再選目標 repertoire；Build 預覽新增和重復；直接練該线並可返回來源。現有 handoff context 應保留，不需要重新設計成全新工作系統。

return state 使用 sessionStorage view key，pending handoff 在記憶體。需要檢查 owner 切換、reload、同 source 多任務時如何恢復；完整 PGN 是否真的需要跟每個 UI state 一起保留。成功跨頁不等於來源上下文永久保存。

### 9.4 比賽前偵察

選對手／棋色／速度 → 短報告先到 → 三個準備重點 → 選中一條看證據 → 加入準備 → 立即試練。深入掃描為明確可選的提高品質步驟；先呈現的歷史報告應標明未完成 engine 的部分，避免推荐在背景變動而無從理解。

### 9.5 各頁共同的狀態矩陣

| 狀態 | 使用者需要知道 | 主要恢復／下一步 |
|---|---|---|
| 空資料 | 用什麼開始，做完會得到什麼 | 建立／匯入／選來源 |
| 載入／運算中 | 已完成階段，剩什麼，能否取消 | 停止／背景繼續 |
| 部分來源失敗 | 哪部分可信、哪個來源缺少 | 只重試失敗來源 |
| 本機保存、等待同步 | 工作保留在哪裡 | 繼續工作／查看待同步 |
| 登入過期 | 草稿仍在、登入後如何恢復 | 重新登入 |
| 版本衝突 | 本機和另一版本有何不同 | 合併／重選位置／匯出草稿 |
| 永久拒絕 | 哪一筆失敗、為何 | 查看並處理 |
| 儲存完成 | 哪個結果已被 server 確認 | 下一個任務 |

簡化重點是少做重複判斷，不是把錯誤藏起來。重要狀態持續顯示，技術細節按需展開。

## 10. 效能、維護與測試配套

### E-01｜P2｜修正 Settings smoke 的資訊架構契約

**重現。** 完整 UI suite 與單獨 Settings 都在 settings-viewport-smoke.mjs:171 等待含 Connections 的 settings-nav-link，30 秒 timeout。新版 nav 只有 Account／Appearance／Engine／Maia3／Playing strength／Board／About；Connections 是 Account 内的 Chess accounts block。

**交叉證據。** States smoke 已改成驗證 #set-account active，仍檢查 #set-connections 在 viewport，且通過。Settings 桌面截圖實際顯示 linked account 和 Link another Lichess account。因此這項先列為 smoke 與新的 IA 不同步，沒有證據說帳號連結壞了。

**建議。** 測試對新版真實任務：到 Account、找到 Chess accounts、連結／解除／primary，維持 scroll、viewport 和 ARIA 斷言。不要只是刪掉失敗检查；更新後應把 Settings 三個尺寸、深色及未登入情境補跑完。

### E-02｜P2／P3｜先量測低階裝置與大資料，才決定效能改造

**現況。** lazy views、browser worker、共享 Maia provider、執行緒上限及 idle teardown 已存在。Scout 三個 engine worker 加 Maia，Analyze 又有運算生命週期；在同一瀏覽器多頁面／多分頁仍需要總資源治理。

建議建立量測表：cold／warm 模型啟動、每階段耗時、記憶體、主執行緒 long task、取消延遲、棋盤输入延遲、耗電／熱降頻。對每份資料规模記錄，不只看平均全部完成時間。若 memory 很高，先限制同時任務／並行度；若树選擇慢，先局部 DOM 更新；若查詢慢，先改 plan。

**驗收目標建議，非本次實測：** 常見棋盤動作／row 選取大多在 100ms 内回饋；長運算開始後 1 秒内有階段状態；取消後迅速釋放任務與持續 CPU；常见 API p95 和 payload 有預算。預算最終以真實裝置與使用者觀察決定。

### E-03｜P3｜抽離狀態擁有者，避免一次性全面重寫

目前 app.js 約 13,655 行、styles.css 約 6,393 行、views/scout.js 約 2,315 行。lazy view 已拆出来，不應只以行數決定換框架。

先抽出儲存協調／outbox state machine、task lifecycle／cancel、toast／modal 管理與共用 board controller。每個模組說清初始化、清理、owner、任務 identity。Scout production、experimental、research 邊界继續保留；不要順便清掉仍可達的 v13 或把歷史 golden 強加回 production。

**驗收。** 導覽／取消／owner 切換後無舊任務覆畫面，listener／worker 數回到預期；同一任務的 state 有單一來源，測試针對行為而非模板字串。

### E-04｜P2｜下一批測試優先補可靠性邊界

| 情境 | 應保護的結果 | 對應項目 |
|---|---|---|
| settled 後舊分頁寫回 | 不復活、不丟新 op | R-01～R-03 |
| 同 op 更新後重整 | 使用正確 parent／payload | R-02 |
| Train 422＋503 後重整 | 只重送 503，拒絕可處理 | R-04／R-06 |
| receipt 清理＋旧 outbox | 不重複計分 | R-05 |
| 僅 skip／queue 變動後關閉 | session 位置可恢復 | R-07 |
| 午夜／延遲一天同步 | streak／due 按定義 | R-07 |
| checkpoint 第 51 筆／quota fail | 無隱藏垃圾，提示可信 | R-08 |
| 两分頁同 revision 同時寫 | 原子成功／明確衝突 | D-01 |
| 完全相同 FEN 不同評分 | 4xx、無部分寫入 | D-02 |
| valid attempt 後 collision | 每 UUID 結果清楚 | D-04 |
| 時鐘跨 due_at | health／排程一致 | D-05 |
| 七／二十 repertoire 短 session | 不超全域預算 | A-01 |
| 郵件服務失敗／復原成功 | 真正可收到，無 token log | F-01 |
| 持有 expired cookie | 不能復活 session | F-02 |
| 刪帳號後检查本機 | 對應 owner 草稿清理 | F-04 |
| modal＋toast＋軟鍵盤 | 主動作可見可點，focus 正確 | U-02／V-03 |
| Settings 新入口 | 三尺寸真實任務成功 | E-01 |

多數新增价值来自失敗／恢復／跨時間邊界；不需要為每個按鈕再加一份和 HTML 完全相同的 snapshot。PostgreSQL 的 row lock、transaction、長度限制與 CTE 要有方言測試，SQLite 通過不能代替這部分。

### E-05｜P3｜讓可觀察性回答「使用者成果有沒有保存」

建議記錄 operation／task ID、phase、acknowledged／rejected、待同步最久年齡、恢復成功率、來源完整度、模型降級原因與 cancellation。不要記 token、整份 PGN、完整分析 payload 或恢復郵件 body。

產品指標：首次訓練完成時間、分析後進入第一次練習比例、Scout 建議到加入準備比例、每日複習完成率。可靠性指標：重複計分、無法恢復的操作、跨 owner replay、未確認卻顯示 Saved。僅有 API 200 比例不能證明這些指標良好。

## 11. 建議實施順序

| 批次 | 内容 | 建議完成定義 |
|---|---|---|
| 第一批：保存與帳號承諾 | R-01／R-02／R-04；revision UI＋原子检查；真實 mail delivery；server session expiry | 不丟草稿、不反覆拒絕、能復原帳號，關鍵失敗路径有回歸 |
| 第二批：恢復生命週期 | 跨分頁 atomic storage、receipt／offline 期限、session 時間／位置、checkpoint 清理、rejected 面板 | 重整／長離線／多分頁／quota fail 都有明確結果 |
| 第三批：算法與統計一致 | duplicate FEN、sync outcome、health axes、mixed budget、summary provisional | 數字和真實排程一致，拒絕和略過可理解 |
| 第四批：任務簡化 | 手機 active Train、Scout 三重點／就近詳情、通知位置、統一本機／雲端状態 | 真實任務步驟與返回次數下降，不损失必要證據 |
| 持續工作 | Settings smoke、PostgreSQL gate、低階裝置／大帳號量測、术語、可及性、模块拆分 | 穩定的回歸與量測記錄，按瓶頸改善 |

receipt 期限應在清理功能啟用前完成，無須等待第二批全部工作；Settings smoke 更新可以獨立先做。若實際正式部署已有 external mail adapter 或額外 session protection，應先核對部署實現再決定範圍。

不建議把整份報告變成一次大 PR。一次解决一份明確契約，例如「確認操作不復活」「過期 session 不復活」「混合 session 不超預算」，比較容易驗收，也不會把 UI 調整與數據迁移風險綁在一起。

## 12. 證據、附件與重現

### 12.1 本次新增附件

- [截圖目錄](review-assets/2026-09-30-current/)：31 張 fixture-backed 截圖；重點圖已插入相關章節。
- [outbox／checkpoint／對比探針](../artifacts/project-review-2026-09-30/outbox-probe.mjs)。
- [outbox／checkpoint／對比數值](../artifacts/project-review-2026-09-30/outbox-probe-result.json)。
- [隔離 API／服務探針](../artifacts/project-review-2026-09-30/api-probe.py)。
- [API／服務結果](../artifacts/project-review-2026-09-30/api-probe-output.txt)。

探針只寫記忆體假 storage 或臨時 SQLite，沒有操作專案現有 DB。它們是本報告的可重現證據，不加入產品預設測試 discovery。

```powershell
node artifacts/project-review-2026-09-30/outbox-probe.mjs
.venv/Scripts/python.exe artifacts/project-review-2026-09-30/api-probe.py
```

### 12.2 核心數值

```text
acknowledgedPending = 0
storedTombstones = ["tmp-1"]
resurrectedPending = 1
mergedParent = "tmp-parent"（incoming 為 real-parent）
checkpointIndexCount = 50
checkpointBodyCount = 51
duplicateExactFenStatus = 200
persistedFirstScore = 999
idle31DaysAuthMeStatus = 200
idle31DaysStillAuthenticated = true
mixedRequestedSize = 12
mixedActualCards = 14
```

### 12.3 主要程式碼證據位置

| 主題 | 主要檔案／函式 |
|---|---|
| outbox identity／merge／lock | [sync-outbox.js](../web-src/sync-outbox.js)：mergeById、mergeOutboxState、saveOutbox、acquireFlushLock |
| 保存與恢復編排 | [app.js](../web-src/app.js)：persistOutbox、restoreOutbox、flushBuildMoves、isolateRejectedBuildOps、flushTrainSync |
| Train group 結果 | [train-sync.js](../web-src/train-sync.js)：flushGroups、groupAttempts |
| errors 與提示 | [sync-errors.js](../web-src/sync-errors.js)：classifySyncError、describeSyncError |
| 分析 checkpoint | [analyze-checkpoint.js](../web-src/analyze-checkpoint.js)：writeIndex、saveCheckpoint、loadCheckpoint |
| revision 與分享 | [workspace.py](../src/prepforge_chess/api/routers/workspace.py)：_check_base_revision、build mutations、share-link endpoints |
| duplicate FEN／重複保存 | [analyze.py](../src/prepforge_chess/api/routers/analyze.py)：analyze_classify_save |
| 分類／説明／品質 | [browser_compute.py](../src/prepforge_chess/services/browser_compute.py)：validate_position_payload、classify_precomputed_game |
| 列表、health、receipt／snapshot | [repositories.py](../src/prepforge_chess/storage/repositories.py)：list_owner_repertoire_listings、due_counts_by_repertoire、list_analyzed_games |
| 混合預算與逐筆 sync | [training_smart.py](../src/prepforge_chess/services/training_smart.py)：start_or_resume_mixed、sync_progress |
| SRS／顯示分類 | [training.py](../src/prepforge_chess/services/training.py)：update_spaced_repetition；[progress.py](../src/prepforge_chess/services/progress.py)：node_mastery |
| receipt 保留窗口 | [data_lifecycle.py](../src/prepforge_chess/services/data_lifecycle.py)：OFFLINE_RETRY_DAYS、reclaim_orphans |
| 復原寄送 | [auth.py](../src/prepforge_chess/api/routers/auth.py)：_deliver_mail、forgot_password、_purge_expired |
| session 認證 | [deps.py](../src/prepforge_chess/api/deps.py)：current_user_optional |
| 帳號 UI／刪除 | [settings-account.js](../web-src/views/settings-account.js)：deleteAccount；[account.py](../src/prepforge_chess/api/routers/account.py) |
| Scout 預算／價值 | [scout-prefilter.js](../web-src/scout-prefilter.js)、[scout-preparation-value.js](../web-src/scout-preparation-value.js) |
| 大樹與 focus | [build.js](../web-src/views/build.js)、[movetree.js](../web-src/views/shared/movetree.js) |
| UI 與 token | [index.html](../web-src/index.html)、[styles.css](../web-src/styles.css) |
| Settings 失敗 gate | [settings-viewport-smoke.mjs](../scripts/smoke/ui-v2/settings-viewport-smoke.mjs)：171 行附近；[states-smoke.mjs](../scripts/smoke/ui-v2/states-smoke.mjs) |

本報告描述檢查當下的實作與建議；後續採取行動前，應核對相應函數是否已更新。保留目前已有效的回歸和產品能力，用针對性的改善縮短任務、提高儲存可信度，並以真實量測决定更大的重构。
