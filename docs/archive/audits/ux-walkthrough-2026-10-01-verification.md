# 2026-10-01 UX 走查報告核對

核對對象：[原報告](ux-walkthrough-2026-10-01.md)及其 40 張截圖。結論：報告捕捉到多項真實的使用障礙，但部分原因、統計解讀、修正建議與目前產品實作有出入，不能直接將全部條目當成已確認的功能錯誤。

## 核對範圍與證據

- 本地版本：`4fc3207`；以 `docs/README.md`、目前實作與現行產品文件為準。
- 40 張截圖均已視覺檢閱；關鍵數字、棋盤、Coverage、Games、Scout 另以原尺寸核對。
- 線上首頁的入口 JS、Chess JS、入口 CSS 與本地 `src/prepforge_chess/web/static/` 對應檔案，SHA-256 全部相同。這證明這三個前端檔案一致，不代表已核對全部 lazy chunks、伺服器版本或部署設定。
- 使用全新、未登入的 Chrome session，在 1280×609 補測 Line rehearsal 與 Ctrl+K，另檢查灰色 queue bar 的實際 computed style。
- 既有 `train-preview`、`analyze-orient`、`replay-focus`、`scout-selection-v2`、`rail-nav` 測試：5 檔、36 測試通過。
- 本次沒有登入、重跑訓練或修改帳號資料。登入後現象依原截圖與程式核對；約 5 秒的等待、串流排序移動、完整對局的 fallback 比例，不能靠單張截圖重新驗證。
- 補測腳本、結果及截圖：[artifacts/ux-report-audit-2026-10-01](../artifacts/ux-report-audit-2026-10-01/)。

## 必須修正的解讀

### 1. P0-1：不是缺少登入檢查，而是 Start 被停用

線上補測 `#start-train.disabled === true`。`app.js:10200` 在 Line rehearsal 沒有選定 repertoire 時停用 Start；訪客沒有 repertoire，因此根本不會進入 click handler。`startTraining()` 在 `app.js:10381` 已經有登入檢查，而且在分流 Smart queue／Line rehearsal 之前執行。

原報告「按了沒有反應」符合使用者感受；「看起來可以按」是可辨識性問題，不能當成按鈕實際 enabled 的證據。再補一次 `requireSignIn` 不會解決停用按鈕。

合適的修正方向是讓訪客入口可觸發既有登入流程，或把停用的 Start 換成清楚的登入 CTA；保留登入後沒有 repertoire 時的正常停用規則。

### 2. P0-2：失敗被冒充為低樣本成立，但公開 proxy 的建議少了 token 條件

`app.js:10681` 將任何 Explorer 例外轉成零局；`train-opponent.js:153` 再判成 `thin-sample`，因此原報告的核心診斷成立。截圖〔09〕證明這一步使用 Maia，截圖本身沒有 401 網路紀錄；401 是原測試的文字紀錄，並與本地後端的登入依賴相符。

後端目前不只需要 PrepForge 登入，cache miss 時也要有可用的 linked Lichess token（`lichess.py:388`）。因此「登入後可用」應寫成「登入並連結 Lichess 後可用」，或依實際 token 狀態顯示。既有 endpoint 已有 `120/minute` rate limit。若要開放訪客，除了權限與流量限制，還需要決定上游 token 的取得、使用範圍與快取策略，不能只刪除 `Depends(current_user)`。

也不宜將「整局都是 Maia」寫成已測量的結果：前端可能命中既有 Explorer cache，且報告只展示一步。應寫成「沒有可用 cache、每次請求均失敗時，Explorer 模式會持續 fallback」。模型 manifest 的 fp16 是 46,417,576 bytes，約 46.4 MB／44.3 MiB；下載也取決於是否已有模型快取。

### 3. P0-3：確實重現，但不是原生 form submit，preventDefault 已經存在

Ctrl+K 輸入 `Start training` 後按 Enter，登入框立即出現 `Enter your email and password.`，本次線上補測成功重現。

`app.js:3716` 已經呼叫 `preventDefault()`；登入按鈕是 `type="button"`。真正路徑是 palette input 的 keydown 執行動作並新增登入框，再冒泡到登入框的 document keydown listener；後者在 `account.js:352` 主動呼叫 `submit()`。

