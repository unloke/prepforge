export function createBatchSwitcher({ appState, recallAnalysis, runAnalysis, invalidateAnalysisSource, sourceIsCurrent, isBusy, setStatus }) {
  return async (summary, index, host) => {
    const batchPgn = appState.analysisMultiPgn;
    if (!batchPgn) {
      host.hidden = true;
      host.innerHTML = "";
      setStatus("Paste the games again to switch between them", { severity: "warning" });
      return;
    }
    const game = summary.games?.find(game => game.index === index);
    if (!game?.game_id || game.status === "failed") return;
    const select = host.querySelector("select");
    if (isBusy()) {
      if (select) select.value = String(summary.selected_index);
      setStatus("Another job is already running");
      return;
    }
    const seq = invalidateAnalysisSource();
    appState.analysisMultiPgn = batchPgn;
    host.setAttribute("aria-busy", "true");
    if (select) select.disabled = true;
    let missing = false;
    try {
      const loaded = await recallAnalysis(game.game_id, game, { sourceSeq: seq, onMissing: () => { missing = true; } });
      if (!sourceIsCurrent(seq)) return;
      if (loaded) {
        summary.selected_index = index;
        summary.selected_game_id = game.game_id;
        appState.analysisSourcePgn = appState.analysis.pgn;
        setStatus("");
      } else if (missing) {
        host.setAttribute("aria-busy", "false");
        await runAnalysis({ mode: "multi", selectIndex: index, fromBatch: true });
      } else if (select) {
        select.value = String(summary.selected_index);
      }
    } finally {
      if (sourceIsCurrent(seq)) {
        host.setAttribute("aria-busy", "false");
        if (select) select.disabled = false;
      }
    }
  };
}
