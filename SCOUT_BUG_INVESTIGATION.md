# Scout Bug Investigation Plan

## 问题概述
Scout 排名结果在 200 局、600 局、1000 局时**完全相同**，说明排名计算不随游戏数变化而改变。

## 症状
- 加载 200 局游戏 → 排名为 [A, B, C, ...]
- 加载 600 局游戏 → 排名仍为 [A, B, C, ...]（完全相同）
- 加载 1000 局游戏 → 排名仍为 [A, B, C, ...]（完全相同）
- UI 显示游戏数在增加，但排名没变

## 根本原因分析

### 可能性 1：frequency 计算没有更新
在 `aggregateOpeningBranches`（scout.js:856）：
```javascript
const ancestorTotalGames = filtered.length;
info.frequency = info.count / ancestorTotalGames;
```
如果这个重新计算了，不同的游戏数应该产生不同的 frequency。

**侦查**：追踪 `ancestorFreq` 在 200/600/1000 局时的值

### 可能性 2：prefilterRanked 或 prefilteredLines 被缓存
在 scout-views.js 中，`scoutState.prefilteredLines` 可能在某个地方被缓存，不随新游戏更新。

**侦查**：查看 `invalidatePrefilterState()` 是否真的清除了所有缓存

### 可能性 3：rankGamePlan 结果被缓存
`rankGamePlan` 的结果可能被缓存在某处，导致新游戏数据不影响排名。

**侦查**：追踪 `rankGamePlan` 的输入（lines）和输出（ranked lines）在不同游戏数时的值

### 可能性 4：recencyWeight 过度加权导致早期稳定
虽然不能完全解释"完全相同"，但可能加速了排序稳定。

**侦查**：检查是否有其他权重机制导致排序过早锁定

## 修改建议

### 1. 在 `aggregateOpeningBranches` 中添加日志
```javascript
console.log(`[Scout] aggregateOpeningBranches: filtered.length=${filtered.length}, branches=${branches.length}`);
branches.forEach((b, i) => {
  if (i < 5) console.log(`  rank ${i}: ${b.line.slice(0,30)} freq=${b.share.toFixed(3)}`);
});
```

### 2. 在 `rankPrefilterCandidates` 中添加日志
```javascript
console.log(`[Scout] rankPrefilterCandidates: input=${lines.length}, output=${gated.length}`);
gated.slice(0, 5).forEach((e, i) => {
  console.log(`  rank ${i}: freq=${e.ancestorFrequency.toFixed(4)} score=${e.prefilterScore}`);
});
```

### 3. 在 `invalidatePrefilterState` 后验证清除
```javascript
console.log(`[Scout] invalidatePrefilterState called`);
console.log(`  prefilteredLines.white cleared: ${!scoutState.prefilteredLines?.white?.length}`);
console.log(`  ancestorFreq.white cleared: ${scoutState.ancestorFreq?.white?.size === 0}`);
```

### 4. 在 `rankGamePlan` 前后检查数据
```javascript
console.log(`[Scout] rankGamePlan input: ${gamePlanSource?.length} lines, baseline=${baseline}`);
// ...calculate...
console.log(`[Scout] rankGamePlan output: ${weaknessTargets?.length} targets`);
```

## 具体的修改位置

1. **scout.js:856** - `aggregateOpeningBranches` 末尾添加日志
2. **scout-prefilter.js:161** - `rankPrefilterCandidates` 末尾添加日志  
3. **scout-views.js:422** - `invalidatePrefilterState` 末尾添加日志
4. **scout-report.js:998** - `rankGamePlan` 前后添加日志

## 执行步骤

1. 添加上述日志点
2. 在浏览器中重新运行 Scout（200 局停止，看日志）
3. 继续加载到 600 局，看日志是否改变
4. 继续到 1000 局，看日志是否改变
5. 根据日志找出"排名冻结"的确切位置

## 预期结果

如果问题是缓存，日志应该显示：
- aggregateOpeningBranches：frequency 应该改变
- rankPrefilterCandidates：输出应该改变
- rankGamePlan：输入应该改变
- 但实际排名结果相同 → 说明问题在更后面的环节

如果日志都改变了但结果不变 → 问题在显示层（UI 没有正确反映计算结果）
