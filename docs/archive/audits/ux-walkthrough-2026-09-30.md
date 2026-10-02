# PrepForge Chess 實機走查報告（2026-09-30）

- 測試對象：線上 Render 版本 `https://prepforge-w0c5.onrender.com`
- 測試方式：真人式操作（點擊、拖棋、捲動），每一步截圖分析；未登入 → 登入 → 登入後全功能
- 視窗尺寸：
  - 未登入前半段：Chrome，1280×609（桌面版排版）
  - 其餘：Claude 內建瀏覽器，982×614（窄桌面／平板排版；這個寬度沒辦法再放大）
  - 寬螢幕的完整桌面排版只在前半段看過，建議之後用全螢幕 Chrome 補測一次
- 截圖：`docs/review-assets/2026-09-30-ux-walkthrough/`
- 測試帳號：罐頭（Google 登入），已連結 Lichess 帳號 unbrainless87 與 Anonymousub

> 測試過程中對資料的影響（都已還原或屬無害）：
> - 在「anti caro」加了一步 Be7 後已刪除，回到 18 lines／81 moves。
> - Train 完成了一輪 4 張卡（今日 streak +1、4 個 new 變成 learning）。
> - Teams「magnus」的邀請連結被重新產生（點「Invite」就會自動重產，見 P1-4）。舊連結已失效。
> - Games／Scout 的外部來源 DrNykterstein：Games 已移除；Scout 仍保留（Self 被取消勾選），需要時請自行恢復。

---

## 總結

| 等級 | 數量 | 說明 |
|---|---|---|
| **P0 功能壞掉** | 3 | 未登入時點到需要帳號的功能，出現原始 JSON 或「not authenticated」，而不是登入引導 |
| **P1 會誤操作／誤導** | 7 | 點一下就改到資料、文案自相矛盾、重要回饋在畫面外 |
| **P2 不直覺／版面** | 14 | 版面利用率、元素大小、資訊層級、術語 |
| **P3 細節打磨** | 10 | 文案、無障礙、一致性 |

最大的結構性問題有兩個：

1. **未登入的「權限閘門」不一致。** 同一類「需要帳號」的動作有三種反應：
   - 正確彈出登入框：New repertoire、Import PGN、New team、Analyze 按鈕、在 Repertoire 下棋。
   - 只跳紅字「not authenticated」：Train、Games、Scout。
   - 打開彈窗只顯示 401 JSON：My last game、Link a Lichess account。
2. **約 1000px 寬時，排版變成「棋盤在上、面板在下」的上下堆疊。** 幾乎每個功能的關鍵回饋都掉到畫面下方，要捲動才看得到：
   - Train 的對錯提示
   - Games 的明細
   - Repertoire 的 Explorer
   - Analyze 的 coach 評語

   使用者常會以為「按了沒反應」。

---

## P0 — 功能壞掉

### P0-1「My last game」與「Link a Lichess account」在未登入時打開 401 JSON 彈窗
- **重現**：未登入 → Analyze → My last game（或 Settings → Link a Lichess account）。
- **現象**：彈出新視窗 `/api/lichess/login`，內容只有 `{"detail":"not authenticated"}`（就是你截圖看到的那個）。原分頁顯示「Opening Lichess sign-in...」，之後沒有任何後續。
- **原因**：
  - `web-src/app.js:4700` 的 `fetchMyLichessGame`：沒有連結 Lichess 時直接呼叫 `startLichessOAuth()`，沒有先檢查 `appState.signedIn`。
  - `web-src/controllers/account.js:577` 的 `startLichessOAuth` 本身也沒有登入檢查。
  - 但後端 `/api/lichess/login` 要求必須已登入。
- **建議**：在 `startLichessOAuth` 開頭加上 `if (!appState.signedIn) { openAuthModal("login", { notice: "先登入，再連結 Lichess" }); return; }`。未登入時，Settings 的 Link 按鈕也應改為「Sign in to link Lichess」。

### P0-2 Train／Games／Scout 未登入只顯示「not authenticated」
- 截圖：`02-train-not-authenticated.jpg`、`04-scout-not-authenticated.jpg`
- **Train → Smart queue → Start**：
  - 右下紅色 toast「not authenticated」。
  - 標題同時變成「Nothing to train yet — Add prepared moves in Build, then train.」，讓人以為問題是沒有 repertoire。
  - 文案還在用舊名稱「Build」，側欄已改名為「Repertoire」。
