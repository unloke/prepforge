// Front-end error beacon and the crash guards that run at import time: an
// uncaught error or rejection is reported so we have a server-side window into
// browser crashes, and a tab opened before a deploy reloads once to pick up the
// renamed chunks. Both are best-effort and never throw back into the app.
// Front-end error beacon (stability plan #1): report uncaught errors so we have a
// server-side window into browser crashes. Best-effort — sendBeacon never throws
// back into the app, and the endpoint is CSRF-exempt + needs no auth.
function reportClientError(payload) {
  try {
    navigator.sendBeacon(
      "/api/clientlog",
      new Blob([JSON.stringify(payload)], { type: "application/json" }),
    );
  } catch {
    /* best-effort, never throw from the reporter itself */
  }
}
window.addEventListener("error", (e) => {
  reportClientError({
    kind: "error",
    message: e.message,
    src: e.filename,
    line: e.lineno,
    col: e.colno,
    stack: e.error && e.error.stack,
    ua: navigator.userAgent,
    coi: !!self.crossOriginIsolated,
    t: Date.now(),
  });
});
// A deploy renames every hashed chunk, so a tab opened before it fails its next
// lazy import. Reload once to pick up the new build; the timestamp guard stops a
// loop when a chunk is genuinely missing (and no storage means no reload).
window.addEventListener("vite:preloadError", () => {
  const key = "prepforge.chunk_reload_at";
  try {
    if (Date.now() - (Number(sessionStorage.getItem(key)) || 0) < 60_000) return;
    sessionStorage.setItem(key, String(Date.now()));
  } catch {
    return;
  }
  location.reload();
});
window.addEventListener("unhandledrejection", (e) => {
  reportClientError({
    kind: "rejection",
    message: String((e.reason && e.reason.message) || e.reason),
    stack: e.reason && e.reason.stack,
    ua: navigator.userAgent,
    coi: !!self.crossOriginIsolated,
    t: Date.now(),
  });
});


