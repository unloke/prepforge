# 夜間流水線總結（2026-10-14）

分支 `concept-spatial-probe`，四個 commit，都還沒 push：
`de64e708`（階段 1）、`1b6edb09`（階段 3）、本次總結 commit（階段 4–5）。
Freebuff 與 Codex 的工作檔都在 `artifacts/benchmarks/coach-relations-20261014/`（gitignored）。

## 先看這裡：5207 上要你看的題目

5207 現在是 Round 4（40 題，隨機抽樣、不按候選類型分層）。不必 40 題全做，請先看這 10 題，
Codex 在這些題上抓到錯事實、自己沒把握、沒找到關鍵事實，或者判為非戰術原因：

| 題號 | 為什麼要看 | Codex 的判斷 |
|---|---|---|
| r4-006 | 判了一個 material 為 wrong | 最佳 Bxg3 那串交換只寫「得 兵」，但實際上象被 hxg3 吃回、另外贏了一匹馬，淨值 1 分是對的，構成寫錯。**我核對過，Codex 說得對：這是 enumerator 的交換分段 bug** |
| r4-009 | 判了一個 material 為 wrong | 實戰 Bxd6「黑方淨賺 2 分」只算到變化結束，引擎續著 e5 雙攻後白方大賺。數字本身可以追溯，但有誤導性 |
| r4-007 | 低信心 | 子力活動 vs 得兵，比重不確定 |
| r4-035 | 低信心 | 王的安全；不確定連將求和是否強制 |
| r4-005 | 沒有 key | 子力 / 最佳：Qa4+ 剝奪易位權，接著侵入吃兵 |
| r4-022 | 沒有 key | 子力 / 實戰：f6 讓 Qxe6+，最後丟車 |
| r4-030 | 沒有 key | 王的安全 / 實戰：Qd6 讓 Nb5 等一串先手，黑王失去易位權 |
| r4-024 | 非戰術 | 王的安全 / 實戰：Qxh6 貪兵，Rxg2+ 撕開王翼 |
| r4-036 | 非戰術 | 子力活動 / 實戰：Rh1 讓白車被動 |
| r4-040 | 非戰術 | 子力活動 / 最佳：d5 讓馬佔據前哨格 |

Codex 的完整第一輪標註在 `review/LABELS-r4.codex.json`，與你的 `LABELS-r4.json` 分開存放，
審閱頁不會顯示 Codex 的答案，避免影響你的判斷。重新挑題：
`py research/coach-relations/review/codex_pick.py 4 artifacts/benchmarks/coach-relations-20261014/codex-annot-r4/out`

## 階段 1：Codex 與你的一致度（119 題，Round 2+3）

- 階段 1 修改了三處，已 commit：
  - 有 mate 或 forced_mate 的那條線不再列 enter；
  - king_exposed 的文字改成可以在棋盤上逐格數；
  - Codex 的題包附上引擎在兩條線結尾的續著。
- Codex v2 的結果：

  | 指標 | 數值 |
  |---|---|
  | 主因 kind 一致 | 88/119 |
  | 戰術/局面大類一致 | 113/119 |
  | where 一致 | 88/119 |
  | key vs 非 key：一致率 | 0.78 |
  | key vs 非 key：kappa | 0.56 |
  | key vs 非 key：precision | 0.86 |
  | key vs 非 key：recall | 0.74 |

- 不算 enter 時：kappa 0.60，precision 0.87，recall 0.81。
- 你判 key、Codex 卻判 wrong 的只剩 2 次（v1 有 8 次）。
- 剩下的分歧主要是 material 該算 key 還是 minor，這部分是判斷鬆緊的問題，不是事實錯誤。
- 還不能取代人工。Codex 建議的門檻是：kind/where 一致 ≥ 90%，kappa ≥ 0.8，precision 與 recall
  各 ≥ 90%。目前最可行的用法是讓 Codex 先標註，人只看有分歧的題。
- v2 的 batch3、batch4 筆記是「???」亂碼：PowerShell 把命令列裡的中文轉壞了。R4 的 rubric 已要求
  中文只能寫進檔案，不能放進命令列；這次 R4 的筆記全部正常。

## 階段 2–3：Freebuff v2 做了什麼、哪些偵測器通過

