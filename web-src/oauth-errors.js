export const OAUTH_ERROR_MESSAGES = Object.freeze({
  google_flow_expired: "Google sign-in expired. Try again.",
  google_flow_invalid: "Google sign-in could not be verified. Try again.",
  google_state_mismatch: "Google sign-in could not be verified. Try again.",
  google_provider_error: "Google sign-in failed. Try again.",
  google_not_configured: "Google sign-in is not available.",
  lichess_flow_expired: "Lichess connection expired. Try again.",
  lichess_flow_invalid: "Lichess connection could not be verified. Try again.",
  lichess_state_mismatch: "Lichess connection could not be verified. Try again.",
  lichess_provider_error: "Lichess connection failed. Try again.",
  lichess_account_taken: "That Lichess account is already linked to another user.",
});

const OAUTH_ERRORS = new Set(Object.keys(OAUTH_ERROR_MESSAGES));

export function oauthErrorFromUrl(href) {
  let url;
  try {
    url = new URL(String(href), "http://prepforge.local/");
  } catch (_) {
    return null;
  }
  const code = url.searchParams.get("oauth_error");
  if (!code || !OAUTH_ERRORS.has(code)) return null;
  url.searchParams.delete("oauth_error");
  return {
    code,
    provider: code.startsWith("google_") ? "google" : "lichess",
    message: OAUTH_ERROR_MESSAGES[code],
    cleanHref: `${url.pathname}${url.search}${url.hash}`,
  };
}
