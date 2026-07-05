# Scout v13 — "Prep Package"(備戰包)設計

> Status: **裁決通過(2026-07-05,有條件)** —— 只准施工 §11 第 1–4 步
> (harness / schema / selector / audit),**第 5 步 viewer 禁動**,直到能
> 穩定產出 3–4 個不重複、可背、source 分明的 package。裁決附帶三點修訂
> (已併入 §3 / §4 / §7,見「裁決修訂」標記)。
> 觸發:v12 route audit 上線後
> 用戶抱怨(a)父節點與孫節點同榜、(b)輸出深度不足、prep 價值低。
> 本文件是 Claude + grok(tmp/v13-proposal-grok.md)+ codex
> (tmp/v13-proposal-codex.md)三方腦力激盪的整合;兩份外部提案在
> 核心結構上**獨立收斂**,分歧點在 §9 列出並附建議。
>
> v12 的科學層(tilt β、cohort z、FDR、holdout 預測力、§7 五關)**全部保留**;
> v13 換的是**產品單位與選線層**。主詞紀律、禁詞、寧缺毋濫條款全額繼承。

---

## §0 診斷:v12 輸出層的兩個結構性缺陷

1. **候選空間 = 他 trie 上的節點**。trie 是漏斗,父子節點是兩個獨立候選;
   dedup 只比 epd 相等 + 我方前 3 手字串相等,短路徑的 entry key 是長路徑
   key 的**前綴但字串不等** → 祖先鏈整條上榜。跨 tendency 之間零 dedup,
   viewer 直接 flatten。(前綴 bug 已於 2026-07-05 hotfix:`isNestedPath`
   進 `selectDistinctRoutes` + viewer `dedupNestedRoutes`;但這是止血,
   不是結構解。)
2. **route 終點被個人樣本綁死**。有樣本的節點天生淺(4~8 ply),之後沒有
   任何延伸機制 → 玩家背了入口沒有「然後呢」。個人證據被迫扛整條線,
   扛不動就斷頭。

兩個缺陷同源:**「他有樣本的節點」既當證據錨點又當輸出單位**。v13 把
這兩個角色拆開:trie 節點降為**證據錨點**,輸出單位升為 Prep Package。

## §1 新單位:Prep Package = 入口區域 + 個人主幹 + 誠實延伸樹

```
PrepPackage {
  entryRegion   // 入口區域:我方第一個「要記的決定」所在的正規化局面(EPD)
  trunk         // 個人主幹:沿他 trie 最高 reachLB 路徑,止於個人證據斷點
  extension     // 延伸樹:斷點後以 explorer + SF 延伸到 12~16 ply,
                //   主線一條 + 關鍵分支 ≤2,每邊帶 evidenceSource 標籤
  style         // solid | sharp | rare | forcing(§5)
  tendencyIds[] // 可掛多個傾向 —— tendency 是 metadata,不再是版面分區
  tier, riskTags, receipts
}
```

三段的證據來源與允許主詞(硬規則,進禁詞渲染測試):

| 區段 | 證據 | 允許主詞 | 收據 |
|---|---|---|---|
| trunk(個人段) | 他的 trie counts/W/D/L + Jeffreys LB + tilt attribution | 「他的對局中此路徑出現 N 次」「他的歷史決策比同分段更常偏向 X」 | counts、W/D/L、reachLB |
| extension 他的 ply | explorer 同分段(games ≥ 50)+ tilt 排序 + SF | 「同分段對局中常見回應」「模型排序的傾向回應之一」 | explorer N、share%、win%、SF eval |
| extension 我方 ply | SF d18 | 「引擎建議」「備戰主幹」 | eval、gap-to-best |

- **個人證據斷點**(personalAnchor):他的決策邊 `childGames < 5`
  (對齊 `AUDIT_MIN_SUBJECT_CHOSE`)即斷,絕不讓 n=1~5 深節點冒充個人證據
  (v2 血淚條款)。