Freebuff（Gemini 4 Argon High，1 小時）在 `freebuff-positional-v2/` 交出：
- `detectors_v2.py`（4 個偵測器）；
- `coach_synthesizer.py`（決策樹加模板）；
- `out/synth_prompt.md`；
- `REPORT_V2.md`。

中途巡邏 5 次，提醒它 2 次：一次是檔案還空著，一次是叫它收尾寫報告。

我在沒評過的牌上逐一用棋盤核對，結果如下：

| 偵測器 | Freebuff 版的問題 | 處理 | 703 張牌觸發 |
|---|---|---|---|
| 邊線孤兵（a/b/g/h） | 用格子比對，所以本來就孤立、只是往前走的兵也被算進去；有將殺的線也會觸發 | 改成按線比對、跳過有將殺的線，抽查全部屬實 → **併入** `pawn_weakness` | 8 |
| 讓出洞／前哨格 | u88kT8Dm 那題的洞其實是後面被戰術吃掉兵造成的，卻算在推兵頭上 | 改成「推的兵是唯一能控制該格的兵」，馬優先於象；r3-011 照樣抓到 → **併入** `pawn_weakness` | 15 |
| 受困子 | 把「先吃子再被吃回」的等價交換當成丟子（tCCTuCwb 的 Bxf6） | 改用靜態交換、把吃到的子算進去；也算進拉開線路造成的攻擊（r3-023 的黑后） → **新類型** `restricted` | 9 |
| 退兵／浪費一步 | 3/6 判錯：被攻擊才退的馬（Nb8 是被 d5 趕的、Nc8 是被 Bd6 攻擊）被說成「沒有防守或威脅的目的」 | **捨棄**（Codex 也建議不做） | – |

- 核對後的事實全部屬實。三個目標題都抓到了：r3-003 孤兵、r3-011 讓出 e5、r3-025 主教被困。
- 卡片層級的壓制仍然有效：有 material 或 mate 的牌不顯示這些局面事實，所以 703 張牌上
  pawn_weakness 從 39 增加到 55，restricted 有 7 張。
- 加入後，Round 2/3 舊評分全部搬移、沒有遺失，新增 9 個候選項。Codex 盲評：key 3（rr-062 的 d3 洞、
  rr-088 的 d5 洞、r3-025 受困象）、minor 3、irrelevant 3、**wrong 0**。你自己的評分欄是空的，
  下次打開 Round 2/3 時會看到這 9 個待評。
- Round 4 的 40 題裡這些新偵測器一個都沒觸發：在隨機抽樣中局面原因本來就少（Codex 判 34/40 是戰術）。
- **Freebuff 的合成器**在 dev 上自評命中率是 87%（戰術 98.6%、局面 70.2%），但程式裡有針對 dev 題號
  特製的分支（例如 rr-038、r3-033、r3-030），屬於樣本內擬合，**不可當真**。它的決策樹順序
  （mate > 和棋資源 > 受困／雙擊／子力 > 殺棋威脅 > 局面）可以參考。

## 階段 4：Round 4 的 Codex 覆蓋率（40 題，代表性抽樣）

- Codex 判的主因：material 24、mate 10、king_safety 3、activity 3；where：played 29、best 8、both 3。
- 有 key 候選：戰術 30/34，非戰術 3/6，合計 33/40；Codex 高信心 38/40。
- 81 個候選項：
  - key 44、minor 10、irrelevant 25、wrong 2；
  - enter 仍是主要雜訊：9 個裡 7 個 irrelevant；
  - material 有 9 個 irrelevant。

## 夜間發生的事

- **標註被覆寫（已還原）**：03:18 時 5207/5208 的舊伺服器還拿著階段 1 之前題組的 sha，
  開著的舊審閱頁把刪減前的 enter 評分存回了 `LABELS-r2/r3.json`。我已從 git 還原，被覆寫的版本
  留在 scratchpad 備查。`serve.mjs` 改為每次請求都重新讀題組，題組重建後舊頁面就存不進來了。
- Freebuff 一開始被一個置頂的系統管理員權限工作管理員視窗擋住（不是我開的）。

## 建議下一步

1. 你先看上面 10 題，再決定 Round 4 其他題是否接受 Codex 的標註。
2. 修 r4-006 的交換分段 bug：Bxg3 … hxg3 是同格延遲回吃，應該併成一串。
3. 「material 只算到變化結束」的誤導（r4-009）：考慮把引擎續著裡的下一串交換也算進去，或至少
   在文字上標明「到這裡為止」。
