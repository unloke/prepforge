import { trainState, boards } from "./core/state.js";
import { renderSyncChip } from "./sync-chip.js";
import { setTrainBanner, updateTrainTurnBadge } from "./train-banner.js";
import "./train-shell.css";

// Train's shell side: the lazy view chunk, its "saving" chip and the stats
// helpers the session calls. The session itself is controllers/train-session.js.

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
      trainState,
      boards,
      renderSyncChip,
      setTrainBanner,
      updateTrainTurnBadge,
      onStreakRendered: (streak) => {
        const s = trainState.trainStats;
        if (s) s.lastStreak = streak;
      },
    });
  }
  return trainView;
}

// Train's counterpart chip (same look/classes): visible during a smart session
// or while abandoned-session attempts still wait to land.
export function setTrainSyncState(state) {
  trainState.trainSyncState = state;
  void renderTrainSync().catch(() => {});
}

export async function renderTrainSync() {
  const el = document.getElementById("train-sync");
  if (!el) return;
  const sync = trainState.trainSync;
  // Nothing to say without a session or pending work, and nothing to say while
  // the debounce simply waits: "Saving progress soon" sat there for seconds at
  // a time between answers.
  if (!trainState.smart && !sync.pending.length && !sync.dirty) {
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
