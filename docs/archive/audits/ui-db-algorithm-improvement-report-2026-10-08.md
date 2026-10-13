## 9. 優先改進建議（Priority Recommendations）

根據影響性與實作難度排序：

### P0（高影響、低/中難度）— 建議立即處理
1. **prefers-reduced-motion 支援**（CSS + JS）— 視覺效果/UX，Accessibility
   - CSS：新增 `@media (prefers-reduced-motion: reduce)` 停用 transition/animation
   - JS：將 flipAnim/moveAnim 預設值與系統偏好整合
2. **Breadcrumb 路徑截斷**（UI/UX）— 長路徑避免版面破裂
   - 當 breadcrumb 超過 5-6 個節點時，中間以 `...` 截斷
3. **Job dock 條件顯示**（UX 簡潔化）— 僅在有 running/pending job 時顯示 `#analysis-job-dock`
4. **新增 engine_evaluations 複合索引**（DB 效能）— `ix_engine_evaluations_pos_engine (position_id, engine)`
   - 對應 games.py line 179-203 的 lookup 路徑
5. **Reduced motion 預設值**（UX）— 尊重系統偏好作為預設

### P1（高影響、中難度）
1. **Quality metadata UI 呈現**（跨功能）— 在 Analyze Report/Engine pane 顯示 analysis.quality（depth coverage、Maia availability、shallow spots）
   - 已有資料結構（A-05），僅需 UI 呈現
2. **Unified error model**（架構一致性）— 建立 api/errors.py 統一 4xx/5xx 回應格式
3. **Mobile More Sheet 分組**（UX）— 按 nav-group 分組呈現，提升掃描效率
4. **抽共用純函數**（架構）— 將 material_invested/sanity_exclusion 抽至 core，減少 browser/server 重複（或維持 golden fixture 策略並記錄決策）

### P2（中影響、中難度）
1. **Breadcrumb/路徑 overflow 處理**（行動版）— 加入 scroll 或 truncate
2. **Rail 動畫時延最佳化**（UI）— prefers-reduced-motion 時將 60ms delay 歸零
3. **Loading 狀態粒度**（UX）— 區分 initial load vs refresh（library-refresh-status 強化）
4. **Chunked select 優化**（DB）— 減少 positions/evals 的 round-trips（可考慮先 SELECT existing 再批次 INSERT）

### P3（低影響、建議持續改進）
1. **Ghost DOM 清理強化**（視覺效果）— board drag 結束時確保 ghost element 移除
2. **Error response 統一測試**（品質）— 為 business errors（PositionPayloadError）補充整合測試
3. **Type hints 強化**（程式碼品質）— mpy strictness 提升

---

## 總結

本專案整體程式碼品質非常高，特別體現在：

- **跨端一致性機制**（golden fixtures + shared constants）極為成熟，值得作為其他專案參考
- **架構原則貫徹**：「never computes chess」、no legacy support、immutable snapshots、compact storage 等原則貫徹一致
- **演算法工程化**：Brilliant/Great 檢測的四層判定、fail-closed 設計、trap_gap 優化等展現扎實的工程思辨
- **UX 簡潔化**：移除 top bar、no standing explanations、漸進揭露等設計決策清晰且一致

建議優先處理 **P0 項目**，尤其是 reduced-motion 支援、breadcrumb 截斷、job dock 條件顯示與 DB 索引。這些改進風險低、收益明確，不會破壞既有的 golden contract 與架構原則。

整體而言，PrepForge Chess 是一個設計嚴謹、測試完善、架構清晰的 chess 應用，改進空間多屬精緻化而非結構性缺陷。