因此要修正事件傳遞或登入框對觸發事件的處理。補 `preventDefault()` 本身無效；`stopPropagation()` 是符合這個事件路徑的候選修正。

### 4. P1-1：混合了三個不同問題，不能全部稱為算錯

`progress.py:64` 把每個有效的己方訓練節點分成互斥的 new、learning、mastered、weak、due；`trainable` 是全部己方可訓練節點，不是今天的待辦數。

- **41 to train 與 33 new + 1 weak 不需要相等。** 剩餘節點可屬 learning／mastered／due。截圖沒有完整 health payload，不能直接斷言其餘 7 個全部是 learning。可以要求補充定義或組成，但不能認定 41 算錯。
- **1 review move ready 與 Due review 0 可同時正確。** Train 的 preview 是 `weak + due`（`views/train.js:9`），Library 的 Due review 是到期時間計數。若有 1 weak、0 due，就會呈現這種組合。`Reviews clear` 容易讓人理解成沒有任何需要練的項目，屬文案口徑問題。
- **37 → 33 是值得保留的 freshness／同步觀察。** 〔21〕右下仍是 `Saving…`，不能假設已完成同步。preview 有 30 秒 cache；finish 流程先更新 controls，之後才 invalidation、flush、取得 summary（`app.js:12062`）。需要記錄同步完成後的數字與 API 回應才能判斷最終狀態是否錯誤。

後端也確有需要對齊的範圍：Library 列的 due 使用有效節點／mastery 規則（`repositories.py:1156`），dashboard 頂部則直接統計 owner progress 的 due timestamp，沒有同樣的 enabled／active／weak 排除條件（`workspace.py:157`）。所以不應撤銷數字一致性工作，而是明確定義「同一帳號、有效 repertoire、相同同步時間」下每個指標的範圍。

### 5. P1-5／P1-6：區分自方評語、對手失誤提示與當前局面引擎

`Review my moves` 的目前語意是：辨識到 PGN 的 linked Self 時，只評級自己的 mainline 著法；沒有可辨識的 Self 或自由探索時，仍會評所有著法（`analyze-orient.js:25`、`app.js:4863`）。未登入自由下棋時，翻轉棋盤或主觀宣告執白，並不會設定 Self。

因此：

- 未登入時評價 `1...e5` 不是違反現有規則；可以改善 toggle 名稱或增加「我的顏色」，但不能直接稱為評論對手的邏輯錯誤。
- 在已辨識自方的整局分析中，對手 `14.a3??` 只顯示 `White pushes the a-pawn.`，符合目前「對手只做描述」規則。加入「對手失誤，你可如何利用」是合理的新功能；應另列，避免一邊要求不評對手、一邊將未評對手列為 bug。
- 「edges ahead」與「about level」有措辭衝突，但微小優勢與近似均勢不是嚴格互斥的棋理判斷。程式的 flip 條件 `<50` 和 standing 的 level 區間 `>43` 明確重疊（`commentary.js:139,806`），應修正敘述門檻。〔05〕實際是 `3...Nf6`，沒有保存原報告引用的 `2.Qh5` 句子，該引文只能標記為文字觀察。
- 〔30〕綠色箭頭確實是白方 `Bf3-d6`；它與 PV 的 `14.Bd6` 一致。Engine widget 畫的是**當前、走完 13...Rd8 的局面**之最佳下一步（`app.js:1580`），coach 的 `d5 was cleaner` 則是黑方在**走 13...Rd8 之前**的替代著法。不是引擎把黑白方算反，而是兩種時間點缺少標示。

若要畫「應該下 d5」，必須切回失誤前局面或另開前局面預覽；不能直接在走完 Rd8、輪白方的棋盤上畫成可走的建議。

### 6. P2-4／P2-9：符號與 Games 棋盤有明確誤讀

