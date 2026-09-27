# UI 舒適度審查報告(2026-09-26)

針對「過多解釋、過多按鈕、不協調配置、雜亂畫面、疊加物件層級、卡片留白」的
專項審查。方法:Playwright(Chrome)實機量測 3 種視窗(1440/1180/390)× 明暗主題
× 8 個視圖,加上像素取樣驗證疊加順序、axe 無障礙掃描、靜態 CSS/文案盤點。
量測腳本與原始資料在 `tmp/ui-audit/`(audit.mjs、audit2.mjs、probe-*.mjs、
out/findings.json、out/report2.json)。

先講好消息:axe(wcag2a/2aa/21a/21aa)8 個視圖明暗主題 **0 violations**;
全站無水平溢位、無文字裁切、無互動元素互相重疊、同一工具列控制項高度一致。
以下是會讓使用者不舒服的問題,依嚴重度排序。

## A. 疊加物件層級(最嚴重)

| # | 問題 | 證據 | 建議 |
|---|------|------|------|
| A1 | **Command palette 的暗色遮罩蓋不住 Engine 浮動視窗**。開啟 Ctrl+K 時,engine 視窗以純亮色浮在調色盤的暗背景上,視覺斷裂 | 像素取樣:palette 開啟前後 engine 中心像素皆為 `[255,255,255]`,背景取樣點卻被暗化為 `[139,106,79]`。原因:`.engine-window` z=950(styles.css:5864)> `.palette` z=80(styles.css:7598),同為 body 直屬 fixed,950 永遠畫在上面 | 訂定統一層級表:snap 層(modal=palette=1000)> 浮動工具窗(900)> toasts(800)。或 palette 開啟時暫時隱藏/收合 engine window |
| A2 | **Modal 對話框的遮罩同樣蓋不住 engine 視窗**。開「New repertoire」對話框時,engine 視窗未被暗化且浮在對話框之上 | 像素取樣:engine 中心 `[255,255,255]` 不變,scrim 取樣點 `[163,161,159]` 已暗化;`.modal-overlay` z=60(styles.css:5187)< 950 | 同 A1 |
| A3 | **Engine 浮動視窗會蓋住下方視圖的主要按鈕並攔截點擊**,無自動讓位。Dashboard 的「New」按鈕被 engine 視窗完全遮住 | `elementFromPoint(#dashboard-new-rep 中心)` 回傳 `div.engine-window-pvs`;Playwright click 直接 timeout(`subtree intercepts pointer events`) | 視窗避讓(dodge)或貼邊收合;至少開啟新視圖時自動最小化 |
| A4 | 通知 toast(z=1000)畫在 palette(80)/modal(60)之上,會蓋住對話框右下角的按鈕 | 靜態 z 清單:`toast=1000 > engine=950 > palette=80 > modal=60 > context-menu=30` | toast 降到 snap 層之下;modal 開啟時佇列延後 |
| A5 | z-index 數值各自為政:`1,2,4,5,12,20,30,55,60,80,200,950,1000,1100,1200` 共 15 種,無層級表。skip-link(200)高於 modal/palette 卻低於 engine/toast | styles.css 逐行盤點(123/574/1687/2618/2871/2965/5113/5187/5514/5864/7494/7598) | 抽 `--z-*` token,只允許 5 層;加 stylelint/測試鎖定 |

## B. 行動版導覽與版面

| # | 問題 | 證據 | 建議 |
|---|------|------|------|
| B1 | **390px 下 tab 列溢出**:`scrollWidth 522 > clientWidth 366`,Games/Scout/Teams 三個分頁在畫面外;`scrollbar-width:none` 且無邊緣漸層,完全沒有「可以滑」的提示 | 實測 3 視圖各 tab 的 rect:right 最遠 534px | 小螢幕把次要分頁收進 More/選單,或加邊緣 fade + 自動捲到 active tab |
| B2 | **切到 Teams/Scout 時,active 分頁在畫面外**(`activeVisible:false`,rect 465–534),使用者看不到「我現在在哪一頁」 | `#/teams` 實測 activeRect left=465 right=534,stripScrollLeft=0 | 進入時 `scrollIntoView({inline:'center'})` active tab |
| B3 | 頂欄 7 個分頁同一列平權呈現,無主次之分;`Ctrl K` 以純文字按鈕充當圖示按鈕 | index.html topbar | 主 4 項 + 其餘收納;Ctrl K 改 ⌘/鍵盤圖示 |

## C. 說明文字過多

| # | 問題 | 證據 | 建議 |
|---|------|------|------|
| C1 | **`title` 提示共 50 個**,多數與按鈕可見文字重複或過長:「Analyze game」→"Run a full-game engine analysis on your device"、「Takeback」→"Undo your last move and the opponent's reply"、「Analyze this」→"Open this game in Analyze" | `grep -o 'title="[^"]*"' index.html` = 50 | 只給 icon 按鈕 tooltip;文字按鈕的說明改放首次引導或 ⓘ popover |
| C2 | 「I'm Feeling Lucky」需要 78 字的 title 才能解釋("Jump to a book-departure, engine miss, or repertoire fork — not the starting position") | index.html train-play 區 | 按鈕改名說清楚行為(如「從關鍵局面開始」),或收進選單 |
| C3 | Train 內嵌「How training works」說明抽屜:5 狀態卡 + streak 兩段說明,共 7 個說明區塊 / 680 字,是全站最重的畫面 | 實測 density:train explainerBlocks=7 / explainerChars=680(其他視圖 0–3 塊 / 31–142 字) | 摘成 2 行 + 連結到說明頁;或改成狀態 chip 上的 hover 說明 |
| C4 | 用詞不一致:同一動作「New」(dashboard)vs「Create」(build empty);「Analyze game」vs「Analyze this」vs 導覽「Analyze」;CTA 混用「Start training」/「Start」/「Check my games」/「Start」(scout) | index.html 各 view | 建動詞表:建立 repertoire 統一「New repertoire」;分析類統一「Analyze」 |

