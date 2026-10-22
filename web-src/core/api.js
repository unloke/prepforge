import { appState, boards, notices } from "./state.js";
import { hooks } from "./hooks.js";
import { createCsrfTokenSource, headersWithCsrf } from "../csrf.js";
import { withRequestDeadline } from "../sync-queue.js";
import { apiErrorMessage } from "../api-errors.js";
import { AUTH_REQUIRED_MESSAGE, isAuthRequiredMessage, isSessionAuthFailure } from "../auth-gate.js";
import { BUILD_MUTATIONS, announceBuildWrite } from "../build-live.js";

// Shown when a browser-only compute action (whole-game Analyze, Build → Generate)
// can't run because the browser engine is unavailable (page not cross-origin
// isolated). Both run browser-only — there is no server fallback.
export const BROWSER_ENGINE_UNAVAILABLE =
  "Browser engine unavailable — open in a cross-origin-isolated browser to run engines locally";

// Engine-loading lifecycle marks (dev/E2E timing only): records monotonic
// timestamps per (job) so the parallel init windows — Build runner import vs
// Maia ready, Analyze Stockfish vs Maia init — are observable without touching
// any engine result. No-op payload, never awaited by the pipeline.
const engineLifecycleMarks = new Map();
export function engineLifecycleMark(name, origin = performance.now()) {
  const at = Math.round(performance.now() - origin);
  if (!engineLifecycleMarks.has(name)) engineLifecycleMarks.set(name, []);
  engineLifecycleMarks.get(name).push(at);
  try {
    console.debug("[engine-lifecycle]", name, `${at}ms`);
  } catch (_) { /* logging only */ }
  return origin;
}
// True while a 401 is being turned into the sign-in modal, so the modal's own
// fallback warning can't loop back through here.
let routingAuthStatus = false;

// The status line of the notification stack (notices.js). "" or "Ready"
// clears it and resolves any status error.
export function setStatus(message, { severity = "info" } = {}) {
  const text = String(message || "");
  // A guest (or expired session) hit an account-only endpoint: the sign-in
  // modal with an explanation replaces the backend's "not authenticated".
  if (!routingAuthStatus && hooks.authRequired && isAuthRequiredMessage(text)) {
    routingAuthStatus = true;
    try {
      hooks.authRequired();
    } finally {
      routingAuthStatus = false;
    }
    return;
  }
  notices.status(text === "Ready" ? "" : text, { tone: severity });
}

export function setStatusError(message) {
  setStatus(message, { severity: "error" });
}

const getCsrfToken = createCsrfTokenSource();

export async function api(path, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const { timeoutMs = method === "GET" ? 30_000 : 90_000, signal: callerSignal, responseType = "json", ...fetchOptions } = options;
  return withRequestDeadline(async (signal) => {
  // Merge caller headers over the JSON default, then attach the CSRF token on
  // unsafe methods (bootstrapping /api/csrf if the cookie isn't set yet). The
  // FastAPI backend 403s any unsafe request that doesn't echo the cookie.
  const headers = await headersWithCsrf(
    method,
    { "Content-Type": "application/json", [CLIENT_ID_HEADER]: OUTBOX_TAB_ID, ...(options.headers || {}) },
    getCsrfToken,
  );
  signal.throwIfAborted();
  const response = await fetch(path, {
    credentials: "same-origin",
    ...fetchOptions,
    signal,
    headers,
  });
  if (response.ok && responseType === "blob") return response.blob();
  // Read as text first so a non-JSON body (a 500 "Internal Server Error", a 502
  // from the proxy, an HTML error page) surfaces a clear message instead of a raw
  // "Unexpected token 'I' ... is not valid JSON" from response.json().
  const raw = await response.text();
  let payload = {};
  if (raw) {
    try {
      payload = JSON.parse(raw);
    } catch (_) {
      if (!response.ok) {
        const err = new Error(`Server error ${response.status} ${response.statusText}`.trim());
        err.status = response.status;
        throw err;
      }
      throw new Error("Unexpected non-JSON response from server");
    }
  }
  // Keep structured FastAPI detail for conflict recovery and flatten it for display.
  if (!response.ok) {
    const detail = payload.detail;
    // A session 401 reads as an explanation, not the backend's "not
    // authenticated"; setStatus turns it into the sign-in modal.
    const authRequired = isSessionAuthFailure(response.status, detail);
    const message = authRequired
      ? AUTH_REQUIRED_MESSAGE
      : apiErrorMessage(response.status, detail);
    const err = new Error(message);
    err.status = response.status; // lets callers (e.g. Build sync) tell 4xx from 5xx/network
    err.detail = detail;
    if (authRequired) err.authRequired = true;
    if (response.headers && typeof response.headers.get === "function") {
      err.retryAfter = response.headers.get("retry-after");
    }
    throw err;
  }
  return payload;
  }, { signal: callerSignal, timeoutMs, method });
}

