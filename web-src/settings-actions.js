// Reads wait for queued writes; a read cannot invalidate a committed write.
export function createSettingsActions({
  appState, currentOwnerId, ensureSettingsView, api, applySettingsPayload,
  applyServerEngineGating, setStatusError, positionCoach, engineWidget,
  activeViewName, explorerEvalEngine, explorerDrawerOpen, refreshExplorerPanel,
}) {
async function loadSettingsOnce() {
  const seq = appState.settingsReadSeq = (appState.settingsReadSeq || 0) + 1;
  const owner = currentOwnerId();
  let writeSeq = appState.settingsRequestSeq;
  const isCurrent = () => seq === appState.settingsReadSeq && owner === currentOwnerId() && writeSeq === appState.settingsRequestSeq;
  let view = null;
  try {
    view = await ensureSettingsView();
  } catch (error) {
    if (!isCurrent()) return;
    setStatusError(error.message);
    return;
  }
  if (!isCurrent()) return;
  if (!appState.signedIn) {
    // Signed out: browser-local settings only (theme, board, engine status) —
    // no /api/settings call and no 401 in the top bar.
    await view.renderSettings(null);
    return;
  }
  try {
    while (appState.settingsSaving) {
      await appState.settingsSaving;
      if (seq !== appState.settingsReadSeq || owner !== currentOwnerId()) return;
    }
    writeSeq = appState.settingsRequestSeq;
    const payload = await api("/api/settings");
    if (!isCurrent()) return;
    applySettingsPayload(payload);
    applyServerEngineGating();
    await view.renderSettings(payload);
  } catch (error) {
    if (!isCurrent()) return;
    setStatusError(error.message);
    try {
      await view.renderSettings(null);
    } catch (_) {
      /* best-effort local render */
    }
  }
}

async function saveSettings(patch) {
  const seq = appState.settingsRequestSeq = (appState.settingsRequestSeq || 0) + 1;
  const owner = currentOwnerId();
  const isCurrent = () => seq === appState.settingsRequestSeq && owner === currentOwnerId();
  const previous = appState.settingsSaving;
  let release;
  const saving = new Promise((resolve) => { release = resolve; });
  appState.settingsSaving = saving;
  try {
    await previous;
    if (owner !== currentOwnerId()) return;
    const payload = await api("/api/settings", { method: "POST", body: JSON.stringify(patch) });
    if (!isCurrent()) return;
    const previousSettings = appState.settings;
    applySettingsPayload(payload);
    // A depth change must reach the live Stockfish consumers. The Position coach
    // rebuilds lazily (its _ensureEngine sees the new depth on the next run), but an
    // open Engine widget needs an explicit nudge to rebuild + re-analyze right now.
    if (patch && (Object.prototype.hasOwnProperty.call(patch, "stockfish_depth") ||
        (Number.isFinite(payload.stockfish_depth) && payload.stockfish_depth !== previousSettings?.stockfish_depth))) {
      positionCoach.cancel();
      engineWidget.onDepthSettingChanged().catch(() => { /* best-effort */ });
      if (activeViewName() === "analyze") positionCoach.update(positionCoach.fen, positionCoach.ctx);
      void explorerEvalEngine.sync();
    }
    // A Maia-rating change moves the Explorer Players pool (and its scope readout), which
    // both read effectiveMaiaRating() at fetch time — re-render if the drawer is open.
    if (patch && (Object.prototype.hasOwnProperty.call(patch, "maia_rating") || payload.maia_rating !== previousSettings?.maia_rating) && explorerDrawerOpen()) {
      refreshExplorerPanel();
    }
  } catch (error) {
    if (isCurrent()) setStatusError(error.message);
  } finally {
    release();
    if (appState.settingsSaving === saving) appState.settingsSaving = null;
  }
}

  return { loadSettingsOnce, saveSettings };
}
