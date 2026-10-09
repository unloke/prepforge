# 現行使用操作

核對日期：2026-10-08。依現行程式整理，並在桌面與手機（390×844）實際操作過主要流程。這份文件描述目前功能，不沿用 archive 的產品決策。

## 功能清單與入口

| 功能 | 電腦版入口 | 手機版入口 |
| --- | --- | --- |
| Library、今日佇列、搜尋與篩選 | 左側 Library | 底部 Library |
| 新建棋譜、PGN／PrepForge JSON 匯入 | Library 的 New repertoire／Import PGN | Library 的新增按鈕；匯入依新增流程 |
| 棋譜編輯、分支與主線 | Library 開啟棋譜／左側 Repertoire | Library 開啟棋譜，Moves 分頁 |
| 走法註解、標記、啟用、主線與分支操作 | 走法選單／More actions | More actions → Move；其他項目依選單 |
| Explorer：Masters／Players／Engine | 棋譜下方 Inspector | 棋譜的 Explorer 分頁 |
| Generate | 棋譜右上 Generate | 棋譜標題列 Generate |
| Coverage 掃描、補法預覽與新增 | Inspector → Coverage | Coverage 分頁 |
| Smart queue、提示、跳過、Blitz、摘要 | Train → Smart queue | Train → Smart queue |
| Line rehearsal、錯題重練 | Train → Line rehearsal | Train → Line rehearsal |
| Practice game、悔棋、認輸與轉分析 | Train → Practice game | Train → Practice game |
| Analyze：輸入 PGN、檔案、最近分析、上一局 | Analyze 的來源與 Games 面板 | Analyze 底部 Games 資料夾按鈕 |
| 引擎報告、Turning point、走法分類 | Analyze 報告與走法列表 | Analyze → Report 抽屜／左右箭頭 |
| Humans、引擎變化與 Exit line | Analyze 的 Humans／Engine | 棋盤下 Humans／Engine |
| Games：來源、樣本、對局檢查與偏離詳情 | 左側 Games | 底部 Games |
| Scout：來源、顏色、串流、暫停與棋速 | 左側 Scout | 底部 More → Scout |
| Scout：路線詳情、分析、加入準備、Deep scan、報告 | Scout 結果 | Scout 結果，往下捲動 |
| Teams：搜尋、新建、成員與共享棋譜 | 左側 Teams | More → Teams |
| 棋譜分享連結／團隊分享 | Library 棋譜動作選單 | Library 棋譜 ⋯ |
| Settings：帳號、資料下載、外觀、引擎、Maia、棋盤 | 左側 Settings | More → Settings |
| Command palette | Search／Ctrl+K | More → Command palette |

手機棋盤頁會收起全域導覽。底部 **Views** 方格按鈕可重新開啟 Library、Train、Analyze、Games、More。More 內有 Scout、Teams、Settings。電腦側欄在較窄寬度可能只顯示圖示，名稱可透過 hover／可及性標籤辨識。

## 1. 進站與準備

1. 打開網站。已有登入狀態時進 Library；尚未登入時依網站登入入口完成登入。
2. Settings → Chess accounts 檢查已連結的 Lichess 帳號與 Primary。Games／Scout 的 Self 可以包含多個帳號。
3. Settings → Engine 按 Refresh 確認 Stockfish available；Maia3 按 Verify 確認 Ready。
4. 返回 Library，查看 Due／New，或搜尋自己的棋譜。

完成判準：能辨識目前帳號、棋譜與可用引擎。本次是在已登入帳號進站，未驗證登出後重新登入或連結新帳號。

## 2. 新建、匯入與管理棋譜

1. Library → New repertoire，輸入名稱並選 White／Black。
2. 建立後開啟棋譜。新增第一手後，Library 會顯示可訓練走法數。
3. 匯入時選 Import PGN，選擇本機 PGN；目前程式亦接受 PrepForge 的 JSON 匯出格式。依匯入對話框選擇名稱／顏色並完成。
4. Library 的搜尋欄依名稱篩選；All／White／Black／Shared／Disabled 篩選清單。
5. 棋譜旁 ⋯ 可開啟、訓練、重新命名、分享、啟用／停用、刪除；以目前選單實際可用項目為準。
6. 刪除棋譜或走法後會出現 Undo；在提示消失前按 Undo 可完整還原，之後才真正送出刪除。