- Analyze 的綠色 `+` 是 `good` 群組的評級符號，不是「加入 repertoire」（`views/analyze.js:33,338`）。`?!`、`?`、`??` 已經存在，〔30〕也能看到。原報告說「每一步都是 +」不正確；可要求讓 good 的符號更清楚、圖例更容易找到。
- Games 已依 `user_color` 翻轉迷你棋盤（`views/replay.js:90,108`）。〔32〕Agrik vs Anonymousub 的棋盤也已是黑方視角。「執黑時不會翻轉」應撤銷；沒有座標的觀察可保留。
- `in prep` 標記已存在：〔33〕的 `e4` 是綠色，`c5` 是 departure 色。〔32〕是 No repertoire，自然沒有 in-prep 著法。可以指出圖例色與文字實際色不一致（`replay.css:91,96`），不能說完全沒有標記。
- ply 2 是 **1...c5**，不是 **2...c5**。原報告 P2-9 的第二個替代例子差了一整手。改寫為「第 1 手黑方：c5」。
- 「8 plies → 4 moves」只適用白方從初始局面開始、完整走完四回合的例子；任意 FEN／奇數半步不能固定除二。可改用「8 次著法」或清楚表示回合與半步。

### 7. P2-11：Scout 的長路線與 n=1 不等於未做聚合或選錯資料

現行產品目標是觀察到的對手決策準備路線，而不是固定前 N 手的開局分類表；參見 [Scout production ranking](scout-production-ranking.md)。

實作已建 prefix trie、聚合相同 terminal route，並加入有分支支持的前綴候選（`scout.js:925,1150`）；生產選擇也會去除重複決策收益。每條完整路線的 `n=1` 不代表共享開局決策只出現一次。

開局路線目前依 `gamePhase` 決定截斷點（`scout.js:503`），所以可以長到十幾、二十回合。〔36〕文字很長的觀察成立，但沒有原始 PGN／結束步數，不能斷言每列都是「整盤棋」。如果 phase 的截斷過晚，應檢查 phase 判定與呈現方式。

「合併相同前 N 手」「預設摺疊所有單局路線」會改變目前準備目標，可能隱藏短戰術或具可利用終點的單局路線。可將共享前綴做成導航／摘要，保留具體路線與證據；要改 selector，需另外比較準備覆蓋率與可行動性。

`100% = 1W 0D 0L` 在〔36〕成立，而且畫面同時顯示 Small sample 與 W/D/L；這是歷史樣本得分，不是預測勝率。數值本身沒有錯，標示與資訊層級可改善。

來源變更後只更新 chips、沒有清除既有結果（`app.js:12781`），舊報告與新來源可能對不起來的問題成立。保留混合來源是現有選擇能力；加入外部帳號自動取消 Self 應視為產品決策，不能直接覆寫使用者明確選取的來源。

### 8. P2-1／P2-12：部分建議已實作

- Repertoire dock 已可拖曳調整高度，而且折疊與高度寫入 localStorage（`app.js:7391,7439,7458`）。「收合狀態要記住」已存在。矮視窗裡列數很少仍可改善，應核對實際高度與保存行為，避免重做已有功能。
- 左側欄已在滑鼠點目的頁後立即收回，直到 pointerleave 才恢復 hover 展開（`rail-nav.js`、`app.js:13742`）。鍵盤啟動刻意保持可見。P2-12 不能以目前程式判成普遍缺失；若仍能重現，需要指出 click target、輸入方式與 rail class 狀態。

### 9. P2-5／P2-6：多餘空條成立；完成畫面可能只是同步中過渡狀態

`views/train.js:120` 已將 queue composition bar 設為 hidden；但 `.qbar { display:flex }`（`styles.css:3006`）覆蓋瀏覽器 hidden 的顯示規則。本次線上 computed style 驗證：`hidden=true`，仍為 `display:flex`。應先修正 hidden 樣式，不能將這條灰色空條全部當成新的進度模型。

目前完成流程會在取得 after summary 後，隱藏 setup、舊 progress 與 queue（`views/train.js:213`、`styles.css:3106`）。〔21〕仍有 `Saving…`，說明至少畫面不是已確認同步完成；缺少最終 summary 截圖。可保留「完成標題過早出現、等待時新設定和舊統計混在一起」的問題，但不要斷言最終完成頁永遠如此。

7 first-try correct + 1 missed + 1 fixed on retry 不表示 9 次獨立首答：首答是 8 次，fixed 是錯誤後修好的子集。多步卡讓 6 張卡對應 8 次首答是正常的。要改善單位標籤；改成每卡統計時，需先定義多步卡部分答對、Hint、重排、重試如何計分。

### 10. P2-13／P3：在地化與產品狀態不應混為錯誤

