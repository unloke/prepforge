// Unified sign-in gate helpers (pure, DOM-free so they unit-test in node).
//
// Account-only entry points call requireSignIn(reason, pendingActionId). When a
// guest is bounced to the sign-in modal, the interrupted action is remembered in
// sessionStorage so it can resume after the sign-in reload — including the
// Google OAuth round trip, which lands back on "/?signed_in=1".
//
// Only ids on this allowlist ever resume; the stored value is data (an id and
// an in-app hash route), never code, and anything else is dropped on read.

export const PENDING_ACTION_KEY = "prepforge.pending_action";
export const AUTH_RETURN_KEY = "prepforge.auth_return";
// A sign-in that takes longer than this is no longer "the same" intent.
export const PENDING_ACTION_TTL_MS = 15 * 60 * 1000;

export const PENDING_ACTIONS = Object.freeze([
  "new-repertoire",
  "import-pgn",
  "new-team",
  "analyze-game",
  "train",
  "games-check",
  "scout-start",
  "lichess-link",
  "my-last-game",
]);
const PENDING_ACTION_SET = new Set(PENDING_ACTIONS);

// Shown in place of the backend's raw "not authenticated" detail.
export const AUTH_REQUIRED_MESSAGE = "Sign in (or create an account) to continue.";

export function isPendingActionId(id) {
  return typeof id === "string" && PENDING_ACTION_SET.has(id);
}

// In-app hash routes only ("#/build?rep=…"). Anything else is ignored so a
// tampered value can never point the app at another origin or a script URL.
const ROUTE_RE = /^#\/[A-Za-z0-9/_\-?=&.%]{0,200}$/;

export function isSafeRoute(route) {
  return typeof route === "string" && ROUTE_RE.test(route);
}

function safeStorage(storage) {
  if (storage) return storage;
  try {
    return typeof sessionStorage !== "undefined" ? sessionStorage : null;
  } catch (_) {
    return null;
  }
}

export function savePendingAction(id, { route = "", storage, now = Date.now() } = {}) {
  const store = safeStorage(storage);
  if (!store || !isPendingActionId(id)) return false;
  const record = { id, at: now };
  if (isSafeRoute(route)) record.route = route;
  try {
    store.setItem(PENDING_ACTION_KEY, JSON.stringify(record));
    return true;
  } catch (_) {
    return false;
  }
}

export function clearPendingAction({ storage } = {}) {
  const store = safeStorage(storage);
  if (!store) return;
  try {
    store.removeItem(PENDING_ACTION_KEY);
  } catch (_) {
    /* storage unavailable */
  }
}

// Read-and-remove: a pending action resumes at most once.
export function takePendingAction({ storage, now = Date.now() } = {}) {
  const store = safeStorage(storage);
  if (!store) return null;
  let raw = null;
  try {
    raw = store.getItem(PENDING_ACTION_KEY);
    store.removeItem(PENDING_ACTION_KEY);
  } catch (_) {
    return null;
  }
  if (!raw) return null;
  let record;
  try {
    record = JSON.parse(raw);
  } catch (_) {
    return null;
  }
  if (!record || typeof record !== "object" || !isPendingActionId(record.id)) return null;
  const at = Number(record.at);
  if (!Number.isFinite(at) || now - at > PENDING_ACTION_TTL_MS || at - now > 60_000) return null;
  return { id: record.id, route: isSafeRoute(record.route) ? record.route : null };
}

const JOIN_CODE_RE = /^[A-Za-z0-9_-]{1,128}$/;

// Marks "this browser is about to come back signed in" (password sign-in
// reload or the Google redirect). Records where the user was — the Google
// callback always lands on "/?signed_in=1", dropping the hash route and a
// pending team-invite ?join= code — so the next boot can put them back.
export function markAuthReturn({ storage, now = Date.now(), href = "" } = {}) {
  const store = safeStorage(storage);
  if (!store) return;
  const record = { at: now };
  try {
    const url = new URL(String(href || ""), "http://prepforge.local/");
    if (isSafeRoute(url.hash)) record.route = url.hash;
    const join = url.searchParams.get("join");
    if (join && JOIN_CODE_RE.test(join)) record.join = join;
  } catch (_) {
    /* no location to remember */
  }
  try {
    store.setItem(AUTH_RETURN_KEY, JSON.stringify(record));
  } catch (_) {
    /* storage unavailable */
  }
}

// Read-and-remove. Returns { route, join } (either may be null) or null.
export function takeAuthReturn({ storage, now = Date.now() } = {}) {
  const store = safeStorage(storage);
  if (!store) return null;
  let raw = null;
  try {
    raw = store.getItem(AUTH_RETURN_KEY);
    store.removeItem(AUTH_RETURN_KEY);
  } catch (_) {
    return null;
  }
  if (!raw) return null;
  let record;
  try {
    record = JSON.parse(raw);
  } catch (_) {
    return null;
  }
  const at = Number(record && record.at);
  if (!Number.isFinite(at) || now - at > PENDING_ACTION_TTL_MS || at - now > 60_000) return null;
  return {
    route: isSafeRoute(record.route) ? record.route : null,
    join: typeof record.join === "string" && JOIN_CODE_RE.test(record.join) ? record.join : null,
  };
}

// Where to put the user back after the sign-in round trip. Only fills in
// what the landing URL lost: an existing hash or ?join= always wins.
export function restoredAuthHref(currentHref, authReturn) {
  if (!authReturn) return null;
  let url;
  try {
    url = new URL(String(currentHref), "http://prepforge.local/");
  } catch (_) {
    return null;
  }
  let changed = false;
  const hasRoute = url.hash && url.hash !== "#" && url.hash !== "#/";
  if (!hasRoute && authReturn.route && isSafeRoute(authReturn.route)) {
    url.hash = authReturn.route;
    changed = true;
  }
  if (!url.searchParams.has("join") && authReturn.join && JOIN_CODE_RE.test(authReturn.join)) {
    url.searchParams.set("join", authReturn.join);
    changed = true;
  }
  return changed ? `${url.pathname}${url.search}${url.hash}` : null;
}

// The Google callback redirects to "/?signed_in=1". Returns the cleaned
// path+search+hash, or null when the URL carries no sign-in marker.
export function stripSignedInParam(href) {
  let url;
  try {
    url = new URL(String(href), "http://prepforge.local/");
  } catch (_) {
    return null;
  }
  if (!url.searchParams.has("signed_in")) return null;
  url.searchParams.delete("signed_in");
  return `${url.pathname}${url.search}${url.hash}`;
}

export function isAuthError(error) {
  return !!error && (error.status === 401 || error.authRequired === true);
}

// The session dependency answers every guest request with 401 "not
// authenticated". That string is for developers; users get an explanation.
// Other 401s (e.g. "invalid email or password" from the sign-in form) keep
// their own wording.
export function isSessionAuthFailure(status, detail) {
  return status === 401 && typeof detail === "string" && /^not authenticated$/i.test(detail.trim());
}

// Whether a status-line message is the rewritten session failure (possibly
// prefixed by a caller, e.g. "Couldn't join: …").
export function isAuthRequiredMessage(text) {
  return typeof text === "string" && text.trim().endsWith(AUTH_REQUIRED_MESSAGE);
}
