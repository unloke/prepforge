// Shared error-class contract for the local-first flushes (R-01/R-02/R-04).
//
// Build and Train both queue local edits and replay them to the server, and
// they must answer the same question the same way: can this batch be retried
// later, or is it permanently rejected? The old behaviour treated every 4xx
// alike (Build dropped them all), which lost unconfirmed edits on auth,
// CSRF, conflict, and rate-limit failures. One classifier, one contract:
//
// - network / 5xx / 408 / 425  → retry later, keep the draft (nothing lost)
// - 401 auth                   → retry later; PAUSE and ask for sign-in
// - 403 csrf/forbidden         → retry later after a CSRF refresh
// - 409 conflict               → keep the draft, surface the conflict flow
// - 429 rate limit             → retry after the server's hint
// - 400 / 422 / 404 / 410 …    → permanent for THIS payload: isolate it as
//                                rejected (kept for inspection), never drop
//                                silently and never mark it "Saved"

/**
 * @param {{status?: number, headers?: {get?: Function}, message?: string}|null|undefined} error
 * @returns {{
 *   kind: "network"|"server"|"auth"|"csrf"|"conflict"|"rate-limit"|"validation"|"unknown",
 *   status: number|null,
 *   retriable: boolean,
 *   keepsDraft: boolean,
 *   pauseForAuth: boolean,
 *   retryAfterMs: number|null,
 * }}
 */
export function classifySyncError(error) {
  const status = error && typeof error.status === "number" ? error.status : null;
  const base = {
    status,
    retriable: true,
    keepsDraft: true,
    pauseForAuth: false,
    retryAfterMs: null,
  };
  if (status === null || status === undefined) {
    return { ...base, kind: "network" }; // fetch failed: offline, DNS, CORS…
  }
  if (status >= 500 || status === 408 || status === 423 || status === 425) {
    return { ...base, kind: "server" };
  }
  if (status === 401) {
    // Session expired: the data was never acknowledged. Keep everything and
    // stop hammering the API — resume when the user signs in again.
    return { ...base, kind: "auth", pauseForAuth: true };
  }
  if (status === 403) {
    // Usually a stale CSRF token (refreshable); real permission loss is rare
    // here because every queue targets the owner's own data.
    return { ...base, kind: "csrf" };
  }
  if (status === 409) {
    // Optimistic-concurrency conflict (D-02): the draft must survive so the
    // user can reconcile; it is retriable only after that reconciliation.
    return { ...base, kind: "conflict", retriable: false };
  }
  if (status === 429) {
    return { ...base, kind: "rate-limit", retryAfterMs: retryAfterFromError(error) };
  }
  if (status >= 400 && status < 500) {
    // Permanent for this payload (malformed, missing, gone): isolate as
    // rejected. The draft is NOT auto-retried but is kept for inspection.
    return {
      ...base,
      kind: "validation",
      retriable: false,
      keepsDraft: true,
    };
  }
  return { ...base, kind: "unknown" };
}

function retryAfterFromError(error) {
  const headers = error && error.headers;
  const read =
    headers && typeof headers.get === "function"
      ? (name) => headers.get(name)
      : () => null;
  const raw = read("retry-after") || (error && error.retryAfter) || null;
  // Number(null) is 0 — a missing hint must stay "unknown", not "retry now".
  if (raw === null || raw === undefined || raw === "") return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  return null;
}

/**
 * Human, actionable message per class — the user always knows whether to sign
 * in, wait, or fix something (R-04: "waiting for sign-in" and "waiting for
 * network" must not look the same).
 *
 * @param {ReturnType<typeof classifySyncError>} info
 * @param {{count?: number, retryAfterMs?: number|null}} [ctx]
 */
export function describeSyncError(info, ctx = {}) {
  const count = ctx.count || 0;
  const noun = count === 1 ? "edit" : `${count} edits`;
  switch (info.kind) {
    case "auth":
      return `Waiting for sign-in — ${noun} kept on this device and saved after you sign in.`;
    case "csrf":
      return `Save blocked by a stale security token — ${noun} kept and retried automatically.`;
    case "conflict":
      return `This repertoire changed elsewhere — ${noun} kept. Reload it and re-apply, or keep your draft.`;
    case "rate-limit": {
      const ms = info.retryAfterMs != null ? info.retryAfterMs : ctx.retryAfterMs;
      const secs = ms ? Math.max(1, Math.ceil(ms / 1000)) : null;
      return secs
        ? `Rate limited — saving again in ~${secs}s. ${noun} kept.`
        : `Rate limited — ${noun} kept and saved shortly.`;
    }
    case "validation":
      if (!count) return "Some attempts could not be saved and are kept for review.";
      return `${noun} could not be saved and ${count === 1 ? "is kept" : "are kept"} for review.`;
    case "server":
    case "network":
    default:
      return `Offline or server busy — ${noun} kept on this device. Retrying automatically.`;
  }
}
