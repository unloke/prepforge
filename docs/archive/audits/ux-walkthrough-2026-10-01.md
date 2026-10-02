# PrepForge Chess 實機走查報告（2026-10-01，修訂版）

- 測試對象：線上 Render 版本 `https://prepforge-w0c5.onrender.com`
- 測試方式：真人式操作（點擊、拖棋、捲動、鍵盤），每一步截圖後分析
- 流程：未登入走完所有頁面 → Google 登入 → 登入後實際使用每個功能
- 視窗：Chrome 1280×609（筆電加上瀏覽器工具列後的常見可視高度）。**所有截圖都是這個尺寸**，其他寬度沒有實測。
- 截圖：`docs/review-assets/2026-10-01-ux-walkthrough/`（以下用編號引用，例如〔17〕）
- 帳號：罐頭（Google 登入），已連結 Lichess 帳號 unbrainless87、Anonymousub
- 修訂：已依[核對報告](ux-walkthrough-2026-10-01-verification.md)與目前程式碼（`4fc3207`）逐項修正，改動摘要見文末〈修訂紀錄〉。

> 測試對資料的影響：
> - **已還原**：
>   - Repertoire「anti caro」：加了 1...e5 後已刪除，回到 18 lines／81 moves。
>   - Settings：Maia analysis 曾被 Coverage 的按鈕打開，已關回去；主題已改回 System。
>   - Scout：加入外部來源 DrNykterstein 後已移除，Self 已重新勾選。
> - **保留的寫入（無法還原）**：
>   - Train：完成一輪 Smart queue（6 張卡），會更新 progress／due／streak；Line rehearsal 與 Play vs human 各開始一局後離開。
>   - Analyze：「My last game」新增一筆 Agrik vs Anonymousub 的整局分析紀錄。
>   - Games：執行過 Check。Check 對 linked Self 的 departure 可能寫入訓練 miss（見 [compare identity boundary](compare-identity-boundary.md)），本次沒有確認是否實際新增。

---

## 總結

| 等級 | 數量 | 說明 |
|---|---|---|
| **P0 資料錯誤／誤導性降級／誤觸** | 3 | 存成錯誤的資料、失敗被冒充成「樣本太少」、按鍵穿透 |
| **P1 會誤導或誤操作** | 11＋1 | 另含由 P0 降級的 P0-1（編號保留不變）；數字口徑不清、提示洩答案、評語時間點不清、來源混在一起 |
| **P2 不直覺／版面／美觀** | 14 節 | 矮螢幕空間、toast 擋住內容、hidden 元素仍顯示、術語、資訊層級 |
| **P3 細節** | 4 | 文案、驗證、一致性 |

P0 是本報告自定的分類，代表「應優先處理」，不等於全站發布阻斷；實際修正範圍見各項說明。

**和 9/30 相比進步很多。** 上次最大的兩個結構性問題已經改善：

- 未登入的權限閘門：**已測的入口大多一致**，會打開登入框並寫出原因（〔02〕）。例外是 Line rehearsal：Start 是停用狀態，沒有直接的登入入口（P0-1）。
- 在 1280×609 下，Games 改成左右並排，Repertoire 有載入骨架。9/30 的「約 1000px 上下堆疊」問題，目前的 CSS breakpoint 支持改善方向，但**這次沒有在 982／1024px 實測**，不能算已確認修好。

詳見文末〈已確認修好的項目〉。

這次感覺「不順手」，主要來自三件事：

1. **數字的定義沒有說清楚。** Library、Train、Repertoire 對「要學／要複習」用的是不同口徑（trainable 總量、weak+due、到期時間計數），畫面上卻沒有說明，再加上同步時間差，看起來像互相矛盾（P1-1）。使用者不知道今天練完了沒有。
2. **Train 的回饋太多層。** 一個面板裡有多條進度條和兩種單位（每步／每張卡），其中一條灰色空條其實是本來應該隱藏的元素（P2-5）。「Up next」也會顯示著法（P1-2）。
3. **矮螢幕（約 600px 高）下，右側面板預設塞不下。** Repertoire 的 Explorer 預設只剩 2–4 列（dock 其實可拖曳調整，但不容易發現），toast 又常常蓋住按鈕（P2-1、P2-2）。

---

## 一、未登入流程

| 頁面／動作 | 結果 | 備註 |
|---|---|---|
| Library | ✅ 清楚的空狀態與三步驟 Get started〔01〕 | 見 P2-10 |
| New repertoire／Import PGN／New team | ✅ 跳登入框並寫出原因〔02〕 | |
| 登入框：× 按鈕、點遮罩關閉、Esc | ✅ 都能關 | |
| Create account 分頁 | ⚠️ 原因條仍寫「Sign in to …」〔03〕 | P3-1 |
| Repertoire：在棋盤下棋 | ✅ 跳登入框「Sign in to save moves to a repertoire」 | |
| Analyze：下棋、coach、引擎 | ✅ 可用〔05〕〔06〕 | coach 文案問題見 P1-5 |
| Analyze：My last game／Analyze | ✅ 跳登入框並寫出原因 | 9/30 的 P0-1 已修好 |
| Analyze：貼 PGN | ✅ 自動載入棋盤〔07〕 | 會直接取代棋盤上原本的探索，見 P1-7 |
| Train → Smart queue → Start | ✅ 跳登入框 | |
| **Train → Line rehearsal → Start** | ⚠️ **Start 是停用狀態，按了沒有反應**〔08〕 | **P0-1（降為 P1 等級）** |
| **Train → Play vs human** | ⚠️ **Explorer 請求失敗，被當成「樣本太少」改用 Maia**〔09〕 | **P0-2** |
| Games：Check／Add | ✅ 跳登入框 | 頁面大片空白，見 P2-10 |
| Scout：Add／Start | ✅ 跳登入框 | |
| Teams：New team | ✅ 跳登入框 | 中間卡片說「Sign in」卻沒有按鈕，見 P2-10 |
| Settings | ✅ 「Sign in to link Lichess」引導正確 | |
| **Ctrl+K → Start training → Enter** | ❌ **Enter 傳到登入框，立刻送出空表單並顯示紅字錯誤**〔14〕 | **P0-3** |
| 主題切換 | ✅ 亮／暗都正常 | |