- **Games → Check**：同樣的紅色 toast。
- **Scout → Start**：頁面上方出現紅框 banner「not authenticated」，原本的空狀態說明被整個取代。
- 這個紅色 toast 換頁也不會消失：從 Games 切到 Scout 還在。
- **建議**：
  - 這三個入口都比照 `createTeam()`（`app.js:4987`），先做 `if (!appState.signedIn) openAuthModal(...)`。
  - API 回 401 時，統一轉成「登入框＋說明」，不要把後端字串直接顯示給使用者。
  - Train 的 Line rehearsal 在未登入時下拉選單顯示「Build a repertoire first」，也應改成登入引導。

### P0-3 Games 的來源 chip 與錯誤訊息互相矛盾
- 截圖：`03-games-source-contradiction.jpg`
- 未登入時 chip 顯示「Self · all linked」（看起來是已選取），但按 Check 卻得到「No Games sources selected — open Add and pick one.」。打開 Add 又顯示「0 accounts」。
- 登入前加的外部來源（DrNykterstein）在登入後會自動帶進帳號的 Games 與 Scout，使用者不會預期這件事。
- **建議**：未登入時隱藏 Self chip，或改成「Sign in to use your games」。

---

## P1 — 會誤操作或嚴重誤導

### P1-1 在 Explorer 點一列，就會直接把那步加進 repertoire
- 截圖：`07-explorer-click-adds-move.jpg`
- 在 Repertoire 頁點 Explorer 的「Be7」這一列，repertoire 立刻從 18 lines／81 moves 變成 19／82，並顯示「Saved」。
- 窄版時棋盤在畫面外，使用者完全不會察覺自己改了資料。
- 大部分人會把 Explorer 當「看資料」的地方，點一下應該是預覽（走到該局面），加入 repertoire 應該要另外的動作（例如「+」按鈕或雙擊）。
- 刪除那步後會同時出現兩個通知：右下 toast「Deleted Be7」和一張「Move deleted / Undo」卡片，而且蓋住 Explorer。

### P1-2 Teams 點「Invite」就自動重產邀請連結，舊連結作廢
- 截圖：`15-teams-invite-regenerates.jpg`
- 彈窗寫著「…replaces any previous link」，但連結在打開彈窗的當下就已經換掉了。只是想看看或複製舊連結的人，會把已經發出去的連結弄失效。
- 彈窗裡最醒目的是紅色「Revoke」，主要動作「Copy」只是純文字按鈕，視覺層級反了。
- **建議**：
  - 打開時先顯示現有連結的狀態，提供「Generate new link」按鈕，產生前要確認。
  - 「Copy」改成 primary 按鈕，「Revoke」降級成次要的 danger 按鈕。

### P1-3 Library 的承諾與實際行為不符
- Library 的 Get started 寫著「Analyze a game — Engine review and coach notes work before you sign in」。實際上，未登入時在 Analyze 按「Analyze」（整局分析）會直接跳出登入框。
- 程式其實有設定說明文字（`app.js:5917` 的「Sign in (or create an account) to analyze and save games」），但被登入框的遮罩蓋住，使用者看不到。
- **建議**：二選一。
  - 讓未登入也能做整局分析，只是不存檔。
  - 或改文案，並讓登入框本身顯示原因（見 P2-1）。

### P1-4 Library 頂部的狀態與實際佇列矛盾
- 截圖：`06-library-signed-in.jpg`
- 頂部寫「Trained today – day 2 ✓ / Queue is clear」，同一頁的 repertoire 列卻顯示「41 new」。
- 使用者會不知道到底還要不要練。
- **建議**：寫成「Reviews clear · 41 new moves to learn」，並讓 Train 按鈕直接開始學新招。

### P1-5 Coverage 掃描的阻擋訊息被截斷，也沒有連結
- 截圖：`08-coverage-truncated-toast.jpg`
- 按 Scan 後只出現一個會消失的 toast：「Coverage needs Maia analysis — turn it on in Settings → Playing stren…」。文字被截斷，也沒有按鈕可以直接過去。
- 更讓人困惑的是，Settings 裡 Maia3 顯示「Ready（44 MB cached）」，但「Maia analysis」開關卻是關的。使用者會以為 Maia 已經可以用了。
- **建議**：
  - 在 Coverage 面板內直接顯示「需要開啟 Maia analysis」和一個「開啟」按鈕。
  - 或者在 Maia 已 Ready 時，Scan 自動啟用 Maia。

