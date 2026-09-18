const LICHESS_KEY = "prepforge.lichess_username";

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
  onReload = () => window.location.reload(),
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
    // The player's own strength feeds Maia's AUTO rating; resolve it (cached)
    // whenever the linked account changes. Fire-and-forget — AUTO falls back
    // until it lands.
    refreshAutoMaiaRating();
  }

  // The account chip represents the PrepForge session. A linked Lichess identity
  // is optional and remains a separate connection shown in the signed-in menu.
  function renderAccountChip() {
    const chip = document.getElementById("account-chip");
    const label = document.getElementById("account-label");
    if (!chip || !label) return;
    const name = appState.accountUsername || appState.lichessUsername;
    if (appState.signedIn) {
      chip.classList.add("is-connected");
      label.textContent = name || "Account";
      chip.setAttribute("aria-haspopup", "menu");
      chip.title = `Signed in as ${name || "your account"}`;
    } else {
      chip.classList.remove("is-connected");
      label.textContent = "Sign in";
      // A guest chip is a single action, not a menu — drop the popup affordance.
      chip.removeAttribute("aria-haspopup");
      chip.setAttribute("aria-expanded", "false");
      chip.title = "Sign in to PrepForge";
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
  // them up front so a guest gets the sign-in modal instead of a cryptic 401.
  function requireSignIn(message = "Sign in (or create an account) to continue") {
    if (appState.signedIn) return true;
    setStatus(message, { severity: "warning" });
    openAuthModal("login");
    return false;
  }

  // The sign-in / create-account modal. Google (when configured) is the primary
  // path; email/password is the always-available fallback.
  function openAuthModal(mode = "login") {
    const existing = document.querySelector(".modal-overlay.auth-overlay");
    if (existing) {
      // The modal registers a document-level keydown listener on open, so a bare
      // remove() here would orphan it.
      if (typeof existing._closeAuthModal === "function") existing._closeAuthModal();
      else existing.remove();
    }
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay auth-overlay";
    const providers = appState.authProviders || { google: false, password: true };
    const render = (currentMode) => {
      const isRegister = currentMode === "register";
      const title = isRegister ? "Create account" : "Sign in";
      const googleBlock = providers.google
        ? `<button class="btn primary auth-google" data-action="google" type="button">Continue with Google</button>
         <div class="auth-divider"><span>or use email</span></div>`
        : "";
      overlay.innerHTML = `
      <div class="modal auth-modal" role="dialog" aria-modal="true" aria-label="${title}">
        <div class="modal-title">${title}</div>
        <div class="modal-body">
          ${googleBlock}
          <label class="modal-field"><span>Email</span>
            <input type="email" data-auth="email" autocomplete="email" /></label>
          <label class="modal-field"><span>Password</span>
            <input type="password" data-auth="password"
              autocomplete="${isRegister ? "new-password" : "current-password"}" /></label>
          <p class="auth-error" data-auth="error" role="alert" hidden></p>
        </div>
        <div class="modal-footer">
          <button class="btn ghost" data-action="toggle" type="button">${
            isRegister ? "Have an account? Sign in" : "New here? Create account"
          }</button>
          <button class="btn primary" data-action="submit" type="button">${
            isRegister ? "Create account" : "Sign in"
          }</button>
        </div>
      </div>`;
      overlay.dataset.mode = currentMode;
      const emailInput = overlay.querySelector('[data-auth="email"]');
      if (emailInput) emailInput.focus();
    };
    render(mode);
    document.body.appendChild(overlay);
    // render() runs before the overlay is attached, so focus again now.
    overlay.querySelector('[data-auth="email"]')?.focus();

    const close = () => {
      document.removeEventListener("keydown", onKey);
      overlay.remove();
    };
    // Tab/command-palette navigation uses this same teardown path.
    overlay._closeAuthModal = close;
    const showError = (msg) => {
      const el = overlay.querySelector('[data-auth="error"]');
      if (el) {
        el.textContent = msg;
        el.hidden = !msg;
      }
    };
    const submit = async () => {
      const currentMode = overlay.dataset.mode;
      const email = overlay.querySelector('[data-auth="email"]').value.trim();
      const password = overlay.querySelector('[data-auth="password"]').value;
      if (!email || !password) {
        showError("Enter your email and password.");
        return;
      }
      if (currentMode === "register" && password.length < 8) {
        showError("Password must be at least 8 characters.");
        return;
      }
      showError("");
      const submitBtn = overlay.querySelector('[data-action="submit"]');
      if (submitBtn) submitBtn.disabled = true;
      try {
        const endpoint = currentMode === "register" ? "/api/auth/register" : "/api/auth/login";
        await postJson(endpoint, { email, password });
        close();
        // A fresh session changes every owner-scoped view — reload for a clean slate.
        onReload();
      } catch (error) {
        showError(error.message || "Sign-in failed.");
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
    document.addEventListener("keydown", onKey);
    overlay.addEventListener("click", (event) => {
      const action = event.target?.dataset?.action;
      if (event.target === overlay) {
        close();
      } else if (action === "google") {
        window.location.assign("/api/auth/google/login");
      } else if (action === "toggle") {
        render(overlay.dataset.mode === "register" ? "login" : "register");
      } else if (action === "submit") {
        submit();
      }
    });
  }

  // Guest → the chip is a single sign-in action. Signed in → it toggles the
  // account menu.
  function onAccountChipClick() {
    if (!appState.signedIn) {
      openAuthModal("login");
      return;
    }
    toggleAccountMenu();
  }

  function openAccountMenu() {
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
      `<button type="button" role="menuitem" data-action="signout">Sign out</button>`,
    ];
    menu.innerHTML = items.join("");
    menu.hidden = false;
    chip.setAttribute("aria-expanded", "true");
    // Drop the menu under the chip, right-aligned and clamped to the viewport.
    const cr = chip.getBoundingClientRect();
    const rect = menu.getBoundingClientRect();
    const left = Math.max(8, Math.min(cr.right - rect.width, window.innerWidth - rect.width - 8));
    const top = Math.max(8, Math.min(cr.bottom + 6, window.innerHeight - rect.height - 8));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.querySelectorAll("button").forEach((button) => {
      button.addEventListener("click", () => handleAccountMenuAction(button.dataset.action));
    });
  }

  function closeAccountMenu() {
    const menu = document.getElementById("account-menu");
    if (menu) menu.hidden = true;
    const chip = document.getElementById("account-chip");
    if (chip) chip.setAttribute("aria-expanded", "false");
  }

  function toggleAccountMenu() {
    const menu = document.getElementById("account-menu");
    if (menu && !menu.hidden) closeAccountMenu();
    else openAccountMenu();
  }

  async function handleAccountMenuAction(action) {
    closeAccountMenu();
    if (action === "signout") {
      await signOut();
    } else if (action === "connect-lichess") {
      startLichessOAuth();
    }
  }

  // Ask the server whether this browser's session is a real account or a guest,
  // and capture the stable username for the account chip.
  async function refreshAuthStatus() {
    try {
      const status = await api("/api/auth/status");
      appState.signedIn = !!status.signed_in;
      appState.accountUsername = status.username || null;
      appState.accountUserId = status.user_id || null;
    } catch (_) {
      appState.signedIn = false;
      appState.accountUsername = null;
      appState.accountUserId = null;
    }
    renderAccountChip();
  }

  async function signOut() {
    const confirmed = await showConfirmModal({
      title: "Sign out?",
      body:
        "Signs you out on this browser. Your saved repertoires and games stay on your " +
        "account and return when you sign back in with Lichess.",
      okLabel: "Sign out",
      cancelLabel: "Stay signed in",
      tone: "danger",
    });
    if (!confirmed) return;
    try {
      await postJson("/api/auth/signout", {});
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
    const chip = document.getElementById("replay-account");
    if (chip) {
      chip.textContent = appState.lichessUsername || "not connected";
      chip.classList.toggle("is-connected", !!appState.lichessUsername);
    }
    const btn = document.getElementById("lichess-compare-btn");
    if (btn) btn.disabled = !appState.lichessUsername;
  }

  // Pull the server's stored Lichess connection state. The watcher remains in
  // app.js because it owns the finished-game toast and navigation callbacks.
  async function refreshLichessStatus() {
    try {
      const status = await api("/api/lichess/status");
      setLichessUsername(status.connected ? status.username : "");
      if (status.connected) onLichessConnected();
    } catch (_) {
      renderAccountChip();
    }
  }

  // Open Lichess sign-in in a popup; the callback page postMessages back, and
  // polling remains as a fallback if the message is blocked.
  function startLichessOAuth() {
    const w = 520;
    const h = 660;
    const left = window.screenX + Math.max(0, (window.outerWidth - w) / 2);
    const top = window.screenY + Math.max(0, (window.outerHeight - h) / 2);
    const popup = window.open(
      "/oauth/login",
      "lichess-oauth",
      `width=${w},height=${h},left=${left},top=${top}`,
    );
    setStatus("Opening Lichess sign-in...");
    const onMessage = (event) => {
      if (!event.data || event.data.type !== "lichess-oauth") return;
      window.removeEventListener("message", onMessage);
      if (event.data.ok) {
        void refreshLichessStatus();
        // Login rebinds the session to the account profile → refresh auth state.
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
        const status = await api("/api/lichess/status");
        if (status.connected) {
          window.clearInterval(poll);
          window.removeEventListener("message", onMessage);
          setLichessUsername(status.username);
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
    openAuthModal,
    onAccountChipClick,
    openAccountMenu,
    closeAccountMenu,
    toggleAccountMenu,
    handleAccountMenuAction,
    refreshAuthStatus,
    signOut,
    syncReplayControls,
    refreshLichessStatus,
    startLichessOAuth,
  };
}