## 二、登入流程

1. 點「Continue with Google」→ Google 帳號選擇頁 → 選帳號：✅ 一次成功，沒有要求密碼。
2. 回到網站時：
   - 先停在一個**空的 Library**：只有表頭和「Click a repertoire to open it」，沒有任何列，也沒有載入提示〔16〕。依操作當下的觀察約持續 5 秒（截圖無法證明時長）。網址是 `/?signed_in=1`。
   - 接著自動跳到 Train，並直接開始訓練。這是接續登入前在 Ctrl+K 選的「Start training」，**pending action 有運作，9/30 的 P1-7 已修好**。
   - 但跳轉前沒有任何說明，使用者看到的是「空書庫 → 突然開始練習」。見 P1-3。
3. `signed_in=1` 在跳轉後已清掉。之後換頁時網址會帶著 `?rep=…`，這是刻意保留的 workspace context，不列為缺陷。

## 三、登入後功能

| 功能 | 狀態 | 主要問題 |
|---|---|---|
| Train：Smart queue（完整一輪 6 張卡） | ✅ 可用 | P1-2、P1-4、P2-5、P2-6 |
| Train：Line rehearsal | ✅ 可用 | P2-7 |
| Train：Play vs human | ✅ Explorer 正常 | |
| Library | ✅ | P1-1、P2-10 |
| Repertoire：樹、Explorer 預覽、加入／刪除／Undo | ✅ 點 Explorer 列現在是預覽，加入要按「+」〔24〕 | P2-1、P2-2、P2-8 |
| Repertoire：Coverage | ✅ 有「Turn on Maia analysis & scan」按鈕〔25〕 | P1-10 |
| Repertoire：Generate moves | ✅ 改成「淺／中／深」並附上預估〔26〕 | |
| Analyze：My last game | ✅ 會自動分析，完成後 coach 給整局摘要〔28〕 | P1-5、P1-6、P2-4 |
| Games | ✅ 左右並排、點列直接出明細〔32〕 | P1-8、P1-9、P2-9 |
| Scout | ✅ 串流報告、可以 Stop | P1-11、P2-11 |
| Teams | ✅ 會自動選取團隊；Invite 不再自動重產連結〔37〕 | P2-13 |
| Settings | ✅ Auto 模式下 Maia 滑桿會停用並顯示 2377 | |
| New repertoire 對話框 | ❌ 顏色欄是自由輸入的文字框〔38〕 | **P0-4** |

---

## P0：優先處理

### P0-1 未登入時，Line rehearsal 的 Start 是停用狀態，沒有登入入口（降為 P1 等級）
- 截圖：〔08〕
- **重現**：未登入 → Train → Line rehearsal → Start。
- **現象**：
  - 下拉選單顯示「Sign in to train your repertoires」，Start 是停用狀態，但只比一般按鈕略暗，看起來仍像可以按。
  - 按下去沒有登入框，沒有 toast，畫面也沒有任何變化。同一頁的 Smart queue → Start 則會正常跳出登入框。
- **原因**：`web-src/app.js:10200` 在 Line rehearsal 沒有選定 repertoire 時停用 Start；訪客沒有 repertoire，所以永遠不會進到 click handler。`startTraining()`（`app.js:10381`）本身已經有登入檢查，**再補一次 `requireSignIn` 沒有用**。
- **建議**：訪客時把停用的 Start 換成「Sign in to rehearse」CTA，或讓按鈕保持可按並走既有的登入流程；登入後沒有 repertoire 時的停用規則保留不動。停用狀態的視覺也應更明顯。

### P0-2 未登入的 Play vs human：Explorer 請求失敗，卻顯示「樣本太少」
- 截圖：〔09〕
- **重現**：未登入 → Train → Play vs human → Start → 1.e4。
- **現象**：
  - 對手回 e5，說明寫「Maia played e5 · sample too thin, Maia stepped in」。1.e4 之後的局面在 Lichess explorer 有上百萬局，不可能「樣本太少」。
  - 測試當下的網路紀錄顯示 `/api/lichess/explorer/lichess?...` 回傳 **401**（截圖本身沒有網路紀錄；與後端的登入依賴相符）。
- **原因**：
  - 後端 explorer proxy 要求登入（`src/prepforge_chess/api/routers/lichess.py:352`，`Depends(current_user)`），cache miss 時**還要有可用的 linked Lichess token**（`lichess.py:388`）。
  - 前端 `web-src/app.js:10681` 把任何 Explorer 例外都轉成零局，`web-src/train-opponent.js:153` 再判成 `thin-sample`，最後顯示成「sample too thin」。
- **影響**：
  - 沒有可用 cache、每次請求都失敗時，未登入使用者以為自己在跟「Lichess 1400–1600 的人類分佈」對練，其實一直是 Maia。本次只截到一步，沒有量測整局的 fallback 比例。
  - 若瀏覽器還沒有模型快取，會在背景下載 Maia 模型（fp16 約 46.4 MB／44.3 MiB），沒有任何提示。