### P1-6 Analyze 的 coach 評語文法破碎、語意自相矛盾
- 截圖：`12-analyze-coach-text.jpg`
- 實際文字：「A costly blunder, this one. a3 hands over the initiative. After d5, claiming the centre, and now eyes the bishop on c4, That leaves Black about level. Bd6 kept it simple, keeping White a little better.」
- 問題有三：
  - 句子斷裂：「After d5, claiming …, and now eyes …」沒有主要子句。
  - 逗號後面接大寫的「That」。
  - 同一段話先說是「costly blunder」，又說「about level」，再說「White a little better」。
- 這位使用者執黑，這步 a3 是對手下的。「Review my moves」開著時，卻在評論對手的失誤。
- Train 的 coach 提示每一步都是同一句「Develop your pieces, occupy the center, and get the king safe.」，連 f3 這種非出子的著法也一樣，看起來像預設文字。

### P1-7 登入後沒有接著完成原本的動作
- 我在 Library 按「New repertoire」→ 跳出登入框 → 你用 Google 登入後，回到的是 Library 首頁，原本要做的「新增 repertoire」沒有接續。
- 網址還留著 `?signed_in=1`，之後所有頁面的網址都帶著它（還有 `?rep=…` 跨頁殘留，例如 `#/teams?rep=…`）。
- **建議**：記住被登入框打斷的動作（例如 `pendingAction`），登入後自動接續。登入完成後清掉 `signed_in` 參數。

---

## P2 — 不直覺、版面與大小

### P2-1 登入框
截圖：`01-signin-modal.jpg`

- 沒有 × 按鈕，點遮罩也關不掉，只有 Esc 有效。滑鼠使用者會覺得「被困住」。
- 不說明為什麼跳出來。`controllers/account.js:142` 其實支援 `notice` 參數，但 `app.js:4350` 的包裝函式沒有把它傳下去。只要把 notice 傳到底，每個入口就能顯示「登入後即可建立 repertoire／開始訓練…」。
- 原因只出現在右下的 toast，而 toast 被遮罩壓暗、幾乎讀不到。
- 「New here? Create account」看起來像普通文字，看不出可以點。
- 註冊表單出現錯誤訊息時，整個框會上下跳動。

### P2-2 約 1000px 寬時，所有「棋盤＋面板」頁都變成上下堆疊
截圖：`05-train-narrow-layout.jpg`、`10-train-session.jpg`、`13-games-detail-below-fold.jpg`

- 這是筆電分割畫面、或 1920 螢幕開半個視窗時的常見寬度。目前的切換點太早。
- **Train**：
  - 進入頁面時只看得到棋盤，Start 按鈕在畫面下方。
  - 訓練中的「Not that one — try again」和進度也在畫面外，只能靠棋盤上的箭頭猜發生了什麼。
- **Games**：點一列後明細出現在表格下方，畫面沒有任何變化，看起來像按了沒反應。
- **Repertoire**：在棋譜樹點一步時看不到棋盤。點 Explorer 時棋盤也在畫面外（這正是 P1-1 會被忽略的原因）。
- **Analyze**：點評估曲線跳到失誤，coach 的評語和棋盤都在上方。
- **建議**：
  - 把雙欄的切換點往下調（例如 ≤ 860px 才堆疊）。
  - 或者在堆疊模式下縮小棋盤（例如高度上限設為 viewport 的 55%）。
  - 或者把棋盤做成 sticky。
  - Games 點列後自動捲動到明細。

### P2-3 巢狀捲動
- Repertoire 頁有三層捲動：頁面本身、棋譜樹、Explorer。Analyze 頁有兩層：頁面和著法列表。
- 滑鼠停在著法列表上捲動時，頁面不動、列表在動，會覺得「捲不下去」。

### P2-4 Library 的版面利用率
- 未登入時，所有內容擠在畫面上方約三分之一，下方全空。
- 登入後只有 1 個 repertoire 時也一樣。
- Mastery 進度條很細、0% 幾乎看不見，而右側的「⋯」選單卻很大。
- 列上寫「41 trainable moves」，進入 Repertoire 卻寫「18 lines · 81 moves」，兩種計數方式沒有說明。

### P2-5 Repertoire：打開很慢，沒有載入回饋
- 點 repertoire 後網址馬上換成 `#/build?rep=…`，但畫面停在 Library 約 3–5 秒，只有右下一個小小的「Loading repertoire」。
- **建議**：立即切換頁面，並顯示骨架畫面（skeleton）。

