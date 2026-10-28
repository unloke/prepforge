# PrepForge Chess

建立開局棋譜、練熟準備過的走法，再用實戰找出下一個要補的缺口。

[開啟 PrepForge](https://prepforge-w0c5.onrender.com) · [開始使用](getting-started.md) · [文件目錄](README.md) · [English](../README.md)

[![CI](https://github.com/unloke/prepforge/actions/workflows/ci.yml/badge.svg)](https://github.com/unloke/prepforge/actions/workflows/ci.yml)
[![授權：AGPL-3.0-or-later](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue)](../LICENSE)

![Caro-Kann 棋譜工作區：棋盤、開局分支與 Explorer 對局統計](assets/repertoire-desktop.png)

PrepForge 把開局準備、間隔複習與賽後檢查放在同一個網頁應用。
把要下的路線存進棋譜，練習自己的回應，再對照 Lichess 實戰，檢查忘記的走法與尚未準備的局面。

Stockfish 在你的裝置上評估局面；Maia3 依指定棋力預測人類的走法。
兩者都在瀏覽器執行。

## 可以做什麼

### 建立與補齊棋譜

直接在棋盤走棋，或匯入 PGN。整理主線與分支，加入註解、箭頭和標記。
在 Explorer 查看 Masters、Players 的對局資料與引擎候選，從目前局面產生延伸路線。
Coverage 會找出缺少的回應；先預覽，再選擇要加入的準備。

### 練熟自己的回應

FSRS 依作答紀錄安排複習。Due queue 集中待練走法，Rehearse 逐線演練，
Practice 則能與 Maia、Lichess Explorer 或自己的棋譜對弈。
需要時使用提示、重練錯題，或開啟限時 Blitz 訓練。

### 檢查實戰偏離

Games 對照 Lichess 對局與你的棋譜，區分忘記準備、對手新招，以及尚未覆蓋的局面。
直接跳到偏離處，複習原本要下的走法，或把整局帶進 Analyze。

### 分析關鍵局面

貼上 PGN 後，從輸入框右下角選 Open PGN；也可載入最近的 Lichess 對局或練習對局。
按 Analyze 查看走法分類、評估曲線與轉折點。
探索引擎及人類候選變化後，可以返回原局繼續檢查。

### 針對對手準備

Scout 讀取對手的 Lichess 對局，依執子顏色與棋速篩選，找出值得檢查的開局路線。
開啟路線詳情、轉入分析，或加入自己的棋譜。
Deep scan 會用引擎尋找對局中的失誤與反駁。

### 分享棋譜

對個人或團隊設定 View only、Can copy、Can edit 權限。
公開連結可設為僅瀏覽或允許複製；個人的訓練進度歸屬於該玩家。

<details>
<summary>訓練與手機畫面</summary>

![訓練首頁：待練佇列、路線演練與練習對局](assets/train-desktop.png)

<img src="assets/repertoire-mobile.png" alt="手機寬度下的棋譜工作區" width="300">

</details>

以上是目前版本搭配示範資料的實際畫面；[擷取方式](assets/README.md)另有記錄。

## 在本機啟動

準備 Python 3.11、Node.js 22 與 [uv](https://docs.astral.sh/uv/)，在專案根目錄執行：

```sh
uv sync --python 3.11 --extra server --extra dev
npm ci
npm run build
uv run alembic upgrade head
uv run uvicorn prepforge_chess.api.main:app --reload
```

開啟 [localhost:8000](http://127.0.0.1:8000)。本機預設使用 SQLite，
遷移指令會建立資料表。修改 `web-src/` 後需重新建置。

Maia3 模型權重需要另外設定。依 [.env.example](../.env.example) 與
[模型設定](DEPLOYMENT.md#hugging-face-asset-pin-required-in-production)
指定 `PREPFORGE_MAIA3_ASSET_BASE`。首次使用引擎會下載所需資源，
裝置記憶體與瀏覽器支援會影響可用設定；應用伺服器會提供引擎需要的跨來源隔離標頭。

## 執行架構

| 元件 | 執行位置 | 用途 |
| --- | --- | --- |
| JavaScript SPA／Vite | 瀏覽器 | 棋盤、棋譜編輯與各工作區 |
| Stockfish／WASM | 瀏覽器 | 局面評估與候選路線 |
| Maia3／ONNX | 瀏覽器 | 人類走法預測與練習對手 |
| FastAPI | 伺服器 | 帳號、驗證、走法分類、分享與同步 |
| PostgreSQL／SQLite | 伺服器 | 棋譜、對局、分析與訓練進度 |

引擎搜尋與模型推論在裝置端執行；帳號與儲存的內容使用 API 和資料庫。
對局與 Explorer 資料來自 Lichess，模型權重另外下載。

## 文件與參與

- [開始使用](getting-started.md)：建立第一份棋譜、練習與檢查對局。
- [開發指南](development.md)：環境、檢查指令、程式目錄與儲存設計。
- [部署指南](DEPLOYMENT.md)：Docker、正式環境設定、模型與維運。
- [技術文件](README.md#implementation)：引擎、Scout 排序、儲存與訓練歸屬。

回報問題或提出功能需求，請[開啟 Issue](https://github.com/unloke/prepforge/issues)，
附上所在工作區、重現步驟、預期結果與瀏覽器；附件請移除私人對局或帳號資訊。
提交程式修改前，執行[相關範圍的檢查](development.md#validation)。

## 授權與致謝

PrepForge Chess 採用 [AGPL-3.0-or-later](../LICENSE)。
使用了 [Stockfish](https://github.com/official-stockfish/Stockfish)、
[Maia](https://www.maiachess.com/)、[Lichess](https://lichess.org/)、
[chess.js](https://github.com/jhlywa/chess.js)、
[python-chess](https://github.com/niklasf/python-chess) 與
[FSRS](https://github.com/open-spaced-repetition/py-fsrs)。