- **建議**：
  - 把 auth／token／network／rate limit 失敗和真正的低樣本分開，並清楚標示當前對手來源。
  - 未登入（或登入但沒有連結 Lichess）時，把 Opponent book 鎖定為 Maia，並寫出「登入並連結 Lichess 後可用 Lichess explorer」。
  - 若要開放訪客使用 proxy：既有 endpoint 已有 `120/minute` rate limit，但還要決定上游 token 的來源、使用範圍與快取策略，不能只刪掉 `Depends(current_user)`。

### P0-3 Ctrl+K 指令面板按 Enter，會傳到登入框並送出空表單
- 截圖：〔14〕（核對報告已在全新 session 重現）
- **重現**：未登入 → Ctrl+K → 輸入「train」→ 按 Enter 選「Start training」。
- **現象**：登入框一打開，就立刻出現紅字錯誤「Enter your email and password.」。
- **原因**：palette input 的 keydown（`web-src/app.js:3716`）已經 `preventDefault()`，登入按鈕也是 `type="button"`，所以不是原生 form submit。實際路徑是：palette 的 keydown 執行動作、打開登入框並註冊 document keydown listener；同一個事件冒泡到 document，被登入框的 listener 接到，主動呼叫 `submit()`（`web-src/controllers/account.js:352`）。
- **建議**：palette 的 Enter 處理加上 `stopPropagation()`，或把動作延到下一個 tick；或登入框在開啟後忽略觸發它的那次 keydown。單補 `preventDefault()` 無效。

### P0-4 新增 repertoire 時，「顏色」是自由輸入的文字框
- 截圖：〔38〕
- **位置**：New repertoire、Import PGN as repertoire、Turn this game into a repertoire 三個對話框都一樣。程式在 `web-src/app.js:9309`、`4441`、`6591`。
- **現象**：
  - 欄位標籤是「Your color (white / black)」，預設值是 `white`。
  - 程式只在輸入完全等於 `black`（忽略大小寫與前後空白）時才存成黑方。輸入 `b`、`Black.`、`黑`、`blk`，都會**靜默存成白方**。
- **影響**：顏色存錯，整個 repertoire 的訓練方向就錯了，而且使用者不會發現。
- **建議**：
  - 改成 White／Black 的二選一切換（segmented control）。
  - Library 的 Get started 寫著「Pick a side and an opening」，但對話框裡沒有選開局的地方。可以加一個選填的起始局面，或者把文案改掉。

---

## P1：會誤導或誤操作

### P1-1 各頁面對「要學／要複習」用不同口徑，畫面沒有說明
同一個帳號、同一個時段內看到的數字：

| 位置 | 新步 | 複習 | 其他 |
|---|---|---|---|
| Train 結束畫面〔21〕（仍在 Saving…） | 37 new available | 1 review move ready | |
| Library 頂部〔22〕 | 33 new moves to learn | Reviews clear；Due review **0** | 1 weak spot |
| Library 的 repertoire 列〔22〕 | 33 new | | 1 weak；41 moves to train |
| Line rehearsal | 33 new available | 1 review move ready | |
| Repertoire 標題 | | | 41 to train |

這裡混了三個不同的問題，不是全部都算錯：

1. **口徑不同但各自正確，只是沒說明。**
   - Train 的「review move ready」是 `weak + due`（`web-src/views/train.js:9`），Library 的 Due review 只算到期時間。1 weak、0 due 時，就會同時出現「1 review move ready」和「Due review 0」。問題在「Reviews clear」這句文案，容易讓人以為沒有任何要練的。
   - 「41 to train」是全部可訓練的己方節點（new／learning／mastered／weak／due 互斥分類的總和，見 `progress.py:64`），不是今天的待辦數，本來就不會等於 33 new + 1 weak。截圖沒有完整的 health 資料，無法確定其餘 7 個的組成。
2. **同步時間差。** 〔21〕拍攝時右下仍是「Saving…」，preview 也有 30 秒 cache，結束流程是先更新畫面、之後才 flush 和重新取得 summary（`app.js:12062`）。37 → 33 可能只是還沒同步完成的過渡值；需要記錄同步完成後的數字與 API 回應才能判斷。
3. **後端範圍真的不一致。** Library 列的 due 使用有效節點／mastery 規則（`repositories.py:1156`），dashboard 頂部則直接統計 owner progress 的 due timestamp，沒有同樣的 enabled／active／weak 排除條件（`workspace.py:157`）。這部分需要對齊。

**建議**：明確定義每個指標（trainable 總量、今日到期、弱點、new；單位是著法或卡片），在「同一帳號、有效 repertoire、同一同步時間點」下由共用的計算產生。「Reviews clear」改成只在 weak + due 都是 0 時顯示；「41 to train」加上組成說明或 tooltip。

### P1-2 Train 的「Up next」顯示每張卡的第一個著法
- 截圖：〔17〕
- 「Up next」每一列右邊顯示這張卡的目標著法（〔17〕中是 Nc3、e5、Bd2）。三列都只寫「anti caro」，沒有局面資訊。
- 〔17〕這三列都是 New move 卡，新卡本來就會先示範，所以這裡的影響不大。**真正的問題在 due／weak／polish 這類回憶卡**：提前看到答案就失去了回想的效果。
- **建議**：
  - 回憶卡不要顯示著法，改顯示卡片類型和局面摘要，例如「Due review · after 3…e6」。
  - 或者整區改成只顯示數量：「接下來：3 new · 1 polish」。

### P1-3 登入後先閃一個空的 Library，然後突然跳去 Train
- 截圖：〔16〕〔17〕
- 空 Library 只有表頭和「Click a repertoire to open it」，看起來像資料全部不見了。依操作當下觀察約停留 5 秒（截圖無法證明時長，需要補時序紀錄）。
- 接著自動跳到 Train 並開始訓練。接續動作本身是對的，但沒有任何提示。
- **建議**：
  - 登入回來先顯示骨架畫面或「Loading your library…」。
  - 接續 pending action 時，顯示一句說明，例如「Signed in — resuming: Start training」。