// ----- Durable outbox (R-03) -----------------------------------------------
// Build and Train share an owner-scoped IndexedDB outbox.
// crash, or sign-out can't silently drop work the user already did. Operation
// identity survives (Build temp ids, Train attempt UUIDs) — replays after a
// lost response are recognized server-side instead of double-counted.
export const OUTBOX_TAB_ID = Math.random().toString(36).slice(2);
// Sent on every request, so the server can tell which tab made each write.
const CLIENT_ID_HEADER = "X-PF-Client";

export function currentOwnerId() {
  return appState.accountUserId || null;
}

export function downloadText(filename, mime, content) {
  const blob = new Blob([content], { type: mime || "text/plain" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename || "prepforge-export.txt";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

// The route, not the painted view: during a route View Transition the old
// view stays painted for a frame (view-swap.js).
export function activeViewName() {
  return appState.currentView;
}

export function activeBoardController() {
  const name = activeViewName();
  if (name === "analyze") return boards.analysis || null;
  return boards[name] || null;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function localDateString(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// A server timestamp (UTC ISO) as the player's local calendar day. Timestamps
// without an offset are UTC too.
export function localDayOf(iso) {
  const raw = String(iso || "");
  if (!raw.includes("T")) return raw.slice(0, 10); // already a calendar day
  const stamp = /[zZ]$|[+-]\d\d:?\d\d$/.test(raw) ? raw : `${raw}Z`;
  const d = new Date(stamp);
  return Number.isNaN(d.getTime()) ? raw.slice(0, 10) : localDateString(d);
}

export async function postJson(path, body, options = {}) {
  const build = appState.build;
  const owner = currentOwnerId();
  const generation = appState.ownerGeneration;
  // Build writes run one at a time so each is applied on top of the last.
  // The server rebases every edit onto the current tree, so none carries the
  // revision it was made on.
  const mutation = BUILD_MUTATIONS.has(path);
  const previous = mutation ? appState.buildMutationSaving : null;
  const task = (async () => {
    if (previous) await previous.catch(() => {});
    if (owner !== currentOwnerId() || generation !== appState.ownerGeneration) throw new Error("Account changed");
    const before = build?.revision;
    const payload = await api(path, { method: "POST", body: JSON.stringify(body || {}), ...options });
    if (mutation && body?.repertoire_id === build?.repertoire_id) {
      // Exactly the next revision means nobody else wrote in between, so the
      // open tree (which already shows this edit) is now at that revision.
      // Otherwise the change feed fills the gap.
      if (appState.build === build && payload?.revision === before + 1) build.revision = payload.revision;
      announceBuildWrite(body.repertoire_id);
    }
    return payload;
  })();
  if (mutation) appState.buildMutationSaving = task;
  try { return await task; }
  finally { if (appState.buildMutationSaving === task) appState.buildMutationSaving = null; }
}
