// An analysis that finished but is not confirmed saved: the "Retry save" bar
// and the startup check that brings it back (or clears it once the server says
// the save landed). The retry itself is analyze-session.js's retryAnalyzeSave.
import { appState, analysisState } from "./core/state.js";
import { api, currentOwnerId } from "./core/api.js";
import { clearCheckpoint, loadCheckpoint } from "./analyze-checkpoint.js";

export function showAnalysisRetrySave(checkpoint, message) {
  analysisState.analysisRetryCheckpoint = checkpoint;
  const bar = document.getElementById("analysis-retry-save");
  if (!bar) return;
  const text = document.getElementById("analysis-retry-save-text");
  if (text) {
    const white = checkpoint.pgn?.match(/\[White "([^"\n]*)"\]/)?.[1];
    const black = checkpoint.pgn?.match(/\[Black "([^"\n]*)"\]/)?.[1];
    const game = white || black ? `${white || "?"} vs ${black || "?"}` : checkpoint.gameId;
    text.textContent = checkpoint.serverSaved
      ? `${game} · Analysis saved. Device cleanup failed, retry cleanup.`
      : `${game} · ${message || "Unsaved analysis"} · ${checkpoint.inMemoryOnly ? "Kept in this page only" : "Kept on this device"}`;
  }
  const button = document.getElementById("analysis-retry-save-btn");
  if (button) button.textContent = checkpoint.serverSaved ? "Retry cleanup" : "Retry save";
  bar.hidden = false;
}

export function hideAnalysisRetrySave() {
  const bar = document.getElementById("analysis-retry-save");
  if (bar) bar.hidden = true;
}

export async function refreshAnalyzeRecovery() {
  const owner = currentOwnerId();
  const generation = appState.ownerGeneration;
  const seq = analysisState.analysisRecoverySeq = (analysisState.analysisRecoverySeq || 0) + 1;
  const isCurrent = () => owner === currentOwnerId() && generation === appState.ownerGeneration && seq === analysisState.analysisRecoverySeq;
  let checkpoint = analysisState.analysisUnsavedCheckpoint?.ownerId === owner ? analysisState.analysisUnsavedCheckpoint : await loadCheckpoint(null, owner);
  while (checkpoint && isCurrent()) {
    if (!checkpoint.serverSaved && !checkpoint.inMemoryOnly) {
      try {
        const status = await api(`/api/analyses/${encodeURIComponent(checkpoint.gameId)}/saves/${encodeURIComponent(checkpoint.requestId)}/status`);
        if (!isCurrent()) return;
        checkpoint.serverSaved = status.saved;
      } catch (error) {
        if (isCurrent()) showAnalysisRetrySave(checkpoint, `Save status unconfirmed: ${error.message}`);
        return;
      }
    }
    if (checkpoint.serverSaved) {
      if (!await clearCheckpoint(checkpoint.gameId, owner, checkpoint.requestId)) {
        if (isCurrent()) showAnalysisRetrySave(checkpoint);
        return;
      }
      if (!isCurrent()) return;
      checkpoint = await loadCheckpoint(null, owner);
    } else {
      showAnalysisRetrySave(checkpoint);
      return;
    }
  }
  if (isCurrent()) {
    analysisState.analysisRetryCheckpoint = null;
    hideAnalysisRetrySave();
  }
}