### P1-4 Train 走錯後，提示退回成通用句子
- 截圖：〔18〕
- 已經按到 Hint 2「Move the pawn」，走錯一步後，標題變成「Not that one – try again」，副標卻變回通用句「Develop your pieces, occupy the center, and get the king safe.」，原本的提示被覆蓋掉了。
- 第一次走錯時不顯示正解是目前的重試設計，這點不算問題；但錯的那步也沒有被標出來。
- 開局時的「Your move」副標同樣是通用句「Develop toward the center and keep the king safe.」，幾乎每張卡都一樣，看起來像預設文字。
- **建議**：
  - 走錯時保留目前的提示等級。
  - 用紅色標出錯的那步，並提示「再試一次，或按 💡 看下一層提示」。
  - 沒有針對該局面的提示時，乾脆不顯示副標。

### P1-5 Coach 評語的用詞與「Review my moves」的範圍不清楚
- 截圖：〔05〕〔29〕
- **評估用詞重疊。** 未登入下 1.e4 e5 2.Qh5 時，coach 曾寫「…Black edges ahead from here, and White is about level.」（文字紀錄；〔05〕拍到的是之後 3…Nf6 的評語，沒有保存這句）。原因是 flip 條件 `winAfterMover < 50` 和 standing 的「about level」區間 `> 43` 重疊（`web-src/coach/commentary.js:806`、`139`）。應調整門檻，讓同一句只出現一種說法。
- **「Review my moves」的範圍。** 目前規則是：能從 PGN 辨識出 linked Self 時，只評自己的 mainline 著法；沒有可辨識的 Self（例如未登入自由下棋），所有著法都會評（`web-src/analyze-orient.js:25`、`app.js:4863`）。所以未登入時 coach 對 1...e5 說「Cleanly done.」符合現有規則，翻轉棋盤也不會設定 Self。但使用者會以為「my moves」是指自己在下的那一方。建議改 toggle 名稱，或在自由下棋時讓使用者選「我的顏色」。
- **對手失誤的利用提示（新功能）。** 整局分析中，對手的 14.a3??（Blunder）只顯示「White pushes the a-pawn.」，符合「對手只做描述」的規則。加上「對手失誤：你可以 …」會很有用，但這是產品增強，不是 bug。

### P1-6 分析自己的失誤時，coach 的建議和箭頭是不同時間點
- 截圖：〔30〕
- 在 13…Rd8（我的 mistake）上，coach 說「d5 was cleaner」，棋盤上的綠色箭頭卻是白方 Bf3→d6。
- 兩者都沒有算錯：箭頭是 engine 對**走完 13…Rd8 之後**局面的最佳下一步（與 PV 的 14.Bd6 一致，`app.js:1580`）；coach 的 d5 是**走 13…Rd8 之前**的替代著法。問題是畫面沒有標示這兩個時間點，使用者會直覺把綠色箭頭理解成「我應該這樣下」。
- **建議**：清楚區分「剛才著法的評語」「失誤前的替代著法」「目前局面的下一步 PV」。例如箭頭加上「White's best reply」標示；要畫 d5，必須切回失誤前的局面或另開預覽，不能直接畫在輪到白方的棋盤上。

### P1-7 Analyze：貼上 PGN 或打開另一盤，會直接取代棋盤上的探索
- 截圖：〔07〕
- 我在棋盤上下了一段（e4 e5 Qh5 Nc6 Bc4 Nf6），接著在 PGN 框貼上另一段，原本的著法就被取代，沒有確認，也沒有復原。從 Play vs human 按「Analyze」也是同樣的行為。
- **建議**：只在棋盤上有**尚未保存的手動探索**時才詢問「取代目前的棋盤？」，或自動存成一筆 Recent analysis；一般載入不需要每次確認。

### P1-8 重新進入網站後，Games 是空的，要重新按 Check
- 截圖：〔31〕
- 進入 Games 頁只看到「Choose your games and run a check…」，要按 Check 再等約 10 秒才會出現結果。站內正常換頁不會清掉結果（state 有保留 `replayResults`），但重新整理或重新登入後就會變空。
- Library 的「25 Games」是已存的對局數，不是上次 Check 的結果數，兩者不需相等。
- **建議**：保存上次的檢查結果，進頁直接顯示，並標上「Last checked xx min ago · Re-check」。

### P1-9 頁首的分類數字和每一列的標籤用詞不同
- 截圖：〔32〕〔33〕
- 頁首寫「⚡ 4 novelties」「— 5 not covered」，表格裡的標籤則是「Different opening」「No repertoire」。分類本身沒算錯，但同一個分類用了不同名稱，使用者對不起來。
- 同一盤棋，列上寫「You vs Aqwsa」，明細標題寫「Anonymousub vs Aqwsa」。
- 日期也不一致：同一盤 Agrik 的對局，Games 寫 Sep 30，Analyze 寫 2026.10.01（可能是時區）。
- **建議**：頁首和列用同一套詞彙；明細標題也用「You」；訂一套日期與時區策略（見 P2-13）。

### P1-10 Coverage 預設全部勾選，主要按鈕會一次修改多個位置
- 截圖：〔25〕
- 掃描結果出來時，所有缺口都已經勾好，最醒目的按鈕是「Complete 9 lines」，按一下就會在 9 個位置補線，大量修改 repertoire（最終新增的葉線數不一定恰好是 9）。
- 每一列只寫「c5 · 31% play it here · hits 30.9% of games」，沒有寫是在哪一手、哪個局面（實際上是 1.e4 之後）。要點進去才知道。
- **建議**：
  - 預設不勾選，或只勾命中率最高的前幾個。
  - 每一列加上局面前綴，例如「1.e4 …c5」。
  - 按鈕文字寫清楚影響範圍，例如「Add replies for 9 positions」。

