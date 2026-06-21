// Event-driven (or polling fallback) wait for a Stockfish provider search to finish.
// Avoids tight setTimeout polling that Chromium clamps to ≥1s in background tabs.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** True when the provider snapshot represents a finished search at `targetDepth`. */
export function isEngineSearchComplete(snapshot, targetDepth) {
  const depth = targetDepth ?? snapshot.max_depth ?? 0;
  const done = !snapshot.running && snapshot.current_depth > 0;
  const reached = snapshot.current_depth >= depth && snapshot.pvs.length > 0;
  return done || reached;
}

function timeoutError(timeoutMs, { fen, acceptShallowOnTimeout, snapshot }) {
  if (acceptShallowOnTimeout) {
    const top = snapshot.pvs && snapshot.pvs[0];
    if (top && (top.score_cp !== null || top.mate_in !== null)) return null;
    const suffix = fen ? ` for ${fen}` : "";
    return new Error(`Engine timed out after ${timeoutMs}ms with no evaluation${suffix}`);
  }
  const suffix = fen ? ` at ${fen}` : "";
  return new Error(`Browser Stockfish timed out after ${timeoutMs}ms${suffix}`);
}

/**
 * Block until `provider` has a usable eval at `targetDepth`.
 * Uses provider.waitForSearchComplete when available (worker-message driven);
 * otherwise falls back to polling for test fakes.
 */
export async function waitForEngineSearch(
  provider,
  {
    targetDepth,
    cancelled,
    timeoutMs,
    pollMs = 90,
    acceptShallowOnTimeout = false,
    fen = null,
    onCancel,
  } = {},
) {
  const started = Date.now();
  const effectiveDepth = targetDepth ?? provider.snapshot().max_depth ?? 0;

  const evaluate = () => {
    const snap = provider.snapshot();
    if (snap.error) throw new Error(snap.error);
    if (cancelled && cancelled()) {
      if (typeof onCancel === "function") throw onCancel();
      const err = new Error("cancelled");
      err.cancelled = true;
      throw err;
    }
    if (isEngineSearchComplete(snap, effectiveDepth)) return snap;
    if (Date.now() - started >= timeoutMs) {
      const err = timeoutError(timeoutMs, { fen, acceptShallowOnTimeout, snapshot: snap });
      if (err) throw err;
      return snap;
    }
    return null;
  };

  const immediate = evaluate();
  if (immediate) return immediate;

  if (typeof provider.waitForSearchComplete === "function") {
    return provider.waitForSearchComplete({
      targetDepth: effectiveDepth,
      cancelled,
      timeoutMs,
      started,
      acceptShallowOnTimeout,
      fen,
      onCancel,
    });
  }

  // Polling fallback for lightweight test fakes without event hooks.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const snap = evaluate();
    if (snap) return snap;
    await sleep(pollMs);
  }
}