## D. 按鈕/控制項密度

| # | 問題 | 證據 | 建議 |
|---|------|------|------|
| D1 | Settings 單屏 **24 個互動控制**(7 switches、2 sliders、3 組 segmented、4 顆 ⓘ、piece picker),無分組摺疊 | 實測 density(settings)=24 | 進階(Maia/深度)收進「Advanced」;ⓘ 說明併回標籤副標 |
| D2 | Train Play 模式兩個按鈕列共 6 顆 CTA:Start / I'm Feeling Lucky / Takeback / Resign / Analyze this / Start over,且「Start」與「Start over」並存易混 | index.html train-play 設定區 + train-progress-panel | 對局中控制(悔棋/放棄/分析)收進 ⋯ 或對局列;Start over 改為 session 選單 |
| D3 | 棋盤列 icon 按鈕(⏮◀▶⏭⇅💡)語意不足,全靠 title;且與 emoji 混用(見 E1) | index.html board-bar ×3 | 改一致的 SVG icon set,tooltip 只留必要者 |

## E. 視覺不協調

| # | 問題 | 證據 | 建議 |
|---|------|------|------|
| E1 | **彩色 emoji 與單色字形混用於同一工具列**:train board-bar 的 ⇅ 是彩色 emoji(取樣 `[64,151,226]` 藍)、💡 是彩色 emoji(`[255,218,150]` 黃)、⏭ 是單色字形(saturation 0)。跨平台渲染不穩 | 像素飽和度取樣(見 tmp/ui-audit/out) | 全站換 SVG/圖示字型;至少加 `font-family` 統一 text presentation |
| E2 | 圓角 7 種並存:`.ib` 3px(styles.css:2992)、`--radius` 4px、`--radius-card` 6px、`.today-card` 硬編 8px(:1436)、`.modal` 8px(:5207)、`.engine-window` 12px(:5864)、`.scout-v13-card` 8px | 靜態盤點 | 收斂為 3 階 token(s/m/l);禁止硬編 |
| E3 | 卡片內距不一致:dashboard/settings 14px、teams 16px、`.team-empty` 28px、games 卡 0px、`.today-card` 14/18px、`.scout-v13-card` 9/11/10/11(不對稱) | 實機量測各卡 computed padding | 統一 `--card-pad`;scout-v13-card 尤其需修正不對稱 |
| E4 | 響應式斷點 10 種混用:520/560/600/640/680/720/760/959/1020/1100 | `grep -n "@media" styles.css`(28 處) | 收斂為 2–3 個 token 化斷點(既有 U6 已點名,實際比記錄更多) |
| E5 | teams 版面節奏不一致:左欄列距 0(intro 直接貼卡片)、右欄 12px;`.team-empty` padding 28 與目錄卡 16 不同 | `.teams-stack` grid `gap: 0 20px`(styles.css:7942)實測 | 行距統一;aside 與卡片同規格 |

## F. 留白/空位

| # | 問題 | 證據 | 建議 |
|---|------|------|------|
| F1 | Analyze 側欄閒置時底部 **207px 空白**,且「Recent analyses」抽屜預設展開但內容為 0(空的展開區塊) | 1180×720 實測:內容止於 y=495,sidebar 底 702;`#history-drawer` open 且 `.analysis-history` 高度 0 | 空清單時抽屜自動收合(或顯示空狀態一句話);底區放 contextual CTA |
| F2 | Coach 卡固定 147px 高,閒置時只有一行提示,其餘是預留空白 | `.explain-card` block-size clamp(為穩定性設計,屬取捨) | 可保留;或閒置時縮為 1 行、有內容再展開(需評估穩定性目標) |
| F3 | Dashboard/Teams 的 hint 段落夾在標題與清單之間,清單空時畫面是「標題+說明+空清單」三段式,缺少行動引導 | index.html dashboard/teams 區 | 空狀態即 CTA(既有 X2 方向) |

## G. 已確認無問題(免再查)

- axe 8 視圖明暗 0 violations(對比、表單標籤、ARIA 全過)。
- 無水平溢位、無文字裁切(`clipped-x/y = 0`)、無互動元素重疊、無控制項高度不一致。
- `.topbar-status-slot` 絕對定位不佔位,長訊息在 1180px 實測不壓 tab;mobile 狀態列固定底部不擋主 CTA。
- 審計中出現的 API 500 為 dev DB 未套用 alembic 遷移(`no such table: user_settings`),
  與 UI 無關;已 `alembic upgrade head` 修復。

## 優先順序建議

1. **P1**:A1–A4(疊加層級,一次修:統一 z 表 + engine window 避讓)、B1/B2(mobile tab 列)。
2. **P2**:E1(emoji 換 SVG)、C1/C2(刪冗餘 title)、F1(空抽屜)。
3. **P3**:D1/D2(密度收斂)、C3/C4(文案)、E2–E5(規格收斂:斷點/圓角/內距 token 化)。