### P1-11 Scout 加入對手後，Self 仍然是勾選的
- 截圖：〔34〕
- Scout 預設來源是「Self · 2」，但頁面標題是「Scout an opponent」。
- 加入 DrNykterstein 之後，Self 和兩個自己的帳號仍然保持勾選。直接按 Start 的話，報告會把自己和對手的棋混在一起。
- 混合來源是現有的刻意能力，不應自動覆寫使用者明確的選擇。
- **建議**：Start 前提示「目前也包含你自己的對局」，或提供「只看這個對手」的單一入口；是否自動取消 Self 屬產品決策。

---

## P2：不直覺、版面、美觀

### P2-1 視窗高度約 600px 時，Repertoire 右側面板的預設高度不夠
- 截圖：〔23〕〔24〕
- 棋譜樹只顯示約 8 行，Explorer 只顯示 4 列。進入預覽後，多出一條「Previewing … Add to repertoire / Back」橫幅，Explorer 就只剩 **2 列**。
- 樹和 Explorer 各有自己的捲軸，頁面本身也有捲軸，捲動時容易搞錯捲到哪一層。
- 已存在的功能：樹和 dock 之間的分隔線可以拖曳調整高度，收合狀態與高度都會記在 localStorage（`app.js:7391` 起）。但走查時沒有發現這條分隔線可以拖。
- **建議**：
  - 矮視窗時給 Explorer 更合理的預設高度，並讓拖曳把手更容易發現。
  - 預覽橫幅改疊在 Explorer 標題列上，不要額外佔一列。
  - 或者在矮螢幕時，把樹和 Explorer 改成分頁切換。

### P2-2 Toast 擋住內容
- Repertoire：「Editing anti caro」的 toast 剛好蓋在 Explorer 第 4 列的「+」按鈕上〔23〕。
- Scout：「Scouting DrNykterstein」蓋住 Line detail 底部的「No reply in your prep yet — run Deep scan…」〔35〕。
- Library（未登入）：「Sign in to build and train…」壓在 Get started 卡片的邊框上〔01〕。
- Analyze：分析時「Analyzing PGN」toast 和「Analyzing game」卡片同時出現（操作時觀察，沒有截圖）。
- **建議**：
  - toast 避開右側面板的互動區，例如放到頂端中間，或預留安全邊距。
  - 已經有進度卡片的流程，就不要再發 toast。
  - 「Editing xxx」這類純狀態訊息可以不發。

### P2-3 Ctrl+K 的遮罩在暗色主題下變成灰白色
- 截圖：〔13〕
- 打開指令面板時，整個背景被刷成淺灰，而不是變暗。和登入框的暗色遮罩不一致，看起來像畫面當掉。
- **建議**：使用和 modal 相同的遮罩 token。

### P2-4 Analyze 著法列表與 coach 區
- 截圖：〔27〕〔28〕〔29〕〔30〕
- 每一步都是整格深藍底色，目前這步再用亮藍色。整片藍色色塊很重，目前這步不夠突出。
- 綠色「+」是 good 群組的評級符號（`web-src/views/analyze.js:33`），和 `?!`、`?`、`??` 同一套（〔30〕可見）。但「+」在棋譜裡通常代表將軍，又沒有明顯的圖例，很容易被誤解成「加入 repertoire」或將軍。
- 手動下的著法用斜體（variation），在空白棋盤上下第一步也是斜體。
- Coach 區高度固定，短評語時下面留一大塊空白；著法列表卻被擠到要捲動才看得到。
- 載入 PGN 後副標顯示「8 plies」，對一般使用者來說是術語。
- **建議**：
  - 只有目前這步加底色，其他著法用一般文字。
  - good 改用不會和將軍混淆的符號（例如 ✓），或把圖例放在更容易看到的位置。
  - Coach 區高度改成依內容自動調整。
  - 「8 plies」改成「8 half-moves」，或同時寫出回合數。不能固定除以 2，因為從任意 FEN 開始或半步數為奇數時會不準。

### P2-5 Train 面板資訊太多層，其中一條空條是 CSS bug
- 截圖：〔20〕〔21〕
- 卡片進行中，同時出現：
  - 一條上方進度條（藍）
  - 一條灰色空條
  - 「move 1 of 3 in this card」的分段指示
  - 三種計數 chip：1 due／4 new／1 polish／Opening coach · 6/6
  - In a row／Correct／Mistakes
  - 「This session」的色塊
  - 「80% first try」〔20〕／「88% first try」〔21〕
- **灰色空條是 bug**：它是 queue composition bar，`web-src/views/train.js:115` 已經設成 `hidden`，但 `.qbar { display: flex }`（`web-src/styles.css:3006`）蓋掉了瀏覽器的 hidden 規則（核對報告已在線上確認 computed style 仍是 `display:flex`）。修正：補 `.qbar[hidden] { display: none; }`。
- 單位混用：「Correct」、In a row、first try 是**每步**計數，「Card x/6」是**每張卡**計數。結束時寫「7 first-try correct · 1 missed · 1 fixed on retry」：首答共 8 次（7 + 1），fixed 是失誤後修好的子集，多步卡讓 6 張卡對應 8 次首答是正常的。數字沒錯，但沒有標單位，容易讓人以為和 6 張卡對不起來。
- first try 百分比固定用綠色（`styles.css:2996`），數值很低時也一樣。
- **建議**：
  - 先修 hidden CSS。
  - 計數加上單位，例如「7 of 8 moves first try」。若要改成以卡片為單位，需先定義多步卡部分答對、Hint、重排、重試怎麼計分。
  - 百分比的顏色依數值變化。

