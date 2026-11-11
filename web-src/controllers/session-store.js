// The last session the server confirmed, kept on this device so a reload opens
// the workspace at once; refreshAuthStatus confirms it in the background.
const SESSION_KEY = "prepforge.session";
const FIELDS = ["id", "display_name", "email", "plan", "has_password", "repertoire_limit", "repertoire_count"];

export function storeSession(me) {
  try {
    if (me?.id) localStorage.setItem(SESSION_KEY, JSON.stringify(Object.fromEntries(FIELDS.map((k) => [k, me[k]]))));
    else localStorage.removeItem(SESSION_KEY);
  } catch (_) {
    /* ignore storage errors */
  }
}

export function storedSession() {
  try {
    const me = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
    return me?.id ? me : null;
  } catch (_) {
    return null;
  }
}