- UI 上斷點畫一條顯式分隔:`─── 個人樣本止於此 ───`;trunk 實線、
  extension 虛線/淡化。**線的個人化來自「為什麼從這裡進」,不是假裝
  預測他第 14 手。**

## §2 延伸演算法(深度問題的解)

從 personalAnchor 延伸到 targetPly(預設 14,forcing 線可到 16,
延伸失敗就縮短或整包不出):

- **我方回合**:SF top-3 中選 sound(gap ≤ 30cp;sharp/forcing 線收緊到
  ≤ 20cp)且與 trunk **概念一致**者(同兵型/同易位側/同壓力線,§6)。
- **他的回合**:回應邊按優先序納入 —— 個人邊(若 games ≥ 5)→ explorer
  頂部回應(累積覆蓋 ≥ 70% 或 games ≥ 50)→ 會實質改變 eval 的引擎回應。
  每個 fork 最多 2 個回應,整包葉子 ≤ 6(§6 預算)。
- **終止**:到 targetPly、局面已解決(安全簡明)、記憶預算爆、或
  soundness 失敗。
- **soundness**:全 spine(含延伸段)我方每手 gap ≤ 閾值;延伸段終點
  eval ≥ −20cp(比 trunk 的 −30 略嚴,因為沒有個人證據背書)。

## §3 結構性根絕祖先/後代同榜:coverage component

選線不再在節點集合上做,而是先把候選 package 折疊成**覆蓋元件**
(coverage component)。兩個 package 屬同一元件,若任一成立:

1. 一方 trunk 的終點 EPD 落在另一方路徑上(祖先/後代);
2. 兩者 entry 在第一個有意義分歧前 transpose 到同一 EPD;
3. 兩者延伸主線在我方入口決定後共享前 4 個半回合(同一個「要記的計畫」)。

**每色每元件只准一個 package 上榜,跨 tendency、跨 style 全域生效。**
落選者降為註記(「此計畫亦由傾向 X 支持 / 亦可由走序 Y 進入」)。
同一入口若要出兩條,必須是**不同 style bucket 且 trunk 終點 EPD 不同**
(真正不同的計畫,不是同一條線的兩個深度)。

這比 prefix filter 強:選拔對象本身**擁有一棵子樹**,祖先和後代在定義上
不可能是兩個第一級輸出。

**裁決修訂(2026-07-05):先分組、再排序。** 不准沿用 v12 的
「先 rank 再 greedy 去重」——greedy 會讓淺層高 reach 的父節點先出現、
壓掉更深更有 prep 價值的孫節點(hotfix 的已知限制)。正確順序:
每個 coverage component 先**收齊**所有父/子/轉置候選,在元件內部
用 §4 Stage 2–4 的準則選出**一個代表 package**,元件代表之間才進
全域排序。選代表是元件內的 argmax,不是先到先得。

## §4 選線 = 硬門檻漏斗,不是 scalar(v12 rankScore 廢除為主排序)

`reach × attribution` 這種單一乘積會讓「淺而高 reach」永遠壓過
「深而有 prep 價值」,正是殘幹化的推手。改為:

```
Stage 0  候選生成:tendency anchors(v12 現貨)→ entry region 種子
Stage 1  硬門檻:soundness(全 spine)/ 三源事實性 / 記憶預算 / 元件唯一
Stage 2  個人化排序:reachPersonal(只算 trunk 段 Jeffreys 積)
         × attribution(只在 personalAnchor 算)—— 延伸段的量不進個人化分
Stage 3  風格分桶(§5):每色目標 4 包,solid/sharp/rare/forcing 各試填 1
Stage 4  桶內 tie-break:memorability(§6)
Stage 5  route audit(v12 Step 5 現貨)→ tier + riskTags,對最終包跑,
         不對全部原始候選跑
```