### P2-6 Train 結束時，「設定」和「結果」疊在一起
- 截圖：〔21〕
- 「Session complete!」下面先出現下一輪的 Smart queue 設定（說明、Blitz 開關、Start），接著才是上一輪的 Card 6/6、進度條、chip、統計。還有「Start」和「New session」兩個開始按鈕。
- 這張截圖拍攝時仍是「Saving…」。目前的完成流程會在取得 summary 後隱藏 setup、舊 progress 與 queue（`views/train.js:213`），所以**這可能是同步中的過渡畫面**，沒有拍到最終的 summary 畫面。
- 可確定的問題是：「Session complete!」標題出現得比結果整理完成更早，等待期間新設定和舊統計混在一起。
- **建議**：同步完成前顯示「Saving your results…」，完成後再出現 summary；補拍最終畫面確認是否仍有重複按鈕。

### P2-7 Train 頁的其他細節
- 棋盤下方的「✓ Saved／• Unsaved changes／Saving…」狀態膠囊在 Train 頁是真實的訓練進度同步，但文案和 Repertoire 編輯一樣，使用者不知道是什麼沒存。建議在 Train 頁改成「Saving training progress…」。〔18〕〔19〕
- Smart queue 的卡片會在不同開局線之間切換，棋盤直接跳到另一個局面，沒有過場，也沒有提示「換到另一條線」。〔19〕〔20〕
- Line rehearsal 的說明是「Play every line … in order」，下面卻顯示 Smart queue 的統計「1 review move ready · 33 new available (up to 4 this session)」。
- 訓練中切換模式（例如切到 Play vs human），目前這一輪 session 會直接結束，沒有確認。已經作答的紀錄仍會在 outbox／server，不會遺失。
- 未登入時，Play vs human 對局進行中，標題會被 Smart queue 的「Sign in to train」蓋掉〔15〕。

### P2-8 Repertoire 右鍵選單沒有標示是哪一步
- 截圖：〔27〕
- 在「Bxe6」上按右鍵，選單打開了，但選取狀態沒有移到 Bxe6，選單標題也沒有寫出是哪一步。危險操作「Delete this move」很難確定作用在哪一步上。
- **建議**：在選單頂部顯示「8. Bxe6」，並高亮該節點；是否同時讓棋盤跳過去是設計選擇。

### P2-9 Games 明細
- 截圖：〔32〕〔33〕
- 「Departure: Ply 2」「matched 2 plies」是術語。ply 2 是黑方第 1 手，建議寫成「1… c5」或「第 1 手黑方：c5」。
- 明細裡的棋譜是一整片文字，不能點。
- in prep 標記其實存在（〔33〕的 e4 是綠色，c5 是 departure 色；〔32〕是 No repertoire，本來就沒有 in-prep 著法），但**圖例顏色和文字實際顏色不一致**：圖例用 accent 藍（`web-src/views/replay.css:96`），棋譜用 good 綠（`replay.css:91`），所以對不起來。
- 迷你棋盤沒有座標。（執黑時有依 `user_color` 翻轉，〔32〕已是黑方視角。）
- **建議**：棋譜改成可以點的 chip，點了就跳到該局面；圖例和標記用同一個顏色；迷你棋盤加座標。

### P2-10 頁面空狀態大片留白
- Games（未登入）：整頁只有一行字，沒有說明這個功能能做什麼〔10〕。
- Teams（未登入）：中間卡片寫「Sign in to create or join a team」，但沒有 Sign in 按鈕〔12〕。
- Library（登入後）：只有 1 個 repertoire 時，下方約 60% 是空白〔22〕。Mastery 進度條 0% 時幾乎看不見，選取的列一直是高亮的藍底。這些是版面問題，不是功能失效。
- **建議**：
  - 空狀態加上一張範例圖或三行說明，並放一個主要按鈕。
  - 只有少量 repertoire 時，Library 下方可以放「最近的訓練」或「下一步建議」。

### P2-11 Scout 報告
- 截圖：〔35〕〔36〕
- **串流時列表一直重新排序**（操作時觀察，靜態截圖無法證明），滑鼠下的列會跳開，很難點到想看的那一條。
- 幾乎每一列都是「SMALL SAMPLE · 1 game」，再加上「MAIN LINE」或「WEAK SPOT」標籤。標籤太多就沒有區辨力。
- 「100%」是 1 勝 0 和 0 負的歷史得分（畫面也有 Small sample 與 W/D/L），數值沒錯，但放在最醒目的位置容易被讀成預測勝率。
- 路線很長（〔36〕有「+12 more moves」）。這是目前的設計：Scout 的目標是對手實際決策的準備路線，不是固定前 N 手的開局表（見 [Scout production ranking](scout-production-ranking.md)）；實作已有 prefix trie、相同路線聚合與分支前綴候選（`web-src/views/scout.js:925`、`1150`），截斷點依 `gamePhase` 決定（`scout.js:503`）。每條路線 n=1 不代表共享的開局決策只出現一次。若路線明顯過長，應檢查 phase 判定，而不是改成固定前 N 手。
- 移除來源後只更新 chips，舊的報告仍然顯示（`app.js:12781`），頁首卻已經是「Self · 2」。
- **建議**：
  - 串流時先固定排序，結束後再重排；或者提供「暫停排序」。
  - 共享前綴做成導航或摘要，保留具體路線與證據；不要直接合併或摺疊單局路線（可能藏掉短戰術）。若要改 selector，需另外比較準備覆蓋率與可行動性。
  - 100% 這類小樣本得分降低視覺權重，或直接寫「1–0–0」。
  - 來源變更後清空報告，或標示為「舊報告」。