完成判準：新棋譜出現在 Library，重新開啟後仍有預期內容。匯入成功應以重新開啟的樹確認，不能只看檔案選擇器關閉。

## 3. 手動編輯與 Explorer

1. 在棋譜初始局面，點棋子再點目標格，或點 Explorer 的走法列新增走法。
2. 沿目前分支繼續走棋；返回較早局面再走不同棋可新增分支。
3. 用棋盤下左右箭頭、Position 路徑或 Moves 樹跳到既有局面。
4. 在走法選單操作 Comment／Tag／Mainline／Prepared／Enabled 等可用項目。手機可用 More actions → Move → Comment，輸入並 Save。
5. Explorer 切 Masters／Players 查看實際走法、比例與結果，Engine 查看引擎候選；點候選走法進入下一局面。
6. 用 More actions 的 FEN／Line／Branch PGN 等項目複製或匯出。
7. 等待保存狀態，返回 Library 再重新開啟，核對內容。

完成判準：棋盤、Position 路徑與樹一致，保存狀態顯示 Saved；註解重新打開仍在；重新開啟後內容相同。

## 4. Generate

1. 先定位欲延伸的局面，按 Generate。
2. 設定 Full moves deep（1–10）、主線與支線的最低人類走法比例、Opponent rating、Engine depth。
3. 檢查估計新增走法數，按 Generate。需要中止時用工作進度的 Stop。
4. 完成後核對新增分支與可訓練走法數；重新開啟確認保存。

本次用 1 full move／depth 10 控制測試量。這是實際生成與寫入，不是可播放的預覽。主線標記與新分支也應一併檢查。

## 5. Coverage 找缺口並補齊

1. 電腦 Inspector → Coverage；手機 Coverage 分頁。
2. 選 Mainline 或 Branch，以及 Horizon（2／4／8／12 moves），按 Scan。
3. 查看 Prepared／Missing／Unchecked 與缺口列表。點列查看缺口局面，勾選欲補的缺口。
4. 按 Preview N replies，等待生成。
5. 確認 Add prepared replies? 對話框內容，再按 Add replies。
6. Replies added 可選 Stay in Build 或 Practice replies。回 Moves 樹確認新增內容。
7. Preparation changed 時再 Scan；再次開啟棋譜確認保存。

確認框以帶手數的 PGN 顯示每個缺口的補法，例如 `1. e4 e5 2. Nf3 Nc6 (2... Nf6 3. Nxe5) 3. Bb5`：括號內是同一局面的另一個回應。極少見但非零的缺口顯示 `<0.1%`。

完成判準：新增的是選定缺口的回應，樹與訓練數更新。

## 6. Smart queue

1. Train → Smart queue 會混合所有啟用棋譜。從 Library／Repertoire 的某個棋譜按 Train，則只排該棋譜的卡片。
2. 若要 10 秒／步，開始前啟用 Blitz；本次沒有完整跑完 Blitz。
3. 按 Start，觀看對手走法，輪到自己時在棋盤作答。
4. Show hint 依序提供 Idea、Piece、Answer；有提示後答對不算 first-try Correct。
5. Skip this card 跳到下一張；路徑按鈕可查看卡片上下文。Up next 是後續卡片，不是當前答案。
6. 卡片完成後查看 Session complete；New session 開新一輪。

完成判準：到達摘要，看到第一次答對、失誤（提示後答對也算失誤）與跳過數；結束後不再顯示待走方。

## 7. Line rehearsal

1. Train → Line rehearsal，選 Repertoire，按 Start。
2. 逐步走自己的準備手；程式走對手回應。
3. 可 Show hint 或 Skip this line。完成一條後進下一條。
4. 有錯誤時可能進 Recovery／Practice mistakes，再作答並完成重練。
5. 全部完成後查看 Session complete。

完成判準：所選棋譜的路線演練到摘要。這個模式目前不像 Smart queue 顯示完整路徑，辨識剛走完的分支較不方便。

## 8. Practice game

1. Train → Practice game，選 Opponent book：Lichess explorer、My repertoire 或 Maia。
2. My repertoire 選欲使用的棋譜；其顏色會影響可用執子方。其他來源可選 White／Black。
3. 按 Start；I'm Feeling Lucky 另起隨機練習局面。
4. 在棋盤下棋，等待 Explorer／Maia／棋譜回應。
5. Takeback 回到自己的上一個決策；Resign 結束對局。
6. Analyze 將練習走法帶到 Analyze，再執行分析。

