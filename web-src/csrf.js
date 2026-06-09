// CSRF double-submit helper for the SaaS FastAPI backend.
//
// The API issues a non-HttpOnly `pf_csrf` cookie on safe requests and requires
// unsafe methods to echo it in the `X-CSRF-Token` header (see
// api/middleware.py::CSRFMiddleware). The legacy stdlib server had no CSRF, so
// the SPA never sent the header — every POST against FastAPI 403s until this
// wires the token in.
//
// Deps are injected (fetch, cookie getter) so the token source is unit-testable
// without a DOM, matching the engine/ modules' style.

export const CSRF_COOKIE = "pf_csrf";
export const CSRF_HEADER = "X-CSRF-Token";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS", "TRACE"]);

export function isSafeMethod(method) {
  return SAFE_METHODS.has(String(method || "GET").toUpperCase());
}

export function readCsrfCookie(cookieString) {
  const source =
    cookieString === undefined
      ? typeof document === "undefined"
        ? ""
        : document.cookie
      : cookieString;
  const match = String(source || "").match(/(?:^|;\s*)pf_csrf=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : null;
}

// Returns a function that resolves the current CSRF token, bootstrapping via
// GET /api/csrf if the cookie isn't set yet. The bootstrap is de-duplicated:
// concurrent unsafe requests on first load share one in-flight call so we don't
// mint multiple tokens (the last cookie would win and invalidate the others).
export function createCsrfTokenSource({
  fetchImpl,
  cookieGetter,
} = {}) {
  const doFetch = fetchImpl || ((...args) => fetch(...args));
  const getCookie =
    cookieGetter ||
    (() => (typeof document === "undefined" ? "" : document.cookie));
  let inflight = null;

  return async function getCsrfToken() {
    const existing = readCsrfCookie(getCookie());
    if (existing) return existing;
    if (!inflight) {
      inflight = doFetch("/api/csrf", {
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
      })
        .then((response) => {
          if (!response.ok) throw new Error("CSRF bootstrap failed");
          return response.json();
        })
        .then((payload) => payload.csrf_token || readCsrfCookie(getCookie()))
        .finally(() => {
          inflight = null;
        });
    }
    return inflight;
  };
}
