# Scout 下一輪演算法研究（offline，2026-09-22）

本研究**未修改 production ranking**。目前入口仍是 `web-src/scout-selector.js` 的
`scout-v2` / `rankGamePlan`。資料、Maia policy cache、逐切分結果及 Stockfish WDL
結果都在本目錄；模型權重不納入 commit。

## 1. 目前失真的根因

`rankGamePlan` 先按 Maia *結果分數*（`maiaScorePct`）排序，再按
`ancestorFrequency × terminal Stockfish edge × empirical struggle` 排序。
它沒有直接估計「在此局面此玩家下一手會怎樣走」，也沒有沿路線檢查 WDL
是否一直對我方有利。高終點優勢可能由一個低機率失誤造成；父節點的出現
頻率也不能代表深線會被走進。現有 v13 設計已指出 trie 節點同時充當證據
錨點及輸出路線所造成的祖先／後代重複與淺路線問題。完整路線重複
不能作為個人化的門檻。

## 2. 方法比較與來源

| 方法 | 可直接借用 | 不適合直接用作 PrepForge ranking |
| --- | --- | --- |
| [Maia-3](https://github.com/CSSLab/maia3) | rating-conditioned 合法走法分布，作 population prior；本輪實測 23M fp16 | 單靠群體平均無法辨識玩家偏好；Maia 的結果 WDL 不是 Stockfish 壓力 |
| [maia-individual](https://github.com/CSSLab/maia-individual) | 以時間分離玩家資料，測個人 fine-tuning 的預測增益 | 每名玩家都訓練模型成本高；10–80 局時過擬合風險須先量測 |
| [Maia4All](https://github.com/CSSLab/maia4all) / [論文](https://arxiv.org/abs/2507.21488) | 少樣本個人化構想，可作後續 challenger | 公開 repo README 仍標 WIP，沒有穩定推論／重現介面；本輪不接 production |
| [outprep harness](https://github.com/dscape/outprep) | profile/held-out 分離、move match 和 coverage；本輪採 chronological split | 其 Boltzmann 模仿與 bot 目標不等於少量持續壓制 prep routes |
| [Lichess opening explorer](https://github.com/lichess-org/lila-openingexplorer) | player-position 聚合、轉位後依局面查證據 | 單純 player-position count 在稀疏局面不能取代 Maia prior |
| [CTW](https://research.tue.nl/en/publications/the-context-tree-weighting-method-basic-properties/), [PPM](https://pascal-francis.inist.fr/vibad/index.php?action=getRecordDetail&idt=9574279&lang=en), [AKOM/CPT+](https://www.philippe-fournier-viger.com/spmf/index.php/index.php?link=algorithms.php) | variable-order 回退是可檢驗的 sequence baseline | 裸走法 suffix 忽略棋盤合法性、轉位與我方反事實準備手；不宜主導 ranking |
| [Stockfish WDL model](https://github.com/official-stockfish/WDL_model) | 同一引擎／深度下比較整段壓力、單步失誤與替代回應 | 它校準引擎自我對局，不直接代表人類感受難度 |

## 3. Harness、資料與定義

三名公開 Lichess 玩家：EricRosen 100 局、DrNykterstein 100 局、
penguingm1 29 局。從最舊起的 10／20／40／80 局建 profile，
後續至多 20 局測試，開局前 16 ply。第三名僅有 10 局切分。
Maia rating 分別設 2550／3000／1500（第二名樣本中位數超過 3000，
故使用 3000）；位置以 EPD cache，推論不使用 held-out 走法標籤。

比較四種有效候選及一種 smoke：

- `maia`：rating-conditioned Maia-3 policy。
- `exact`：玩家 full-prefix counts + 弱的跨玩家先驗，僅 empirical baseline。
- `suffix`：4-ply suffix counts，僅 variable-order smoke baseline。
- `maiaResidual`：`(n_move + 8 × P_Maia(move|position,rating)) / (n_position + 8)`；
  小樣本自然回退 Maia。這是最簡單個人 residual，不宣稱已是最佳形式。
- `population`：跨玩家、只依 ply parity 的 move count，**僅 smoke**，
  不是有效 population policy。

每個玩家／切分輸出 top-1、top-3、top-5、log loss、Brier。prep route
候選不要求完整線重複；只由訓練局的合法前綴產生，保留 5 條去祖先重複
路線。主要 prep usefulness 是：held-out 棋局到達推薦路線的
**opponent-to-move 局面**時，該 decision point 的 route move 命中、
model top-1/3/5 覆蓋、covered decisions/game、false-prep rate。
這仍是觀測到的局面條件評估；我方若改走準備手，未走進的反事實分支
必須用後續模擬／真人測試。完整 UCI 前綴命中只列 `strictFullLineGameHit`
診斷，**不作主要 usefulness 指標**。

逐線 Stockfish 19 lite、depth 10、UCI WDL（我方視角）輸出：我方走後
WDL 的 10% floor、WDL ≥ 0.55 的比例、最大單步對手 WDL 惡化、
其占全線淨收益比例，以及在我方準備手後 Maia 前三個且 p ≥ 0.05
回應維持 WDL ≥ 0.55 的機率加權比例。引擎與深度是研究煙測，
需以 production 引擎／深度重跑。

重現：

```powershell
node scripts/scout-offline-benchmark.mjs research/scout-benchmark/data/ericrosen.json research/scout-benchmark/data/drnykterstein.json research/scout-benchmark/data/penguingm1.json --maia-cache research/scout-benchmark/maia-cache/maia-ericrosen.json --maia-cache research/scout-benchmark/maia-cache/maia-drnykterstein.json --maia-cache research/scout-benchmark/maia-cache/maia-penguingm1.json --out research/scout-benchmark/move-results.json
node scripts/scout-wdl-benchmark.mjs research/scout-benchmark/move-results.json --maia-cache research/scout-benchmark/maia-cache/maia-ericrosen.json --maia-cache research/scout-benchmark/maia-cache/maia-drnykterstein.json --maia-cache research/scout-benchmark/maia-cache/maia-penguingm1.json --out research/scout-benchmark/wdl-results.json
```

## 4. 初步結果

最大 profile 切分（第三人為 10 局），每格為 top-1 / top-3 / log loss：

| 玩家；profile/test | Maia | empirical exact | Maia + residual |
| --- | ---: | ---: | ---: |
| EricRosen；80/19 | .454 / .763 / 1.84 | .224 / .441 / 2.95 | .434 / .796 / 1.79 |
| DrNykterstein；80/20 | .512 / .819 / 1.48 | .212 / .475 / 2.70 | .556 / .906 / 1.25 |
| penguingm1；10/17 | .359 / .609 / 2.55 | .266 / .461 / 2.77 | .398 / .617 / 2.50 |

10/20/40/80 全切分及 top-5/Brier 見 `move-results.json`。EricRosen
在 40 局切分 residual top-1 .662 vs raw Maia .519，80 局切分卻是
.434 vs .454；個人化**尚未穩定勝出**。依相鄰 profile 規模比較
top-5 推薦入口（前 4 ply）Jaccard，EricRosen residual 從 40→80
僅 .286，不能稱已收斂。各切分的測試窗口有重疊，樣本量小，
不應以這些數字選 production 公式。

推薦路線上的條件局面覆蓋約 7–18% held-out opponent decisions，
已比「完整路線重現」診斷（多為 0–5% 棋局）更能揭露預測能力。
以 product 選線常全停在 6 ply；幾何平均常延到 8–10 ply，
故 product 有深度懲罰，幾何平均仍需上限與 evidence cutoff。

45 條路線的 preliminary WDL audit 顯示：Maia 選線的平均壓力 floor
EricRosen .403、DrNykterstein .469、penguingm1 .487；大多未達
0.55 一致優勢門檻。這支持**只預測會走進去，仍不足以產生好下的備戰線**。
按 Maia 高機率替代回應的 robustness 亦多偏低；詳見
`wdl-results.json`。WDL 測試未把 route 擴成完整 preparation tree，
這些值不能解讀為對某棋手實戰勝率。

## 5. 候選 ranking architectures

1. **Maia + shrinkage residual + pressure gate（優先實驗）**：
   以 Maia 為 prior；玩家同 EPD／opening family residual 隨有效樣本增加。
   候選由 Maia 高機率回應展開，我方回應用 Stockfish；先過 WDL
   floor、consistency、robustness，再以 likelihood 與記憶成本排 Top-K。
2. **Maia only + pressure gate（強基線）**：小樣本穩定，無個人偏差；
   是任何 personalization 必須在 held-out 打敗的對照組。
3. **Maia + hierarchical family residual**：按 opening family、兵型、
   EPD 分層收縮；比 full-prefix count 更能共享資料，但需防 context leakage。
4. **Maia4All / individual fine-tune challenger**：只在可重現推論、
   至少 80 局且 held-out log loss 穩定改善後納入研究比較。
5. **CTW/PPM/AKOM calibrated challenger**：只作 sequence baseline；
   必須先棋盤合法走法正規化，不能用原始 token 序列替代局面 policy。

下一輪先實驗 1 與 2，按玩家與資料量預先登記增益門檻，
不得事後挑選有利切分。再加更長日期跨度、不同 rating、兩色分層、
完整 Stockfish 深度與機率校準圖。

## 6. 公式、signals 與小／大樣本預期

```text
P_player(m | s,H) =
  (n_context(s,m) + alpha(context_n) * P_Maia(m | s,rating))
  / (n_context(s) + alpha(context_n))

log_route_reach = sum_{opponent turns i} log P_player(m_i | s_i,H)
route_typicality = exp(log_route_reach / opponent_decision_count)
route_reach = exp(log_route_reach)   # 顯示真實連乘，不拿它獨自跨深度排序

pressure_floor = Q10({user_WDL_after_our_move along route})
consistency = share(user_WDL_after_our_move >= 0.55)
blunder_dependency = largest_positive_opponent_WDL_jump / max(net_gain, epsilon)
robustness = sum_{Maia high-p replies a} P_Maia(a) * 1[user_WDL(a) >= 0.55]
CorePrep = nondominated Top-K of (reach, typicality, pressure_floor,
  consistency, robustness, memory_cost), subject to soundness and blunder caps
```

新增／升格 signals：每個對手決策的 calibrated Maia probability、
個人 residual 有效樣本與收縮權重、route reach 與 typicality、
WDL floor/consistency、最大 opponent WDL jump、Maia 回應 robustness、
模型不確定性與資料時間衰減。降格為 evidence/detail：
單點 Maia 結果分數、Masters/Pool WDL、raw frequency、terminal
Stockfish edge；後者只能當可行性／證據，不能獨自定核心路線。
不得把 full-line count ≥2 設為硬門檻。

10–20 局時 residual 應大幅收縮至 Maia，推薦入口應淺且少；
40–80+ 局時才逐步放大確有 held-out 增益的 family／position residual，
並維持壓力 gate、深度上限與去重。更多資料若產生深而不穩的路線，
應縮短證據錨點或回退 Maia，而不是再提高頻率權重。