**裁決修訂(2026-07-05):Stage 5 = 完整 package audit,不是只驗 spine。**
package 的**每一個 branch leaf** 都要獨立過:d18 soundness、§6 記憶
硬預算、only-move 計數、風險標籤。任一 leaf 不過 → 砍該分支重驗預算,
砍不動 → 整包不出。否則 package 看起來完整、實戰難背。此驗收進
harness 測試(合成 package:一條壞 leaf 必須觸發砍枝或整包淘汰)。

**三源事實性硬門檻**(準則 2):trunk 至少一邊 games ≥ 5(他的實戰)+
全 spine soundness pass(引擎)+ 延伸段他的每個 ply 有 explorer games ≥ 50
或個人 counts(explorer/實戰)。任一源缺 → 不出。

**多樣性 = 軟配額 + 誠實空桶**(兩位顧問一致):某桶沒有過門檻的候選就
標 `bucketVacant` 誠實略過,**不硬塞**;空出的位子由剩餘候選按
marginal relevance(base 分 − 與已選包的重疊懲罰)遞補。寧缺毋濫優先於
分類學美觀。

## §5 style 的可計算定義(打標,不拍腦袋)

| Style | 定義(全部可從既有量計算) |
|---|---|
| **solid** | 終點 eval ≥ +15cp;我方全程 gap ≤ 15cp;跨他方主要回應的 eval 波動 ≤ 60cp;無棄兵/棄子 |
| **sharp** | anchor 處 attribution ≥ 分佈 P75 且 leak move 是 capture/check 類;eval 波動 ≥ 80cp 或有 only-move 時刻;仍需全程 sound(收緊 gap ≤ 20cp) |
| **rare** | 我方入口著法 explorer 同分段頻率 ≤ 5%(高總量局面放寬到 ≤ 10%)且 SF gap ≤ 25cp;不得依賴單一低機率失誤 |
| **forcing** | 關鍵節點他的「50cp 內好回應」≤ 2;check/capture/威脅密度高;explorer 前兩回應覆蓋 ≥ 65%;我方每步近乎唯一且清楚 |

多標籤時 primary 優先序:sharp > forcing > rare > solid(區分度優先)。
風險 badge(非 tier):`ThinSample`(個人邊 5≤games<10)、`CohortOnly`
(延伸段全無個人 counts)、`Narrow`(only-move 時刻)、`HighVariance`、
`LowTheory`(rare 桶)、`Transposes`。

## §6 memorability:硬預算 + 軟分(準則 3 的「不太難背」)

**硬預算**(超標 → 砍分支,砍不動就整包不出):
- 葉子 ≤ 6;fork ≤ 3;單 fork 回應 ≤ 2(罕見 3);
- 非 forcing 線的 only-move 時刻 ≤ 2;
- 概念標籤族 ≤ 2(兵型 / 出子模式 / 中心策略 / 易位側四族,由既有
  bias-features 抽取,不需新特徵)。

**軟分**(桶內 tie-break):
```
memPenalty = 2.0·log2(1+forkCount) + 1.5·uniqueConceptCount
           + 1.0·onlyMoveCount + 0.5·transpositionDivergence
```
延伸段選我方著法時,概念一致性當 tie-break(§2),讓玩家背的是
「一個想法走到底」而不是 8 條殘幹。transposition 一律在 EPD 空間合併,
顯示「亦可由…走序到達」。

## §7 explorer 的主詞紀律(不重蹈 v3 去個人化)

- explorer = 「同分段玩家群」的到達率/回應分佈**下界**,永遠不冒充他。
- `cohortReachLB`(延伸段 Wilson/Jeffreys LB 連乘)與 `personalReachLB`
  **分欄印出,禁止合併成一個數字**;內部排序可以相乘,UI 不可以。
- 文案模板:「此後他的個人樣本只剩 2 局,以下分支改用 Lichess
  1800–2000 blitz explorer(12,400 局,34% 選 Nf6)。此為分段統計,
  非該棋手個人紀錄。」收據必印 rating band + speed。