### P2-6 Explorer 長條圖可讀性
- 只有 1–3 局的著法，長條一樣佔滿整列寬度，視覺上和 1.3M 局的著法一樣有份量，容易誤導。
- 很窄的區段沒有百分比標籤。
- 灰色的和棋段在暗色主題下和背景太接近。

### P2-7 Generate moves 對話框術語太多
截圖：`09-generate-dialog.jpg`

- 「Ply depth (1–12)」、「Your-move branches per node」、「balanced – recurse, 10% / 30% thresholds」都是工程術語。
- 沒有預估會新增多少步。
- 這種會大量改動 repertoire 的動作，按下去之前應該要能知道影響範圍。
- **建議**：
  - 改成「深度：淺／中／深」。
  - 加上預估，例如「約新增 20–40 步」。
  - 進階參數收進摺疊區。

### P2-8 Scout 報告：「lines」表格無法閱讀
截圖：`14-scout-lines-wall.jpg`

- 每一列都是整盤棋（19 回合）的等寬字長段落，實際上是單一盤棋，不是開局線，所以「Their score 100%」只是一盤的結果。
- 「TYPE · LAST SEEN」欄是空的。
- W/D/L 長條是單一白色條，沒有分段也沒有數字。
- 「Run Deep scan」是一行孤立的文字，看不出能不能點。
- 串流進行中，右上角「66 games」和左側「59 games analyzed」數字不一致。
- 上方摘要區資訊密度很高：粗體段落、5 個 chip，還有小寫的「System kia」。
- **建議**：
  - lines 只顯示到偏離點或前 8–10 回合。
  - 樣本少於 3 盤時標示「樣本少」。
  - W/D/L 改成三段式長條。

### P2-9 Analyze：整局分析的流程與覆蓋
截圖：`11-analyze-progress-overlap.jpg`

- 「My last game」載入對局後，還要再按一次「Analyze」才會分析（toast 寫「press Analyze」）。這兩步可以合成一步。
- 分析進行中，原本的著法列表消失，換成「Play on the board, or analyze a PGN.」佔位文字，看起來像對局不見了。
- 分析進度卡片和「Analysis ready」卡片蓋住評估曲線的右半部。
- 分析完成後，coach 仍顯示「Make a move and I'll tell you what I think.」，沒有整局摘要。
- 一打開 Analyze，標題就顯示 demo 對局「PrepForge vs Demo · 1-0」，但棋盤是空的。demo PGN 已經預填在來源框裡，卻沒有載入到棋盤上。
- 「Analyze source · PGN」分析完後仍然展開，佔掉大量空間。

### P2-10 Train 面板
- 同時出現兩條進度條（藍色部分、紫色全滿），沒有標示各自代表什麼。旁邊的 67% 也沒有說明。
- 「In a row／Correct／Mistakes」三個統計方塊尺寸過大，比棋盤提示還搶眼。
- 每輪只有 4 張卡（41 個 new 裡面），開始前沒有說明這一輪有幾張。
- 結束畫面「Session complete!」出現兩次（標題和小標）。
- 結束後棋盤停在某個中途局面，不是最後一步。
- 「Press Start to begin」同時出現在面板標題和棋盤下方，Start 按鈕又再出現一次，重複了三次。

### P2-11 Teams
- 只有一個團隊時不會自動選取，畫面中間是一大塊「Choose a team」空白。
- 「Invite」（連結）和「Add member」（帳號）並列，差別沒有說明。
- 鉛筆和垃圾桶 icon 沒有文字或 tooltip。
- 「Incoming shares — Click to open (read-only).」在沒有資料時仍然顯示「Click to open」。未登入時則完全沒有空狀態說明。

### P2-12 Settings
截圖：`16-settings-maia.jpg`

- 「Auto — match my Lichess rating (~2377)」打開時，下方 Maia3 strength 滑桿顯示 2400、而且看起來可以拖動。應該停用滑桿並顯示 2377。
- Maia3「Ready」和「Maia analysis」關閉的關係不清楚（見 P1-5）。
- 帳號區塊載入時，會先閃出未登入狀態的「Link a Lichess account」按鈕，3–5 秒後才換成正確內容。
- About 寫著「local opening preparation and replay tool」，和現在的 SaaS 定位不符。
- 頭像選單裡的「Account」和「Settings」都導向同一頁。