完成判準：對手能回應，悔棋正確，結束後可以分析。帶到 Analyze 的 PGN 含結果（認輸、將死、和棋）與對手來源，例如 `Maia 1500`。

## 9. Analyze

1. 從 Analyze 的來源區貼 PGN／選 PGN 檔，或選 My last game／Recent analyses；也可從 Games、Scout、Practice game 跳入。
2. 載入後可用左右箭頭／走法列表瀏覽；按 Analyze 執行整局引擎分析，等待完成。
3. 電腦查看報告；手機按 Report 開抽屜。點 White／Black 的 Good、Inaccuracy、Blunder 等分類跳到對應走法。
4. 點 Turning point 跳到關鍵失誤，查看 coach 與 Humans 候選。
5. 點 Humans 或 Engine 的候選線可瀏覽假想變化，用 Exit line 回原局。
6. 自己的對局在適用位置可用 Train it 等動作建立複習。
7. 從 Recent analyses 重新開啟確認分析記錄。

手機底部 **Games** 資料夾開的是「分析來源與最近分析」抽屜；全域 **Games** 頁要先 Views → Games。這兩個同名入口容易混淆，需按上下文辨識。

## 10. Games 實戰檢查

1. Games → ＋ Add 選來源：Self、特定連結帳號或外部玩家。
2. Sample 選 last 10／20／30／50，按 Check。
3. 以 You left prep／Opponent novelty／Not covered 篩選，選一局。
4. Preparation detail 查看準備到哪一步、實際偏離與原本預期。
5. 自己忘記的準備會記為 recall miss 並加入訓練。Train 開複習；對手新招可依動作補回應；Analyze 轉整局分析，lichess 連結看原局。

完成判準：可定位偏離局面，知道下一個動作。詳情的 Train 第一張卡就是該局面與預期手，其後才是一般複習卡。

## 11. Scout 偵察與準備

1. Scout → ＋ Add 選來源；Playing as 選 Both／White／Black，按 Start。
2. 等待歷史對局串流；Pause／Stop 暫停，Resume 繼續，Reset 重設來源流程。
3. All／Blitz／Rapid 篩棋速。With White／With Black 指**對手**的執子方，準備棋譜應選相反顏色。
4. 查看首步分布、常走路線與結果；點分布繼續鑽取，點路線開 Line detail。
5. Analyze › 轉可逐步操作的分析棋盤。
6. Add to prep → 選 Target repertoire → Continue；核對 Build 路線、保存與重開後內容。
7. Add all gaps 批量加入，會擴大棋譜內容；本次沒有提交批量新增。
8. Deep scan 直接開始，對每色最近 60 局做引擎掃描，再看失誤／refutation；範圍寫在按鈕的 tooltip。
9. Copy report 複製報告。

完成判準：對手資料的顏色與棋速正確；加入後保存狀態變 Saved，重新開啟目標棋譜仍有該路線。

## 12. Teams、分享、Settings 與全域搜尋

Teams：搜尋 Directory → New team 輸入名稱建立 → Members 檢查成員 → Shared repertoires 檢查共享內容。Invite／Add member／Share a repertoire 會影響其他人，本次未送出。Library 分享連結與團隊分享也只整理入口，未發布新分享。

Settings：Account 可編輯名稱、連結帳號、設定 Primary／解除連結、下載資料與刪帳號；Appearance 設主題；Engine Refresh、Maia Verify 檢查狀態；Playing strength 設分析深度／Maia rating／Auto／Maia analysis；Board 設棋子、座標、動畫、音效、箭頭。詳細資料使用 ⓘ 按需展開。刪帳號、刪棋譜與刪團隊會刪除資料，本次未提交。

Command palette：電腦按 Ctrl+K／Search，手機 More → Command palette，輸入功能或棋譜名稱，選結果進入。

收到分享連結（`/?shared=…`）：以唯讀方式開啟對方棋譜，可瀏覽樹與 Explorer，但不能編輯或補缺口；按 Copy to my account 複製成自己的棋譜後才能修改。

## 驗證範圍

桌面 1280×900 與手機 390×844 瀏覽器 viewport 實際操作過；未使用實體手機、Safari、橫向或軟鍵盤。PGN／JSON 匯入與資料下載的檔案落地、Blitz 逾時、邀請與公開分享未端到端驗證。