- `toLocaleDateString(undefined,…)` 跟隨瀏覽器 locale 的原因成立。應訂一套日期 locale／timezone 策略，而不是視中文日期為壞掉。
- 「罐頭」是正確的使用者資料，不是漏翻譯。英文介面應允許任意語言的顯示名稱。自己的資料可以補 `You` 提示；團隊成員的角色與擁有者資訊不能只因重複就刪到無法辨識權限。
- 註冊 modal 沒有主動呼叫 `checkValidity()`，P3-2 的前端驗證缺口成立；但 API 的 `RegisterRequest.email` 是 `EmailStr`（`auth.py:36`），不能推論 `abc@x` 可以註冊成功。報告也承認未實際註冊。
- `?rep=…` 是持續保留的 workspace context，沒有證據表示功能錯誤或 UI 汙染，應從缺陷清單移到 URL 設計討論。
- P3-6 建議在英文介面換成中文，與 P2-13 要求語言一致互相衝突。英文介面可用 `Auto · Connect Lichess to match your rating; currently 1500` 等英文文案。

## 逐項處置表

「成立」指觀察或實作有支持，不代表原報告的所有影響推論及優先級也成立。「待補證」指截圖無法證明時間／跨頁／完整流程，或目前實作與敘述有差異。

| 原項目 | 核對結果 | 建議處置 |
|---|---|---|
| P0-1 | 無登入入口的感受成立；原因錯誤 | 改寫成 disabled Start／登入 CTA 問題 |
| P0-2 | 錯誤與低樣本混淆成立 | 保留；補 token、cache、失敗種類條件 |
| P0-3 | 線上成功重現 | 保留；修正事件原因，勿再建議單補 preventDefault |
| P0-4 | 三處自由文字與 black-only 轉換成立 | 保留；二選一可直接使用既有 select 支援 |
| P1-1 | 統計口徑、同步與數字定義混在一起 | 拆開處理，不宣稱所有數字算錯 |
| P1-2 | Up next 顯示首個 target SAN 成立 | 區分 new 示範與 due／weak 回憶；洩漏回憶答案值得修正 |
| P1-3 | 〔16〕空表格成立；5 秒與登入跳轉未重測 | 保留載入回饋建議，補時序證據 |
| P1-4 | 原 hint 文案會被覆蓋成立 | 保留提示等級；首次失誤不亮答案是目前重試設計 |
| P1-5 | 自方辨識與評語門檻需說清楚 | 改寫，對手失誤提示另列產品增強 |
| P1-6 | coach 與 Engine 是不同時間點 | 保留語意混淆，撤銷「箭頭畫錯方」推論 |
| P1-7 | PGN 自動重建、取代探索狀態成立 | 防丟失是設計選擇；限於有未保存探索，不要每次載入都確認 |
| P1-8 | 〔31〕初始空頁成立；「每次回來」待補證 | state 有 replayResults 且正常換頁不清空；25 Games 是已存 games 數，不是本次 Check 結果數 |
| P1-9 | 分類與日期用詞差異成立 | 以一致語意改善，不把同一 bucket 的別名當分類算錯 |
| P1-10 | 預設全勾與多位置補線成立 | 補位置與生成範圍；9 個缺口不保證新增恰好 9 條最終葉線 |
| P1-11 | 多來源仍勾選成立 | 增加來源確認／單對手入口；保留明確選取的 mixed 模式 |
| P2-1 | 矮畫面密度成立 | dock 調整與記憶已存在，應改善預設高度及可發現性 |
| P2-2 | 遮擋可見；重複通知部分是流程文字觀察 | 保留位置與狀態訊息建議 |
| P2-3 | 暗色背景變淺可見 | 保留視覺一致性建議 |
| P2-4 | 藍底、密度成立；+ 解讀與建議不準確 | 修正符號事實及 ply 換算 |
| P2-5 | 灰色空條與單位混用成立 | 先修 hidden CSS；保留每步與每卡的清楚區別 |
| P2-6 | 截圖是仍在 Saving 的畫面 | 補最終 summary，優先改善過渡狀態 |
| P2-7 | sync chip 是真實訓練同步；切模式會清當前 session | 改成「Saving training progress」；「進度全部丟掉」不準確，已記錄 attempt 仍在 outbox／server |
| P2-8 | 〔27〕選單未標目標成立 | 標明右鍵節點；是否同時跳棋盤是設計選擇 |
| P2-9 | 不可點棋譜／沒座標成立；不翻轉／沒 in-prep 標記不成立 | 撤銷錯誤部分，改正 ply 2 例子 |
| P2-10 | 留白及 Teams 缺直接登入 CTA 成立 | 可改善；資料少的留白與 mastery 0% 不是功能失效 |
| P2-11 | 小樣本／長路線／舊報告問題有支持；排序移動需動態證據 | 保留呈現問題，撤銷「沒有聚合」推論，勿直接改 selector |
| P2-12 | 目前已有點擊收回 | 標記為需重現，不能直接列未實作 |
| P2-13 | 日期 locale、重複資訊成立；姓名不是翻譯錯誤 | 訂 locale 策略，保留姓名與必要權限資訊 |
| P2-14 | 部分術語／控制標籤／來源不清成立 | 可改善；Play vs human 更名合理，Explorer 已有 White／Draw／Black 欄頭 |
| P3-1 | create account notice 仍沿用 Sign in | 保留文案修正 |
| P3-2 | modal 缺主動前端 validity 檢查 | 保留；補後端 EmailStr，勿宣稱可建立無效帳號 |
| P3-3 | 登入框空白屬視覺判斷 | 視為偏好，非事實性錯誤 |
| P3-4 | 同 P2-13 的日期 locale | 合併，避免重複計數 |
| P3-5 | repertoire query 是上下文保留 | 不列已確認缺陷 |
| P3-6 | 文案可簡化 | 使用與介面一致的英文或完整 locale 機制 |

