# Scout 下一輪研究摘要（2026-09-22）

本輪沒有改 production ranking。完整 protocol、三名玩家的 chronological held-out 資料、Maia policy cache 和 Stockfish WDL 結果見 [offline benchmark](../research/scout-benchmark/README.md)。目前樣本只適合篩選研究方向，不能據此宣稱某公式已勝出。

## 為何少局有用，多局會失真

Production `rankGamePlan` 以 Maia 的結果分數、祖先頻率、終點引擎優勢及 empirical struggle 選線，沒有直接估計「此玩家在每個局面會走哪手」，也未要求整段維持壓力。少局時，常見開局與明顯弱點仍可能帶來有用線索；局數增加後，祖先頻率會放大常見路線，終點優勢可由單次失誤主導，深線的實際到達機率卻沒有得到驗證。這是從現有公式和 benchmark 結果作的推論。

最新 offline 測試中，Maia 推薦的 29 條路線按玩家分組，平均壓力 floor 約為 .431／.459／.425，均低於預設 .55 門檻；各線至少有一個替代回應脆弱點。個人 residual 有時改善 held-out 預測，有時退步：EricRosen 80 局 profile 的 top-1 為 .434，低於 Maia 的 .454。這些數字支持「走得進」和「能持續施壓」要分開測。

## 下一輪優先驗證

1. **Maia policy + pressure gate 強基線。** 以 [Maia-3](https://github.com/CSSLab/maia3) 的 rating-conditioned 合法走法機率估 opponent decision 的 route reach；我方準備手後以同一 Stockfish 版本和深度量每步 WDL floor、壓力一致性、最大單步失誤依賴。先過 soundness 與壓力門檻，再選少量可記住的路線。Maia 的 outcome WDL 與 [Stockfish WDL](https://github.com/official-stockfish/WDL_model) 應分開使用。
2. **收縮的個人 residual。** 在 Maia prior 上加玩家同局面或 opening family 的走法偏好；10–20 局大幅回退 prior，40–80+ 局只有在跨日期 held-out 改善時才增加個人權重。[maia-individual](https://github.com/CSSLab/maia-individual) 可作個人化參照，但先驗證便宜的 residual。逐玩家、分色、按時間切分，比較 top-1/3/5、log loss、Brier/calibration，另量推薦決策點的 route move hit、covered decisions/game 和 false-prep rate；不能只看完整路線重現。
3. **替代回應穩健性和準備價值。** 對每個我方準備手展開 Maia 高機率的其他對手回應，量機率加權 robustness、最低 robustness、需要記的分支數與可轉入我方 repertoire 的程度。用 reach、typicality、pressure floor、robustness、blunder dependency、memory cost 作受約束的 Top-K 比較，避免單一乘積獎勵極短或極深路線。

對個人化的判準是同玩家未來棋局相對 population prior 的穩定增益，而非只像平均玩家。每個 profile 規模固定訓練截止日，避免 opening family 定義或調參偷看 held-out。走法機率需校準；路線到達率要在對手決策點測，並清楚標示我方改走準備手後的反事實部分尚未驗證。

先不把 Scout 改成廣泛覆蓋的 opponent explorer，也不把 raw player-position count、Masters/Pool 勝率、單點 Maia 結果分數或終點引擎優勢升為主要排序。完整路線重複次數不設硬門檻；Maia4All、個人 fine-tune 和純走法 n-gram 留作可重現、held-out 穩定增益後的 challenger。
