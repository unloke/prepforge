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

function paintLuckyButton(busy) {
  if (typeof document === "undefined") return;
  const button = document.getElementById?.("feeling-lucky");
  if (!button) return;
  button.disabled = busy;
  if (busy) button.setAttribute("aria-busy", "true");
  else button.removeAttribute("aria-busy");
}
