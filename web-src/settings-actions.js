// Reads wait for queued writes; a read cannot invalidate a committed write.
export function createSettingsActions({
  appState, settingsState, currentOwnerId, ensureSettingsView, api, applySettingsPayload,
  applyServerEngineGating, setStatusError, getPositionCoach, engineWidget,
  activeViewName, explorerEvalEngine, explorerDrawerOpen, refreshExplorerPanel,
}) {
async function loadSettingsOnce({ render = true } = {}) {
  const seq = settingsState.settingsReadSeq = (settingsState.settingsReadSeq || 0) + 1;
  const owner = currentOwnerId();
  const generation = appState.ownerGeneration;
  let writeSeq = settingsState.settingsRequestSeq;
  const isCurrent = () => seq === settingsState.settingsReadSeq && owner === currentOwnerId() && generation === appState.ownerGeneration && writeSeq === settingsState.settingsRequestSeq;
  let view = null;
  try {
    view = render ? await ensureSettingsView() : null;
  } catch (error) {
    if (!isCurrent()) return;
    setStatusError(error.message);
    return;
  }
  if (seq !== settingsState.settingsReadSeq || owner !== currentOwnerId() || generation !== appState.ownerGeneration) return;
  // Paint the account from what /api/auth/me already put in state NOW; the
  // /api/settings read below fills in the rest. Waiting on that read before
  // the first paint is what held "Loading account…" on screen.
  view?.renderAccount?.();
  if (!appState.signedIn) {
    // Signed out: browser-local settings only (theme, board, engine status) —
    // no /api/settings call and no 401 in the top bar.
    await view?.renderSettings(null);
    return;
  }
  try {
    while (settingsState.settingsSaving) {
      await settingsState.settingsSaving;
      if (seq !== settingsState.settingsReadSeq || owner !== currentOwnerId() || generation !== appState.ownerGeneration) return;
    }
    writeSeq = settingsState.settingsRequestSeq;
    const payload = await api("/api/settings");
    if (!isCurrent()) return;
    applySettingsPayload(payload);
    applyServerEngineGating();
    await view?.renderSettings(payload);
  } catch (error) {
    if (!isCurrent()) return;
    setStatusError(error.message);
    try {
      await view?.renderSettings(null);
    } catch (_) {
      /* best-effort local render */
    }
  }
}

async function saveSettings(patch) {
  const seq = settingsState.settingsRequestSeq = (settingsState.settingsRequestSeq || 0) + 1;
  const owner = currentOwnerId();
  const generation = appState.ownerGeneration;
  const isCurrent = () => seq === settingsState.settingsRequestSeq && owner === currentOwnerId() && generation === appState.ownerGeneration;
  const previous = settingsState.settingsSaving;
  let release;
  const saving = new Promise((resolve) => { release = resolve; });
  settingsState.settingsSaving = saving;
  try {
    await previous;
    if (owner !== currentOwnerId() || generation !== appState.ownerGeneration) return;
    const payload = await api("/api/settings", { method: "POST", body: JSON.stringify(patch) });
    if (!isCurrent()) return;
    const previousSettings = settingsState.settings;
    applySettingsPayload(payload);
    // A depth change must reach the live Stockfish consumers. The Position coach
    // rebuilds lazily (its _ensureEngine sees the new depth on the next run), but an
    // open Engine widget needs an explicit nudge to rebuild + re-analyze right now.
    if (patch && (Object.prototype.hasOwnProperty.call(patch, "stockfish_depth") ||
        (Number.isFinite(payload.stockfish_depth) && payload.stockfish_depth !== previousSettings?.stockfish_depth))) {
      const positionCoach = getPositionCoach(); // null until Analyze has loaded
      positionCoach?.cancel();
      engineWidget.onDepthSettingChanged().catch(() => { /* best-effort */ });
      if (positionCoach && activeViewName() === "analyze") positionCoach.update(positionCoach.fen, positionCoach.ctx);
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
    if (settingsState.settingsSaving === saving) settingsState.settingsSaving = null;
  }
}

  return { loadSettingsOnce, saveSettings };
}
