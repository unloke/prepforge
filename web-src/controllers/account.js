import {
  AUTH_REQUIRED_MESSAGE,
  clearPendingAction,
  isPendingActionId,
  markAuthReturn,
  savePendingAction,
} from "../auth-gate.js";

const LICHESS_KEY = "prepforge.lichess_username";
// After the guest dismisses the sign-in modal, a burst of 401s from the same
// action must not pop it straight back open.
const AUTH_PROMPT_COOLDOWN_MS = 10_000;

// The API caps passwords at 200 characters (ResetPasswordRequest). Mirroring it on
// the input keeps a long passphrase from being rejected as an opaque 422.
const PASSWORD_MAX = 200;

// Account/auth and Lichess connection UI live behind this controller so app.js
// does not also own the session boundary. The controller deliberately receives
// the app services it needs instead of importing the application singleton.
export function createAccountController({
  appState,
  api,
  postJson,
  setStatus,
  escapeHtml,
  showConfirmModal,
  refreshAutoMaiaRating,
  onLichessConnected = () => {},
  onLichessAccountsChanged = () => {},
  onOpenSettings = () => {},
  // Settings → Account (profile, password, plan, export, delete).
  onOpenAccount = () => onOpenSettings(),
  onReload = () => window.location.reload(),
  // R-03: sign-out must coordinate the local outbox first. The app owns the
  // outbox, so it hands in a hook that persists + flushes and reports how much
  // work could NOT be saved ({ pending }). Drafts are always kept locally under
  // this owner's key — never sent as another account.
  beforeSignOut = null,
}) {
  function getStoredLichessUsername() {
    try {
      return localStorage.getItem(LICHESS_KEY);
    } catch (_) {
      return null;
    }
  }

  function setLichessUsername(username) {
    const cleaned = (username || "").trim();
    appState.lichessUsername = cleaned || null;
    if (cleaned) {
      try {
        localStorage.setItem(LICHESS_KEY, cleaned);
      } catch (_) {
        /* ignore storage errors */
      }
    } else {
      try {
        localStorage.removeItem(LICHESS_KEY);
      } catch (_) {
        /* ignore storage errors */
      }
    }
    renderAccountChip();
    syncReplayControls();
    onLichessAccountsChanged();
    // The player's own strength feeds Maia's AUTO rating; resolve it (cached)
    // whenever the linked account changes. Fire-and-forget — AUTO falls back
    // until it lands.
    refreshAutoMaiaRating();
  }

  // The account chip represents the PrepForge session. A linked Lichess identity
  // is optional and remains a separate connection shown in the signed-in menu.
  // The account lives at the foot of the rail (avatar + name, the label fades
  // in with the rail) and, on mobile where the rail is hidden, in the More
  // sheet. Both render from the same signed-in state.
  function renderAccountChip() {
    const chip = document.getElementById("account-chip");
    const label = document.getElementById("account-label");
    if (!chip || !label) return;
    const name = appState.accountUsername || appState.lichessUsername;
    const sub = document.getElementById("account-sub");
    const initial = name ? String(name).trim().charAt(0).toUpperCase() : "";
    const paintAvatar = (el) => {
      if (!el) return;
      el.classList.toggle("is-guest", !appState.signedIn);
      if (appState.signedIn && initial) el.textContent = initial;
    };
    paintAvatar(document.getElementById("account-avatar"));
    paintAvatar(document.getElementById("sheet-account-avatar"));
    const sheetLabel = document.getElementById("sheet-account-label");
    const sheetItem = document.getElementById("sheet-account");
    if (appState.signedIn) {
      chip.classList.add("is-connected");
      label.textContent = name || "Account";
      if (sub) sub.textContent = appState.lichessUsername ? `Lichess · ${appState.lichessUsername}` : "Account";
      if (sheetLabel) sheetLabel.textContent = name || "Account";
      chip.setAttribute("aria-haspopup", "menu");
      chip.title = `Signed in as ${name || "your account"}`;
      if (sheetItem) {
        sheetItem.setAttribute("aria-haspopup", "menu");
        if (!sheetItem.hasAttribute("aria-expanded")) sheetItem.setAttribute("aria-expanded", "false");
      }
    } else {
      chip.classList.remove("is-connected");
      label.textContent = "Sign in";
      if (sub) sub.textContent = "Save your library";
      if (sheetLabel) sheetLabel.textContent = "Sign in";
      // A guest chip is a single action, not a menu — drop the popup affordance.
      chip.removeAttribute("aria-haspopup");
      chip.setAttribute("aria-expanded", "false");
      chip.title = "Sign in to PrepForge";
      if (sheetItem) {
        sheetItem.removeAttribute("aria-haspopup");
        sheetItem.removeAttribute("aria-expanded");
      }
    }
  }

  // Which sign-in methods the server offers (Google when configured;
  // email/password always). Fetched once; drives the auth modal.
  async function refreshAuthProviders() {
    try {
      appState.authProviders = await api("/api/auth/providers");
    } catch (_) {
      appState.authProviders = { google: false, password: true };
    }
  }

  // Owner-scoped actions call server endpoints that require an account. Guard
  // them up front so a guest gets the sign-in modal — with the reason shown
  // inside it — instead of a cryptic 401. `pendingActionId` (allowlisted in
  // auth-gate.js) lets the action resume once the sign-in completes.
  function requireSignIn(reason = "Sign in (or create an account) to continue", pendingActionId = null, pendingData = null) {
    if (appState.signedIn) return true;
    openAuthModal("login", { notice: reason, pendingAction: pendingActionId, pendingData });
    return false;
  }

  let authDismissedAt = 0;

  function isAuthModalOpen() {
    return typeof document !== "undefined" && !!document.querySelector?.(".modal-overlay.auth-overlay");
  }

  // An API call answered 401: show the sign-in modal with an explanation
  // instead of the backend's "not authenticated". Never stacks a second modal
  // and backs off right after the user closed one.
  function handleAuthRequired(reason = "") {
    if (isAuthModalOpen()) return;
    const message =
      reason ||
      (appState.signedIn
        ? "Your session has ended — sign in again to continue."
        : AUTH_REQUIRED_MESSAGE);
    if (Date.now() - authDismissedAt < AUTH_PROMPT_COOLDOWN_MS) {
      setStatus(message, { severity: "warning" });
      return;
    }
    openAuthModal("login", { notice: message });
  }

  // The sign-in / create-account modal. Google (when configured) is the primary
  // path; email/password is the always-available fallback. Two recovery modes
  // share the shell: "forgot" asks for the email a reset link goes to, and
  // "reset" (opened from that link's ?reset_password=… token) sets the new
  // password.
  const AUTH_MODES = {
    login: { title: "Sign in", submit: "Sign in" },
    register: { title: "Create account", submit: "Create account" },
    forgot: { title: "Reset your password", submit: "Send reset link" },
    reset: { title: "Choose a new password", submit: "Set password" },
  };

  function openAuthModal(mode = "login", { resetToken = null, notice = "", pendingAction = null, pendingData = null } = {}) {
    const existing = document.querySelector(".modal-overlay.auth-overlay");
    if (existing) {
      // The modal registers a document-level keydown listener on open, so a bare
      // remove() here would orphan it. Replacing it is not a user dismissal:
      // this open decides the pending action below.
      if (typeof existing._closeAuthModal === "function") existing._closeAuthModal({ replaced: true });
      else existing.remove();
    }
    // Remember the interrupted action so it resumes after the sign-in reload
    // (or the Google redirect). Opening without one clears any stale intent.
    if (isPendingActionId(pendingAction)) {
      const route = typeof window !== "undefined" ? window.location?.hash || "" : "";
      savePendingAction(pendingAction, { route, data: pendingData });
    } else {
      clearPendingAction();
    }
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay auth-overlay";
    const providers = appState.authProviders || { google: false, password: true };
    let token = resetToken;
    // Why the modal opened ("Sign in to start training"): shown on the sign-in
    // and create-account screens and kept across the toggle between them.
    const reason = String(notice || "");
    const render = (currentMode, { email = "", message = "" } = {}) => {
      const spec = AUTH_MODES[currentMode] || AUTH_MODES.login;
      const signing = currentMode === "login" || currentMode === "register";
      const googleBlock =
        providers.google && signing
          ? `<button class="btn primary auth-google" data-action="google" type="button">Continue with Google</button>
         <div class="auth-divider"><span>or use email</span></div>`
          : "";
      let fields = "";
      if (currentMode === "reset") {
        fields = `
          <label class="modal-field" for="auth-password"><span>New password (8+ characters)</span>
            <input id="auth-password" type="password" data-auth="password" autocomplete="new-password" maxlength="${PASSWORD_MAX}" /></label>
          <label class="modal-field" for="auth-confirm"><span>Repeat new password</span>
            <input id="auth-confirm" type="password" data-auth="confirm" autocomplete="new-password" maxlength="${PASSWORD_MAX}" /></label>`;
      } else {
        fields = `
          <label class="modal-field" for="auth-email"><span>Email</span>
            <input id="auth-email" type="email" data-auth="email" autocomplete="email" value="${escapeHtml(email)}" /></label>`;
        if (currentMode !== "forgot") {
          fields += `
          <label class="modal-field" for="auth-password"><span>Password</span>
            <input id="auth-password" type="password" data-auth="password"
              autocomplete="${currentMode === "register" ? "new-password" : "current-password"}" /></label>`;
        }
      }
      const intro =
        currentMode === "forgot"
          ? '<p class="modal-copy">Enter the email you signed up with. If it has an account, a single-use reset link is sent there.</p>'
          : "";
      const forgotLink =
        currentMode === "login"
          ? '<button class="auth-link" data-action="forgot" type="button">Forgot password?</button>'
          : "";
      const secondary =
        currentMode === "login"
          ? "New here? Create account"
          : currentMode === "register"
            ? "Have an account? Sign in"
            : "Back to sign in";
      const reasonBlock =
        reason && signing ? `<p class="auth-reason" data-auth="reason">${escapeHtml(reason)}</p>` : "";
      overlay.innerHTML = `
      <div class="modal auth-modal" role="dialog" aria-modal="true" aria-labelledby="auth-modal-title">
        <div class="modal-title auth-modal-title">
          <span id="auth-modal-title">${spec.title}</span>
          <button class="auth-close" data-action="close" type="button" aria-label="Close" title="Close">×</button>
        </div>
        <div class="modal-body">
          ${reasonBlock}
          ${googleBlock}
          ${intro}
          ${fields}
          ${forgotLink}
          <p class="auth-notice" data-auth="notice" role="status"${message ? "" : " hidden"}>${escapeHtml(message)}</p>
          <p class="auth-error" data-auth="error" role="alert"></p>
        </div>
        <div class="modal-footer auth-footer">
          <button class="auth-link auth-switch" data-action="toggle" type="button">${secondary}</button>
          <button class="btn primary" data-action="submit" type="button">${spec.submit}</button>
        </div>
      </div>`;
      overlay.dataset.mode = currentMode;
      overlay.querySelector("input")?.focus();
    };
    // Sign-in / create-account screens show the reason as their lead line;
    // the recovery screens fall back to the plain notice slot.
    render(mode, { message: mode === "login" || mode === "register" ? "" : reason });
    document.body.appendChild(overlay);
    // render() runs before the overlay is attached, so focus again now.
    overlay.querySelector("input")?.focus();

    // `signedIn`: closing because the sign-in succeeded (keep the pending
    // action for the reload). `replaced`: another openAuthModal takes over.
    // Anything else is the user walking away — drop the pending action.
    const close = ({ signedIn = false, replaced = false } = {}) => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onOutsidePointer, true);
      overlay.remove();
      if (!signedIn && !replaced) {
        clearPendingAction();
        authDismissedAt = Date.now();
      }
      // Abandoning a reset (Escape, overlay click, palette close) must scrub the
      // token from the URL too, or it stays bookmarkable/shareable in history.
      if (overlay.dataset.mode === "reset") clearResetParam();
    };
    // Tab/command-palette navigation uses this same teardown path.
    overlay._closeAuthModal = close;
    // The error line keeps its reserved space (styles.css .auth-error), so a
    // message appearing never makes the dialog jump.
    const showError = (msg) => {
      const el = overlay.querySelector('[data-auth="error"]');
      if (el) el.textContent = msg || "";
    };
    const value = (name) => overlay.querySelector(`[data-auth="${name}"]`)?.value ?? "";
    const submit = async () => {
      const currentMode = overlay.dataset.mode;
      const email = value("email").trim();
      const password = value("password");
      if (currentMode === "forgot") {
        if (!email) return showError("Enter your email.");
      } else if (currentMode === "reset") {
        if (password.length < 8) return showError("Password must be at least 8 characters.");
        if (password !== value("confirm")) return showError("The two passwords don't match.");
      } else {
        if (!email || !password) return showError("Enter your email and password.");
        if (currentMode === "register" && password.length < 8) {
          return showError("Password must be at least 8 characters.");
        }
      }
      showError("");
      const submitBtn = overlay.querySelector('[data-action="submit"]');
      if (submitBtn) submitBtn.disabled = true;
      try {
        if (currentMode === "forgot") {
          const result = await postJson("/api/auth/password/forgot", { email });
          // Dev builds hand the token back (no mail server locally): go straight on.
          if (result && result.dev_reset_token) {
            token = result.dev_reset_token;
            render("reset", { message: "Development build: the reset link was opened for you." });
            return;
          }
          render("login", {
            email,
            message: "If that email has an account, a reset link is on its way. It works once and expires soon.",
          });
          return;
        }
        if (currentMode === "reset") {
          await postJson("/api/auth/password/reset", { token, password });
          clearResetParam();
          render("login", { message: "Password updated. Sign in with the new one — other devices were signed out." });
          return;
        }
        const endpoint = currentMode === "register" ? "/api/auth/register" : "/api/auth/login";
        await postJson(endpoint, { email, password });
        markAuthReturn({ href: window.location.href });
        close({ signedIn: true });
        // A fresh session changes every owner-scoped view — reload for a clean
        // slate; the pending action (if any) resumes after it.
        onReload();
      } catch (error) {
        showError(error.message || "Something went wrong.");
        if (submitBtn) submitBtn.disabled = false;
      }
    };
    const onKey = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      } else if (event.key === "Enter") {
        event.preventDefault();
        submit();
      }
    };
    // The overlay itself is click-through (styles.css: rail tabs stay usable
    // behind the dim layer), so "click the backdrop to close" is detected at
    // the document: a press outside the dialog dismisses it, and the press
    // still reaches whatever it landed on.
    const onOutsidePointer = (event) => {
      const dialog = overlay.querySelector(".auth-modal");
      if (dialog && event.target && typeof dialog.contains === "function" && !dialog.contains(event.target)) {
        close();
      }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onOutsidePointer, true);
    overlay.addEventListener("click", (event) => {
      const action = event.target?.dataset?.action;
      const currentMode = overlay.dataset.mode;
      if (event.target === overlay || action === "close") {
        close();
      } else if (action === "google") {
        // The Google round trip lands on "/?signed_in=1"; the pending action
        // lives in sessionStorage and survives it.
        markAuthReturn({ href: window.location.href });
        window.location.assign("/api/auth/google/login");
      } else if (action === "forgot") {
        render("forgot", { email: value("email").trim() });
      } else if (action === "toggle") {
        if (currentMode === "reset") clearResetParam();
        render(currentMode === "login" ? "register" : "login", { email: value("email").trim() });
      } else if (action === "submit") {
        submit();
      }
    });
  }

  // The reset link lands on /?reset_password=<token>. Drop the token from the
  // address bar once used (or abandoned) so it is not bookmarked or shared.
  function clearResetParam() {
    try {
      const url = new URL(window.location.href);
      if (!url.searchParams.has("reset_password")) return;
      url.searchParams.delete("reset_password");
      window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
    } catch (_) {
      /* ignore */
    }
  }

  // Boot hook: a reset link opens the modal in reset mode.
  function openResetFromUrl() {
    let token = null;
    try {
      token = new URL(window.location.href).searchParams.get("reset_password");
    } catch (_) {
      token = null;
    }
    if (!token) return false;
    openAuthModal("reset", { resetToken: token });
    return true;
  }

  // The control that opened the menu (rail chip or the More sheet's account
  // item): it carries aria-expanded and gets focus back on Escape.
  let menuTrigger = null;
  // What the open menu is positioned against, and the observer that keeps it
  // there while the hover/focus rail grows or collapses underneath it.
  let menuAnchor = null;
  let railObserver = null;

  // Rail account: open beside the rail, bottom-aligned with the avatar.
  // Mobile (rail hidden, opened from the More sheet): sit above the tab bar.
  function positionAccountMenu() {
    const menu = document.getElementById("account-menu");
    if (!menu || menu.hidden || !menuAnchor) return;
    const rect = menu.getBoundingClientRect();
    const cr = menuAnchor.getBoundingClientRect();
    let left;
    let top;
    if (cr.width > 0) {
      left = cr.right + 8;
      top = cr.bottom - rect.height;
    } else {
      // Sit just above the sheet's account item, so the menu never covers the
      // item that toggles it (the sheet grows as items are added).
      const item = document.getElementById("sheet-account")?.getBoundingClientRect();
      if (item && item.width > 0) {
        left = item.left;
        top = item.top - rect.height - 6;
      } else {
        left = (window.innerWidth - rect.width) / 2;
        top = window.innerHeight - rect.height - 74;
      }
    }
    left = Math.max(8, Math.min(left, window.innerWidth - rect.width - 8));
    top = Math.max(8, Math.min(top, window.innerHeight - rect.height - 8));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }

  // The desktop rail expands as an overlay on hover / keyboard focus and
  // collapses once the pointer or focus moves into the menu. Re-anchor on
  // every rail size change so the menu tracks the trigger instead of hanging
  // at the expanded rail's edge.
  function followRailWidth(anchor) {
    stopFollowingRail();
    const rail = anchor?.closest?.(".rail");
    if (!rail || typeof ResizeObserver !== "function") return;
    railObserver = new ResizeObserver(() => positionAccountMenu());
    railObserver.observe(rail);
  }

  function stopFollowingRail() {
    if (railObserver) railObserver.disconnect();
    railObserver = null;
  }

  // Guest → the chip is a single sign-in action. Signed in → it toggles the
  // account menu. `trigger` defaults to the rail chip; `anchor` only positions.
  function onAccountChipClick(anchor = null, { trigger = null } = {}) {
    if (!appState.signedIn) {
      openAuthModal("login");
      return;
    }
    toggleAccountMenu(anchor, { trigger });
  }

  function openAccountMenu(anchor = null, { trigger = null } = {}) {
    const chip = document.getElementById("account-chip");
    const menu = document.getElementById("account-menu");
    if (!chip || !menu) return;
    const name = appState.accountUsername || appState.lichessUsername || "your account";
    const lichessItem = appState.lichessUsername
      ? `<div class="context-section">Lichess: ${escapeHtml(appState.lichessUsername)}</div>`
      : `<button type="button" role="menuitem" data-action="connect-lichess">Connect Lichess</button>`;
    const items = [
      `<div class="context-section">Signed in as ${escapeHtml(name)}</div>`,
      lichessItem,
      // One entry: "Account" and "Settings" used to open the same page (the
      // Account card is the top of Settings), which read as a duplicate.
      `<button type="button" role="menuitem" data-action="settings">Account &amp; settings</button>`,
      `<button type="button" role="menuitem" data-action="signout">Sign out</button>`,
    ];
    menu.innerHTML = items.join("");
    menu.hidden = false;
    if (menuTrigger && menuTrigger !== (trigger || chip)) {
      menuTrigger.setAttribute("aria-expanded", "false");
    }
    menuTrigger = trigger || chip;
    menuTrigger.setAttribute("aria-expanded", "true");
    menuAnchor = anchor || chip;
    positionAccountMenu();
    followRailWidth(menuAnchor);
    menu.querySelectorAll("button").forEach((button) => {
      button.addEventListener("click", () => handleAccountMenuAction(button.dataset.action));
    });
    menu.querySelector('[role="menuitem"]')?.focus();
  }

  // restoreFocus (Escape / explicit toggle) returns focus to the trigger when
  // it is still on screen; outside clicks and menu actions leave focus alone.
  function closeAccountMenu({ restoreFocus = false } = {}) {
    const menu = document.getElementById("account-menu");
    const wasOpen = !!menu && !menu.hidden;
    if (menu) menu.hidden = true;
    stopFollowingRail();
    menuAnchor = null;
    const chip = document.getElementById("account-chip");
    if (chip) chip.setAttribute("aria-expanded", "false");
    const trigger = menuTrigger;
    menuTrigger = null;
    if (!trigger) return;
    trigger.setAttribute("aria-expanded", "false");
    if (wasOpen && restoreFocus && trigger.getClientRects?.().length) trigger.focus();
  }

  function isAccountMenuOpen() {
    const menu = document.getElementById("account-menu");
    return !!menu && !menu.hidden;
  }

  function toggleAccountMenu(anchor = null, { trigger = null } = {}) {
    if (isAccountMenuOpen()) closeAccountMenu({ restoreFocus: true });
    else openAccountMenu(anchor, { trigger });
  }

  async function handleAccountMenuAction(action) {
    closeAccountMenu();
    if (action === "signout") {
      await signOut();
    } else if (action === "settings") {
      onOpenSettings();
    } else if (action === "account") {
      onOpenAccount();
    } else if (action === "connect-lichess") {
      startLichessOAuth();
    }
  }

  async function refreshAuthStatus() {
    try {
      const me = await api("/api/auth/me");
      appState.signedIn = !!me.id;
      appState.accountUsername = me.display_name || me.email || null;
      appState.accountUserId = me.id || null;
      appState.account = {
        email: me.email || "",
        displayName: me.display_name || "",
        plan: me.plan || "free",
        hasPassword: !!me.has_password,
      };
    } catch (_) {
      appState.signedIn = false;
      appState.accountUsername = null;
      appState.accountUserId = null;
      appState.account = null;
    }
    renderAccountChip();
  }

  async function signOut() {
    const confirmed = await showConfirmModal({
      title: "Sign out?",
      body:
        "Signs you out on this browser. Your saved repertoires and games stay on your " +
        "account and return when you sign back in.",
      okLabel: "Sign out",
      cancelLabel: "Stay signed in",
      tone: "danger",
    });
    if (!confirmed) return;
    // R-03: coordinate pending local work BEFORE the session ends, while the
    // flush can still authenticate. Whatever cannot be saved stays in the
    // durable outbox (owner-scoped) and replays on the next sign-in.
    let pending = 0;
    if (beforeSignOut) {
      try {
        const result = await beforeSignOut();
        pending = (result && result.pending) || 0;
      } catch (_) {
        // Coordination is best-effort; the drafts survive locally either way.
        pending = 0;
      }
    }
    if (pending > 0) {
      const proceed = await showConfirmModal({
        title: `Sign out with ${pending} unsaved change${pending === 1 ? "" : "s"}?`,
        body:
          `${pending} change${pending === 1 ? "" : "s"} could not be saved just now. ` +
          `They are kept on this device and will sync after you sign back in.`,
        okLabel: "Sign out anyway",
        cancelLabel: "Stay signed in",
        tone: "danger",
      });
      if (!proceed) {
        setStatus(
          `Still signed in — ${pending} unsaved change${pending === 1 ? "" : "s"} kept for the next sync.`,
          { severity: "warning" },
        );
        return;
      }
    }
    try {
      await postJson("/api/auth/logout", {});
    } catch (_) {
      // The session was not rotated server-side; stay put and report the error.
      setStatus("Sign out failed — you are still signed in. Try again.", { severity: "error" });
      return;
    }
    try {
      localStorage.removeItem(LICHESS_KEY);
    } catch (_) {
      /* ignore storage errors */
    }
    setStatus("Signed out");
    onReload();
  }

  function syncReplayControls() {
    // Source summary lives only in the composer chips (paintGamesSource /
    // paintScoutSource) — no duplicate toolbar display.
    const btn = document.getElementById("lichess-compare-btn");
    if (btn) btn.disabled = !appState.lichessUsername;
  }

  // Pull the server's stored Lichess connection state. The watcher remains in
  // app.js because it owns the finished-game toast and navigation callbacks.
  async function refreshLichessStatus() {
    try {
      const status = await api("/api/lichess");
      const accounts = Array.isArray(status.accounts) ? status.accounts : [];
      appState.lichessAccounts = accounts;
      const primary = accounts.find((account) => account.is_primary) || accounts[0];
      setLichessUsername(primary ? primary.username : "");
      if (status.linked) onLichessConnected();
    } catch (_) {
      renderAccountChip();
    }
  }

  // Open Lichess sign-in in a popup; the callback page postMessages back, and
  // polling remains as a fallback if the message is blocked.
  function startLichessOAuth() {
    // Linking attaches the Lichess identity to a PrepForge account: the server
    // answers a guest with a 401, which used to open a popup of raw JSON.
    if (!requireSignIn("Sign in to link your Lichess account", "lichess-link")) return false;
    const w = 520;
    const h = 660;
    const left = window.screenX + Math.max(0, (window.outerWidth - w) / 2);
    const top = window.screenY + Math.max(0, (window.outerHeight - h) / 2);
    const popup = window.open(
      "/api/lichess/login",
      "lichess-oauth",
      `width=${w},height=${h},left=${left},top=${top}`,
    );
    setStatus("Opening Lichess sign-in...");
    const onMessage = (event) => {
      if (!event.data || event.data.type !== "lichess-oauth") return;
      window.removeEventListener("message", onMessage);
      if (event.data.ok) {
        void refreshLichessStatus();
        // Refresh the linked-account state after the OAuth callback.
        void refreshAuthStatus();
        setStatus(`Lichess: ${event.data.detail}`);
      } else {
        setStatus(`Lichess sign-in failed: ${event.data.detail}`, { severity: "error" });
      }
    };
    window.addEventListener("message", onMessage);
    let tries = 0;
    const poll = window.setInterval(async () => {
      tries += 1;
      try {
        const status = await api("/api/lichess");
        if (status.linked) {
          window.clearInterval(poll);
          window.removeEventListener("message", onMessage);
          const accounts = Array.isArray(status.accounts) ? status.accounts : [];
          appState.lichessAccounts = accounts;
          const primary = accounts.find((account) => account.is_primary) || accounts[0];
          setLichessUsername(primary ? primary.username : status.username || "");
          void refreshAuthStatus();
          onLichessConnected();
          setStatus(`Lichess: ${status.username}`);
          return;
        }
      } catch (_) {
        /* ignore */
      }
      if (tries > 120 || (popup && popup.closed)) window.clearInterval(poll);
    }, 1500);
  }

  return {
    getStoredLichessUsername,
    setLichessUsername,
    renderAccountChip,
    refreshAuthProviders,
    requireSignIn,
    handleAuthRequired,
    isAuthModalOpen,
    openAuthModal,
    openResetFromUrl,
    onAccountChipClick,
    openAccountMenu,
    closeAccountMenu,
    isAccountMenuOpen,
    toggleAccountMenu,
    handleAccountMenuAction,
    refreshAuthStatus,
    signOut,
    syncReplayControls,
    refreshLichessStatus,
    startLichessOAuth,
  };
}