## 報告本身的其他修正

1. 未登入流程表的 PGN 覆蓋引用寫成 P1-9，應為 **P1-7**。
2. 「所有需要帳號的入口都會打開登入框」與同文 Line rehearsal 項目矛盾；改成「已測入口多數一致，Line rehearsal 的停用入口仍缺直接登入動作」。
3. 本次截圖都是 1280×609，不能據此宣布「約 1000px 的問題已確認修好」。目前 CSS breakpoint 支持改善方向，但應補 982／1024px 實測，並分開寫來源。
4. 〔17〕只顯示接下來三列；文中列五個 SAN 應註明來自不同時刻。從答案可見推到「間隔重複效果就沒了」過於絕對，尤其 new card 本來有示範教學；應限縮到 recall card 的答案洩漏。
5. 〔21〕是 **88% first try**，〔20〕是 80%；要明確分別標示，避免把會更新的進度數字當同一時點。
6. 「測試影響都已還原或屬無害」不代表資料沒有寫入。訓練會更新 progress／due／streak，整局分析會新增紀錄；Games Check 對 linked Self 的 departure 也可能寫入訓練 miss（[compare identity boundary](compare-identity-boundary.md)）。應分成已還原的樹／設定與保留的訓練／分析寫入，標記 Games 是否新增 miss。
7. 「四個 P0，每個改動都很小」不成立。公開 Explorer 涉及 token 與訪客策略；跨頁統計涉及規則與同步；事件誤觸則已有 preventDefault。原報告的 P0 是自行定義的類別，不能不經範圍、替代路徑、資料影響評估就等同全站發布阻斷。

## 符合目前產品的優先順序

1. 修正會寫錯方別的輸入，以及 palette 的 Enter 誤觸；讓訪客 Line rehearsal 有清楚的登入入口。
2. 將 Explorer 的 auth／token／network／rate limit 失敗與真的低樣本分開，清楚標示當前對手來源。
3. 修正回憶訓練的答案 preview、hint 保留與 hidden CSS；完成前顯示同步／整理結果狀態，完成後再呈現 summary。
4. 統一統計定義、有效 repertoire 範圍與同步時點；保持 trainable 總量、今日到期、弱點、new、卡片／著法的區別。
5. 明確區分 Analyze 的「剛才著法評語」「失誤前替代著法」「當前局面下一步 PV」。
6. 改善矮畫面、toast、來源與小樣本呈現；保留 Scout 目前的決策準備目標。URL、使用者中文姓名、歷史得分 100%、多步卡計數本身不應被當成錯誤去消除。

> 2026-10-01 更新：原報告已依本文件與程式碼抽查修訂（見原報告文末〈修訂紀錄〉）。本文件保留作為核對紀錄；表中「原項目」指修訂前的寫法。
