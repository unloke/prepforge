// The crash mark: the engine step this page holds, kept on disk while it holds it, so
// a tab the OS kills leaves it behind and the next load knows which step died.
// `write(entry | null)` stores or clears it; the page and window give its lifecycle.
export function createCrashMark({ write, page, lifecycle }) {
  const pending = new Map();
  let pageHidden = false, unloading = false;
  function sync() {
    const entry = [...pending.values()].at(-1);
    // A probe step is a deliberate heap reservation: it stays armed in a hidden
    // tab too, so an OOM kill there still tells the next load which step died.
    write(entry && !unloading && (entry.sticky || (!pageHidden && page?.visibilityState !== "hidden")) ? entry : null);
  }
  const visibility = () => { pageHidden = page?.visibilityState === "hidden"; sync(); };
  // A page the user reloads, closes or leaves fires pagehide and is not going to the
  // back/forward cache; a tab the OS kills fires nothing. Only the kill is evidence,
  // so an unloading page stays unarmed (its own visibilitychange follows pagehide).
  const hide = event => { pageHidden = true; unloading = event?.persisted === false; sync(); };
  const show = () => { unloading = false; visibility(); };
  // A foreground run leaves evidence only while it owns engines. Background
  // eviction on iOS is not a crash; re-arm when a still-active run returns.
  // A probe step is different: it reserves a heap on purpose, so `sticky` keeps
  // its mark even while the page is hidden. Returns the step's `done`.
  return function arm(attempt, sticky) {
    const token = {};
    if (!pending.size) {
      pageHidden = page?.visibilityState === "hidden";
      page?.addEventListener("visibilitychange", visibility);
      lifecycle?.addEventListener("pagehide", hide);
      lifecycle?.addEventListener("pageshow", show);
    }
    pending.set(token, { attempt, sticky });
    sync();
    return function done() {
      if (!pending.has(token)) return;
      pending.delete(token);
      if (!pending.size) {
        page?.removeEventListener("visibilitychange", visibility);
        lifecycle?.removeEventListener("pagehide", hide);
        lifecycle?.removeEventListener("pageshow", show);
      }
      sync();
    };
  };
}