### P2-12 側欄展開後可能不會收回（需重現）
- 走查時觀察到：滑鼠移到側欄時會展開（約 200px），點選頁面後，滑鼠還停在側欄上時一直蓋住內容，例如 Scout 的工具列、Teams 的 Directory。
- 但目前程式在點擊導覽項目後會立刻收回（`is-nav-collapsed`，`web-src/rail-nav.js`、`app.js:13742`），直到 pointerleave 才恢復 hover 展開；鍵盤啟動則刻意保持展開。
- 這項先標為**待重現**：若能重現，需要記錄點的是哪個元素、用滑鼠還是鍵盤、以及當時 rail 的 class 狀態。

### P2-13 Teams：重複的文字，以及日期語系
- 截圖：〔37〕〔40〕
- **日期跟著瀏覽器語系走。** `web-src/views/team-invite.js:36` 和 `web-src/views/teams.js:270` 用的是 `toLocaleDateString(undefined, …)`，所以在繁中瀏覽器上會變成「9月30日」（包括 Invite 對話框）；Scout、Replay 則固定用 `"en"`。中文日期本身不是壞掉，問題是全站沒有統一策略。建議訂一套日期 locale／時區策略（一併處理 P1-9 的日期差異）。
- **使用者的顯示名稱。** 「罐頭」是正確的 Google 帳號名稱，不是漏翻譯；英文介面本來就應該能顯示任何語言的名字。自己分享的項目（「anti caro · 罐頭」）可以改成標「You」或省略擁有者；成員列可以補一個「(you)」。
- **重複的文字：**
  - 「Owner」在同一個畫面出現三次：Directory 列、團隊標題、成員列。精簡時要保留足以辨識權限的資訊。
  - 分頁名稱「Members」「Shared repertoires」下面，又各有一個同名的小標題。
  - 底部的「Invite link active · revoke from Invite」在兩個分頁都顯示，而且只是在重述 Invite 按鈕的功能。
  - Members 分頁有兩行說明 Add member 和 Invite 的差別。這段說明有用，但每次都顯示太佔版面，可以改成按鈕的 tooltip，或只在團隊只有 1 個成員時顯示。
  - Incoming shares 的空狀態是三行長句，可以縮成一句，例如「No shared repertoires yet」。
- **建議**：每個分頁只留一個標題；邀請狀態整合進 Invite 按鈕（例如加一個小圓點表示「有效中」）。

### P2-14 其他
- Engine 開啟後，「SF #1」和「#1 4. Qxf7#」重複顯示；調整線數的「− 1 +」沒有標籤〔06〕。
- Analyze 的 PGN 區只有一個文字框，沒有「Load」或「Clear」按鈕。文字一改就會自動載入，使用者可能不知道。
- Generate moves 對話框寫「from this position」，但棋盤被遮罩模糊了，看不到是哪個局面，建議在標題寫出「after 1.e4」。
- Play vs human 的名稱容易誤解成真人對戰。實際上是 explorer 加 Maia，建議改成「Play vs Lichess crowd」或「Human-like sparring」。

---

## P3：細節

1. Create account 分頁的原因條仍然寫「Sign in to import a repertoire」，應改為「Create an account to …」〔03〕。
2. 註冊 modal 沒有呼叫 `checkValidity()`，前端不會擋下「abc@x」這類 email（只檢查密碼長度）。後端 `RegisterRequest.email` 是 `EmailStr`（`auth.py:36`），所以不代表能用無效 email 註冊成功（本次也沒有實際註冊）；問題是錯誤要等送出後才知道。
3. 登入框在「Forgot password?」和按鈕之間有一段空白，框看起來偏長（視覺偏好）。
4. Settings 的「Auto — Lichess not linked, using 1500」語句不太通順，建議改成「Auto · Link Lichess to match your rating; using 1500 for now」。

---

## 已確認修好的項目（相對於 9/30 報告）

- P0-1／P0-2：未登入時，My last game、Link Lichess、Train（Smart queue）、Games、Scout 都會跳登入框，並寫出原因；不再出現 401 JSON 或「not authenticated」。Line rehearsal 例外，見本報告 P0-1。
- P0-3：Games 未登入時顯示「Sign in to use your games」，不再出現矛盾的 Self chip。
- P1-1：點 Explorer 列改成預覽，要另外按「+ Add to repertoire」才會加入。
- P1-2：Invite 不再自動重產連結，改成「Generate new link」主要按鈕加上次要的「Revoke link」。
- P1-5：Coverage 面板內直接有「Turn on Maia analysis & scan」。
- P1-7：登入後會接續 pending action；`signed_in=1` 會被清掉。
- P2-1：登入框有 × 按鈕，點遮罩可以關閉，也會寫出原因。
- P2-2：**在 1280×609 下** Games 改成左右並排。約 1000px 寬的堆疊問題沒有在該寬度實測，待補 982／1024px 驗證。
- P2-5：Repertoire 載入時有骨架畫面。
- P2-6：Explorer 長條依局數縮放。
- P2-7：Generate moves 改成「淺／中／深」並附上預估。
- P2-9：My last game 會自動分析，完成後 coach 給整局摘要，demo 對局不再預先載入。
- P2-11：只有一個團隊時會自動選取，Invite 和 Add member 的差別有說明。
- P2-12：Auto 模式下 Maia 滑桿會停用並顯示實際分數。About 文案已更新。
- P2-14：Library 選單的「Edit in builder」已改名為「Open in Repertoire」。
- P3-3：Ctrl+K 的排序和側欄一致。
- Repertoire 刪除一步時，只剩一張「Move deleted / Undo」卡片，不再重複通知。

