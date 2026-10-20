import { appState, boards } from "./core/state.js";
import { syncChipVariant } from "./sync-chip.js";
import { isBuildReadOnly } from "./build-entry.js";

// Train's shell side: the lazy view chunk, its "saving" chip and the stats
// helpers the session calls, plus the sync chip Build and Train share. The
// session itself is controllers/train-session.js.

let setTrainBanner, updateTrainTurnBadge;

export function createTrainEntry(deps) {
  ({ setTrainBanner, updateTrainTurnBadge } = deps);
  return {
    preloadTrainView, ensureTrainView, setTrainSyncState, renderTrainSync,
    renderTrainStats, renderSmartSummaryStats, renderSyncChip, renderBuildSync, setBuildSync,
  };
}
export function setBuildSync(state) {
  appState.buildSyncState = state;
  renderBuildSync();
}

export function renderSyncChip(el, state, scope = "repertoire") {
  const v = syncChipVariant(state, scope);
  el.hidden = false;
  el.className = `build-sync ${v.cls}`;
  el.textContent = v.text;
  el.title = v.text;
}

export function renderBuildSync() {
  // Two hosts, one state: the board bar's chip on desktop, and the same chip in
  // the inspector tools row on phones, where the board bar sits at the screen's
  // bottom out of reach of an edit made above. Only one is ever visible.
  let shown = false;
  for (const id of ["build-sync", "build-sync-head"]) {
    const el = document.getElementById(id);
    if (!el) continue;
    // Nothing to show without an editable repertoire (read-only shared view =
    // no local edits ever happen).
    if (!appState.build || isBuildReadOnly()) {
      el.hidden = true;
      continue;
    }
    renderSyncChip(el, appState.buildSyncState);
    shown = true;
  }
  return shown;
}

let trainModule = null;
let trainView = null;

export function preloadTrainView() {
  if (!trainModule) {
    trainModule = import("./views/train.js").catch((err) => {
      trainModule = null;
      throw err;
    });
  }
  return trainModule;
}

export async function ensureTrainView() {
  const mod = await preloadTrainView();
  if (!trainView) {
    trainView = mod.createTrainView({
      appState,
      boards,
      renderSyncChip,
      setTrainBanner,
      updateTrainTurnBadge,
      onStreakRendered: (streak) => {
        const s = appState.trainStats;
        if (s) s.lastStreak = streak;
      },
    });
  }
  return trainView;
}

// Train's counterpart chip (same look/classes): visible during a smart session
// or while abandoned-session attempts still wait to land.
export function setTrainSyncState(state) {
  appState.trainSyncState = state;
  void renderTrainSync().catch(() => {});
}

export async function renderTrainSync() {
  const el = document.getElementById("train-sync");
  if (!el) return;
  const sync = appState.trainSync;
  // Nothing to say without a session or pending work, and nothing to say while
  // the debounce simply waits: "Saving progress soon" sat there for seconds at
  // a time between answers.
  if (!appState.smart && !sync.pending.length && !sync.dirty) {
    el.hidden = true;
    return;
  }
  return (await ensureTrainView()).renderTrainSync();
}

export async function renderTrainStats() {
  return (await ensureTrainView()).renderTrainStats();
}

export async function renderSmartSummaryStats(smart, stats) {
  return (await ensureTrainView()).renderSmartSummaryStats(smart, stats);
}
