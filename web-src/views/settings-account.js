// Settings → Account: the self-service side of the account backend — profile,
// password, plan/billing, data export and account deletion. Rendered into
// #settings-account-body by the Settings view; every action goes through the
// same api()/postJson() helpers (CSRF, error flattening) as the rest of the app.

// The API caps passwords at 200 characters (ChangePasswordRequest). Mirroring it
// here keeps a long passphrase from being rejected as an opaque "Request failed
// (422)" with no field named.
const PASSWORD_MAX = 200;

export function createAccountSection({
  appState,
  api,
  postJson,
  setStatus,
  escapeHtml = escapeText,
  showConfirmModal,
  signOut = async () => {},
  openAuthModal = () => {},
  refreshAuthStatus = async () => {},
  onReload = () => window.location.reload(),
  download = downloadJson,
  navigate = (url) => window.location.assign(url),
}) {
  let billing = null; // { plan, billing_enabled, price_configured } once fetched
  let bound = false;

  function body() {
    return document.getElementById("settings-account-body");
  }

  function row(label, value, action = "") {
    return (
      `<div class="set-row acct-row"><span>${label}</span>` +
      `<span class="acct-value">${value}${action}</span></div>`
    );
  }

  function render() {
    const el = body();
    if (!el) return;
    if (!appState.signedIn) {
      el.innerHTML =
        '<p class="muted hint">You are using PrepForge as a guest. Sign in to keep repertoires, ' +
        "games and training in sync across devices.</p>" +
        '<div class="acct-actions">' +
        '<button type="button" class="btn sm primary" data-acct="signin">Sign in</button>' +
        '<button type="button" class="btn sm" data-acct="register">Create account</button>' +
        "</div>";
      return;
    }
    const account = appState.account || {};
    const email = escapeHtml(account.email || appState.accountUsername || "");
    const name = account.displayName
      ? escapeHtml(account.displayName)
      : '<span class="muted">Not set — your email is shown</span>';
    const method = account.hasPassword ? "Email and password" : "Google";
    const plan = (billing && billing.plan) || account.plan || "free";
    const planPill = `<span class="status-pill ${plan === "pro" ? "ok" : ""}">${plan === "pro" ? "Pro" : "Free"}</span>`;
    let planAction = "";
    if (billing && billing.billing_enabled) {
      if (plan === "pro") {
        planAction = '<button type="button" class="btn sm" data-acct="portal">Manage subscription</button>';
      } else if (billing.price_configured) {
        planAction = '<button type="button" class="btn sm primary" data-acct="upgrade">Upgrade to Pro</button>';
      }
    }
    el.innerHTML =
      '<div class="sub-head"><b>Profile</b></div>' +
      row("Email", `<b>${email}</b>`) +
      row(
        "Display name",
        `<span data-acct-name>${name}</span>`,
        '<button type="button" class="btn sm ghost" data-acct="rename">Edit</button>',
      ) +
      row("Sign-in method", escapeHtml(method)) +
      (account.hasPassword
        ? row(
          "Password",
          '<span class="muted">••••••••</span>',
          '<button type="button" class="btn sm ghost" data-acct="password">Change</button>',
        )
        : "") +
      '<div class="sub-head"><b>Plan</b></div>' +
      row("Current plan", planPill, planAction) +
      '<div class="sub-head"><b>Your data</b></div>' +
      row(
        "Export everything",
        '<span class="muted">Profile, games (PGN), repertoires, training history — one JSON file</span>',
        '<button type="button" class="btn sm" data-acct="export">Download</button>',
      ) +
      row(
        "Sign out on this browser",
        "",
        '<button type="button" class="btn sm" data-acct="signout">Sign out</button>',
      ) +
      '<div class="acct-danger">' +
      '<div><b>Delete account</b><p class="muted small">Removes the account and everything it owns. ' +
      "Copies other people already made of your shared repertoires stay theirs. This cannot be undone.</p></div>" +
      '<button type="button" class="btn sm danger" data-acct="delete">Delete account…</button>' +
      "</div>";
  }

  async function refresh() {
    render();
    if (!appState.signedIn || typeof api !== "function") return;
    try {
      billing = await api("/api/billing/status");
    } catch (_) {
      billing = null;
    }
    render();
  }

  // ---- Actions -------------------------------------------------------------

  async function rename() {
    const current = (appState.account && appState.account.displayName) || "";
    const values = await formModal({
      title: "Display name",
      fields: [{ name: "display_name", label: "Shown on shared repertoires and teams", value: current, maxLength: 120 }],
      okLabel: "Save",
    });
    if (!values) return;
    const me = await api("/api/auth/me", {
      method: "PATCH",
      body: JSON.stringify({ display_name: values.display_name }),
    });
    appState.account = { ...(appState.account || {}), displayName: me.display_name || "" };
    await refreshAuthStatus();
    render();
    setStatus("Display name saved");
  }

  async function changePassword() {
    const values = await formModal({
      title: "Change password",
      fields: [
        { name: "current_password", label: "Current password", type: "password", autocomplete: "current-password", maxLength: PASSWORD_MAX },
        { name: "new_password", label: "New password (8+ characters)", type: "password", autocomplete: "new-password", maxLength: PASSWORD_MAX },
        { name: "confirm", label: "Repeat new password", type: "password", autocomplete: "new-password", maxLength: PASSWORD_MAX },
      ],
      okLabel: "Change password",
      validate: (v) => {
        if (!v.current_password) return "Enter your current password.";
        if (v.new_password.length < 8) return "The new password needs at least 8 characters.";
        if (v.new_password !== v.confirm) return "The two new passwords don't match.";
        return "";
      },
      submit: (v) =>
        postJson("/api/auth/password/change", {
          current_password: v.current_password,
          new_password: v.new_password,
        }),
    });
    if (values) setStatus("Password changed — other devices were signed out");
  }

  async function exportData() {
    setStatus("Preparing your export…");
    const bundle = await api("/api/account/export");
    const stamp = new Date().toISOString().slice(0, 10);
    download(bundle, `prepforge-export-${stamp}.json`);
    setStatus("Export downloaded");
  }

  async function openBilling(kind) {
    const path = kind === "portal" ? "/api/billing/portal" : "/api/billing/checkout";
    const result = await postJson(path, {});
    if (result && result.url) navigate(result.url);
  }

  async function deleteAccount() {
    const first = await showConfirmModal({
      title: "Delete your account?",
      body:
        "This permanently removes your repertoires, games, analyses, training history, teams you own " +
        "and linked accounts, and ends every session. Download an export first if you want a copy.",
      okLabel: "Continue",
      cancelLabel: "Keep my account",
      tone: "danger",
    });
    if (!first) return;
    const values = await formModal({
      title: "Type DELETE to confirm",
      fields: [{ name: "confirm", label: "This cannot be undone", value: "", autocomplete: "off" }],
      okLabel: "Delete account",
      tone: "danger",
      validate: (v) => (v.confirm === "DELETE" ? "" : "Type DELETE in capitals to confirm."),
      submit: (v) =>
        api("/api/account", { method: "DELETE", body: JSON.stringify({ confirm: v.confirm }) }),
    });
    if (!values) return;
    setStatus("Account deleted");
    onReload();
  }

  const ACTIONS = {
    signin: () => openAuthModal("login"),
    register: () => openAuthModal("register"),
    rename,
    password: changePassword,
    export: exportData,
    upgrade: () => openBilling("checkout"),
    portal: () => openBilling("portal"),
    signout: () => signOut(),
    delete: deleteAccount,
  };

  function bind() {
    const el = body();
    if (!el || bound) return;
    bound = true;
    el.addEventListener("click", (event) => {
      const button = event.target.closest("[data-acct]");
      if (!button || button.disabled) return;
      const run = ACTIONS[button.dataset.acct];
      if (!run) return;
      button.disabled = true;
      Promise.resolve()
        .then(run)
        .catch((error) => setStatus(error.message || String(error), { severity: "error" }))
        .finally(() => {
          button.disabled = false;
        });
    });
  }

  // A small form dialog. With `submit`, the request runs inside the dialog so a
  // wrong current password (etc.) is shown in place instead of closing it.
  function formModal({ title, fields, okLabel = "OK", tone = "primary", validate = () => "", submit = null }) {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "modal-overlay";
      overlay.innerHTML =
        `<div class="modal" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">` +
        `<div class="modal-title">${escapeHtml(title)}</div><div class="modal-body">` +
        fields
          .map(
            (f) =>
              `<label class="modal-field"><span>${escapeHtml(f.label)}</span>` +
              `<input name="${escapeHtml(f.name)}" type="${f.type === "password" ? "password" : "text"}"` +
              ` value="${escapeHtml(f.value || "")}"` +
              (f.maxLength ? ` maxlength="${f.maxLength}"` : "") +
              ` autocomplete="${escapeHtml(f.autocomplete || "off")}" /></label>`,
          )
          .join("") +
        '<p class="auth-error" data-form-error role="alert" hidden></p></div>' +
        '<div class="modal-footer"><button class="btn ghost" data-form="cancel" type="button">Cancel</button>' +
        `<button class="btn ${tone === "danger" ? "danger" : "primary"}" data-form="ok" type="button">${escapeHtml(okLabel)}</button></div></div>`;
      document.body.appendChild(overlay);
      const first = overlay.querySelector("input");
      first?.focus();
      first?.select?.();
      const errorEl = overlay.querySelector("[data-form-error]");
      const okBtn = overlay.querySelector('[data-form="ok"]');
      const showError = (msg) => {
        errorEl.textContent = msg || "";
        errorEl.hidden = !msg;
      };
      const collect = () => {
        const values = {};
        overlay.querySelectorAll("input").forEach((input) => {
          values[input.name] = input.value;
        });
        return values;
      };
      const finish = (values) => {
        document.removeEventListener("keydown", onKey);
        overlay.remove();
        resolve(values);
      };
      const confirm = async () => {
        const values = collect();
        const problem = validate(values);
        if (problem) return showError(problem);
        if (!submit) return finish(values);
        okBtn.disabled = true;
        try {
          await submit(values);
          finish(values);
        } catch (error) {
          showError(error.message || "Something went wrong.");
          okBtn.disabled = false;
        }
      };
      const onKey = (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          finish(null);
        } else if (event.key === "Enter") {
          event.preventDefault();
          confirm();
        }
      };
      document.addEventListener("keydown", onKey);
      overlay.querySelector('[data-form="cancel"]').addEventListener("click", () => finish(null));
      okBtn.addEventListener("click", confirm);
      overlay.addEventListener("click", (event) => {
        if (event.target === overlay) finish(null);
      });
    });
  }

  return { bind, render, refresh, actions: ACTIONS };
}

function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function escapeText(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