**裁決修訂(2026-07-05):source label 進測試,不是只進文件。**
harness 必須有渲染/schema 測試斷言:(a)extension 段每條邊都帶
`evidenceSource ∈ {personal, cohort, engine}` 且非 personal 邊禁用
「他會/他常」主詞(禁詞測試延伸到主詞+來源配對);(b)個人樣本
斷點(personalAnchor)必在輸出結構中顯式標記,UI 才畫得出
「─── 個人樣本止於此 ───」。explorer 延伸永遠不准變成假個人化。

## §8 輸出形態

每色 3~4 包(不足就少出 + 空桶註記)。每包卡片層次:

```
┌ Header: style + tier + riskTags + 入口走法序列
├ 為什麼從這裡進: 他到達此入口 N 局(reach LB x%)+ 傾向一句話(歷史過度代表句式)
├ Entry → Trunk(實線,個人收據)
├ ─── 個人樣本止於此(ply k)───
├ Extension(虛線): 主線至 12~16 ply + 關鍵分支 ≤2,每邊 source 標籤
│   (personal / cohort / engine)+ eval checkpoint
└ Receipts 表格 + [Analyze ›] [Add to prep ▾](深連結加入整棵 package 樹,
    不是只加入口線)
```

禁止印出:prep gain、π 值、attribution cp、模型機率(全額繼承)。

## §9 兩位顧問的分歧點與建議裁決

| 議題 | grok | codex | 建議 |
|---|---|---|---|
| 元件判定 | EPD 支配剪枝(prefix + reach/eval 條件) | coverage component 含 Jaccard ≥ 0.35 節點重疊 | **v1 用 §3 的三條簡單規則**(prefix/transpose/共享計畫);Jaccard 留給 harness 發現漏網時再加 |
| 每色包數 | 4–6 | 3–4 | **4**(空桶允許少於 4;超過 4 沒有版面理由) |
| memorability | penalty 公式 + 上限 6 | 100 分制 + 門檻 55 | 取 §6 混合:硬預算列表(codex)+ 簡短 penalty 式(grok);常數進 harness 校準,不進條文 |
| extension 他方回應選法 | explorer 眾數優先 | 累積覆蓋 70% + 引擎戰術回應必收 | **codex 版**:眾數會漏「稀有但致命」的回應,引擎戰術邊必須在樹裡 |

## §10 v12 資產處置

**保留**:tilt β + cohort z + FDR、attributionForFeature(內部)、
soundness gate、pathReachLB、route audit tier + 實戰/policy 分欄、
主詞紀律/禁詞測試、Maia harness、SF worker、trie 建構、Bias Card 層
(每色 ≤5 張,linkedSpineIds 連到 package)。

**改造**:trie 節點枚舉 → entry region 種子;selectDistinctRoutes →
元件唯一 + 風格分桶;rankScore → 漏斗;per-tendency top-3 → per-color
style-aware(tendency 降為 metadata)。

**淘汰**:trie 節點 = route 終點;跨 tendency 獨立清單;單線輸出;
深節點 n=1~5 個人聲稱。

## §11 施工順序(harness-first,繼承 v12 紀律)

1. PrepPackage / EntryRegion / EvidenceEdge JSON schema + 元件折疊純函數
   (合成 trie 單元測試:父 80 games / 孫 20 games 必須只出一包)。
2. extension builder(SF + explorer proxy 接線,收據分欄)。
3. style 打標 + memorability(常數用 unbrainless87 + 本人帳號校準)。
4. 選拔漏斗 + audit 整合;驗收案例:兩 tendency 同 EPD 只出一包、
   個人 ply 7 斷 → 延伸到 14 且收據分離、空桶誠實、全報告無禁詞無 π。
5. **(裁決封鎖中)** Viewer v13(斷點視覺、source 標籤、整包深連結);
   ?scoutV12=1 位置由 ?scoutV13=1 接手,v2 仍為預設,直到本人臉譜驗收
   過關。解鎖條件:第 1–4 步能穩定產出 3–4 個不重複、可背、source
   分明的 package,交裁決後才准動。