---

## 建議修正順序

1. **小而確定的修正：**
   - 顏色欄改成二選一切換（P0-4）。
   - 指令面板的 Enter 加上 `stopPropagation()`，或讓登入框忽略觸發它的 keydown（P0-3）。
   - 補 `.qbar[hidden] { display: none; }`（P2-5）。
   - 訪客的 Line rehearsal 改成登入 CTA（P0-1）。
2. **Explorer 失敗分類（P0-2）。** 先把 auth／token／network／rate limit 失敗和真正的低樣本分開，並標示目前的對手來源；是否對訪客開放 proxy 是另外的產品與 token 決策。
3. **Train 回饋（P1-2、P1-4、P2-5、P2-6、P2-7）。**
   - 回憶卡的 Up next 不顯示答案。
   - 走錯時保留目前的提示等級。
   - 計數加上單位；完成前顯示同步中，完成後再呈現 summary。
4. **統一數字定義（P1-1）。** 定義每個指標的範圍與單位，對齊後端 dashboard 和 Library 列的 due 規則，再讓各頁共用；修正「Reviews clear」文案。
5. **Analyze 語意（P1-5、P1-6）。** 區分「剛才著法的評語」「失誤前的替代著法」「目前局面的 PV」；修正 coach 評估門檻重疊。
6. **矮螢幕、toast、Scout 呈現（P2-1、P2-2、P2-11）。** 保留 Scout 目前的決策準備目標。
7. 其餘 P1／P2／P3。

## 這次沒有測到的範圍

- **其他視窗寬度**：Chrome 視窗是最大化狀態，無法縮小，所以沒有驗證手機寬度，也沒有驗證 982／1024px。
- **Email 註冊與登入**：沒有實際建立新帳號。
- **Import PGN**：會開啟作業系統的檔案選擇器，截圖看不到。使用者在自己的畫面上確認了選擇器有正常出現，但沒有實際匯入檔案。
- **團隊成員視角**：沒有第二個帳號，所以沒有測試加入團隊、以及看到別人分享的 repertoire。
- **動態行為**：登入後空 Library 的停留時間、Scout 串流時的重新排序、Play vs human 整局的 fallback 比例，都是操作當下的觀察，沒有錄影或時序紀錄。

---

## 修訂紀錄

依[核對報告](ux-walkthrough-2026-10-01-verification.md)與程式碼抽查（`4fc3207`）修正。核對報告的程式碼論點經抽查均成立，以下是主要改動：

| 項目 | 原本寫法 | 修正後 |
|---|---|---|
| P0-1 | 缺少 `requireSignIn` | Start 是 disabled（`app.js:10200`），降為 P1 等級，建議改成登入 CTA |
| P0-2 | 登入後即可用；整局都是 Maia；約 44 MB | 還需要 linked Lichess token；整局 fallback 未量測；46.4 MB／44.3 MiB |
| P0-3 | 推測是 form submit，建議 `preventDefault()` | `preventDefault()` 已存在；實際是冒泡到登入框的 document keydown（`account.js:352`） |
| P1-1 | 各頁數字算錯 | 拆成口徑不同、同步時間差、後端範圍不一致三項 |
| P1-2 | 間隔重複效果就沒了；列了五個著法 | 限縮到回憶卡；〔17〕只有三列且都是 new |
| P1-5 | coach 在評論對手（bug） | 符合目前 Self 規則；改為命名／顏色選擇問題，對手失誤提示另列為增強；補上門檻重疊的程式位置 |
| P1-6 | 箭頭畫的是錯的一方 | 箭頭和 coach 是不同時間點，缺少標示 |
| P1-8 | 每次回來都空 | 只有重新整理／重新登入後才空 |
| P2-1 | 收合狀態要記住 | dock 已可拖曳並記住，改為預設高度與可發現性問題 |
| P2-4 | 每一步都有「+」，可能是加入 repertoire | 「+」是 good 評級符號；ply 換算不能固定除以 2 |
| P2-5 | 三條進度條 | 灰色空條是 `.qbar` hidden 被 CSS 覆蓋的 bug；8 次首答與 6 張卡不矛盾 |
| P2-6 | 結束畫面永遠如此 | 截圖時仍在 Saving，可能是過渡狀態 |
| P2-7 | 進度直接被丟掉 | 只結束當前 session，已作答紀錄會保存 |
| P2-9 | 不翻轉、沒有 in-prep 標記；「2… c5」 | 有翻轉、有標記但圖例顏色不一致；ply 2 是 1… c5 |
| P2-11 | 沒有聚合，建議合併前 N 手、摺疊單局 | 已有聚合，長路線是設計；建議改呈現，不改 selector |
| P2-12 | 不會自動收回 | 程式已會收回，改為待重現 |
| P2-13／P3 | 中文名稱像漏翻譯；P3-4、P3-5 | 名稱是正確資料；P3-4 併入 P2-13；`?rep=` 不列缺陷；P3-6 改用英文文案 |
| P2-14 | Explorer 78% 看不出是哪方 | 已有 White／Draw／Black 欄頭，刪除 |
| 其他 | PGN 覆蓋引用 P1-9；「所有入口一致」；1000px 已修好；測試影響「都已還原」；P0「改動都很小」 | 改為 P1-7；改為「大多一致」；改為未實測；分開已還原與保留的寫入；P0 依實際範圍說明 |

未採納核對報告的部分：無重大分歧。核對報告第 4 點提到〔05〕沒有保存 2.Qh5 的評語，本版已將該引文標為文字紀錄。
