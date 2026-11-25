import { setTrainBanner } from "./core/app-context.js";

export function beginLuckyDiscovery(state) {
  if (state.luckyRun) return null;
  const run = { controller: new AbortController(), playToken: state.playStartToken || 0 };
  state.luckyRun = run;
  state.luckyBusy = true;
  paintLuckyButton(true);
  return run;
}

export function luckyDiscoveryCurrent(state, run) {
  return !!run && state.luckyRun === run && state.playStartToken === run.playToken && !run.controller.signal.aborted;
}

export function cancelLuckyDiscovery(state) {
  const run = state.luckyRun;
  if (!run) return false;
  state.luckyRun = null;
  state.luckyBusy = false;
  paintLuckyButton(false);
  run.controller.abort();
  return true;
}

export function finishLuckyDiscovery(state, run) {
  if (state.luckyRun !== run) return;
  state.luckyRun = null;
  state.luckyBusy = false;
  paintLuckyButton(false);
}

// A cancel that also drops the run's visible trace: the banner's progress
// line. The full session resets (openTrain, ‹ Train, view navigation) repaint
// or clear the banner themselves and stay with the bare cancel; a pane switch
// keeps the screen, so it cleans up here.
export function cancelLuckyPractice(state) {
  if (!cancelLuckyDiscovery(state)) return;
  setTrainBanner("move", "", "");
}

function paintLuckyButton(busy) {
  if (typeof document === "undefined") return;
  const button = document.getElementById?.("feeling-lucky");
  if (!button) return;
  button.disabled = busy;
  if (busy) button.setAttribute("aria-busy", "true");
  else button.removeAttribute("aria-busy");
}