### P2-13 Toast 系統
- 錯誤 toast 會跨頁停留（見 P0-2）。
- 長文字會被截斷（見 P1-5）。
- 有時右下角會留下一個空的小膠囊（toast 容器殘影）。
- 同一件事會同時出現 toast 和卡片兩種通知（刪除步數、分析進度）。

### P2-14 Repertoire 右上「⋯」選單與 Library 的「⋯」選單內容不同
- Library 的選單有：Start training／Edit in builder／Rename／Share link／Share with team／Disable／Delete。
- Repertoire 頁的選單只有：Rename／Export PGN／New repertoire。
- 同一個物件、同一個圖示，提供的功能卻不同。另外「Edit in builder」還在用舊名稱。

---

## P3 — 細節打磨

1. 側欄收合時，icon 沒有 tooltip 或 aria-label；只有滑鼠移上去展開時才看得到名稱。展開後的選單會蓋住棋盤，點完之後也不會立刻收回。
2. 登入框的 Email／Password 輸入框，在無障礙樹裡沒有關聯的 label。
3. Ctrl+K 指令面板的順序（Library、Analyze、Repertoire）和側欄順序（Library、Repertoire、Analyze）不一致。
4. Repertoire 頁未登入時下一步棋，toast 寫「Cancelled – playing the move would create a new repertoire」，但使用者還沒有做任何選擇。
5. Analyze 剛下的一步，在棋盤下方標示為「1. e4 · variation」，在空白棋盤上下第一步就被稱為「variation」，很奇怪。
6. Scout 空狀態的文案「…when they play X, you play Y.」在這個寬度下，「Y.」會單獨換到下一行。
7. Games 表格：「1/2-1/2」在窄欄裡斷成兩行。每一列都重複顯示帳號名「Anonymousub」，有點雜訊。沒有日期欄。
8. Games 的分類「Opponent novelty @ Ply 2」：對手第 2 個半步就沒有走 c6，與其說是 novelty，不如說是「不同開局／不在範圍」，標籤用詞有點誇大。
9. 「Analysis quality: Stockfish depth 16 · no Maia — no-maia」把內部代號「no-maia」直接露出給使用者。
10. 棋譜樹裡剛加入的步（例如 Be7）被選取時，是灰字配藍底，對比不足。

---

## 正常運作的部分（不需要動）

- 未登入時：Analyze 下棋、coach 即時評語、瀏覽器 Stockfish（16/16，很快）、Play vs human、主題切換（亮／暗都正常）、Ctrl+K、表單驗證都正常。
- 登入時：
  - Google 登入一次就成功。
  - Library 的 streak 區塊清楚。
  - repertoire 的右鍵選單分類清楚（Position／Branch／Annotate／Export／Danger），刪除有 Undo。
- Train 的回饋邏輯正確：
  - 新步會先示範箭頭。
  - 走錯會退回，並給出正解箭頭。
  - 結束畫面的 Mastered／Learning／Due／Weak／New 統計很清楚。
- 整局分析大約 13 秒完成，評估曲線上的點可以直接跳到該步。
- Games 的「You diverged on ply 3 Nc3 (expected d4). Already in your training queue.」是全站最好的一段文案：具體、可行動。
- Scout 的串流體驗（邊抓邊出報告、可以 Stop／Resume）方向正確。

---

## 建議修正順序

1. **統一登入閘門（P0-1、P0-2、P0-3、P1-3、P2-1）。** 做一個 `requireSignIn(reason)`，所有需要帳號的入口都呼叫它。它會打開帶有 notice 的登入框，登入後自動接續原本的動作（同時解決 P1-7）。API 回 401 時一律走這個流程。這一項就能消掉大部分「未登入很卡」的體感。
2. **防止誤改資料（P1-1、P1-2）。** Explorer 點一下改成預覽；Invite 不要在打開時自動重產連結。
3. **窄桌面排版（P2-2、P2-3）。** 調整雙欄的切換點，或縮小／固定棋盤。
4. **文案與狀態一致性（P1-4、P1-5、P1-6、P2-9、P2-10）。**
5. 其餘 P2／P3 項目。

## 建議補測

- 用全螢幕 Chrome（≥ 1440px）重新走一次登入後的流程，確認寬螢幕雙欄排版下 P2-2 是否消失，並檢查寬螢幕特有的留白比例。
- 手機寬度（375px）：有底部 tab bar，這次沒有深入測試。
