// The sign-in form's own rules: what it checks before posting and how it
// marks what is wrong. The modal itself lives in controllers/account.js.

// The gate reasons are phrased for the sign-in screen ("Sign in to start
// training"); on the create-account screen the same reason reads as an account
// invitation instead of telling a new user to sign in.
export function authReasonFor(mode, reason) {
  const text = String(reason || "");
  if (mode !== "register") return text;
  return text.replace(/^Sign in to /, "Create an account to ");
}

// Shape the server's EmailStr accepts: a local part, "@", and a dotted domain.
// `type="email"` alone lets "abc@x" through, which only fails after a round trip.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const SLOW_SERVER_NOTE = "The server is starting up. This can take up to a minute.";

// Client-side check before posting; returns the error line or "" when the form
// may be sent.
export function authInputError(mode, { email = "", password = "", confirm = "" } = {}) {
  if (mode === "forgot") {
    if (!email) return "Enter your email.";
    if (!EMAIL_SHAPE.test(email)) return "Enter a valid email address.";
    return "";
  }
  if (mode === "reset") {
    if (password.length < 8) return "Password must be at least 8 characters.";
    if (password !== confirm) return "The two passwords don't match.";
    return "";
  }
  if (!email || !password) return "Enter your email and password.";
  if (mode === "register") {
    if (!EMAIL_SHAPE.test(email)) return "Enter a valid email address.";
    if (password.length < 8) return "Password must be at least 8 characters.";
  }
  return "";
}

// The key press that opened the modal (Enter in the command palette) is still
// bubbling to the document when the modal registers its own keydown listener.
// Events stamped before the modal opened belong to whatever opened it.
export function isOpeningKeystroke(event, openedAt) {
  const stamp = Number(event && event.timeStamp);
  return Number.isFinite(stamp) && stamp > 0 && stamp < openedAt;
}

// Each field that is wrong says so itself, not only the shared error line.
export function markInvalidFields(form, inputError, { email = "", password = "" } = {}) {
  const invalid = {
    email: !!inputError && (!email || /valid email/.test(inputError)),
    password: !!inputError && (!password || /at least 8/.test(inputError)),
    confirm: !!inputError && /don't match/.test(inputError),
  };
  for (const [name, bad] of Object.entries(invalid)) {
    const input = form.querySelector(`[data-auth="${name}"]`);
    if (bad) input?.setAttribute("aria-invalid", "true");
    else input?.removeAttribute("aria-invalid");
  }
}
