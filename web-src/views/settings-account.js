import { html } from "../html.js";
// Settings → Account: the self-service side of the account backend — profile,
// password, plan/billing, data export and account deletion. The card reads top
// to bottom as "who you are → the chess accounts that are you → your data":
//   #settings-account-body  identity header (+ password / plan rows when they apply)
//   #set-connections        linked Lichess accounts (static markup, settings.js)
//   #settings-account-data  export, then a folded danger zone
// Every action goes through the same api()/postJson() helpers (CSRF, error
// flattening) as the rest of the app.

// The API caps passwords at 200 characters (ChangePasswordRequest). Mirroring it
// here keeps a long passphrase from being rejected as an opaque "Request failed
// (422)" with no field named.
const PASSWORD_MAX = 200;

export function createAccountSection({
  appState,
  api,
  postJson,
  setStatus,
  showConfirmModal,
  signOut = async () => {},
  openAuthModal = () => {},
  refreshAuthStatus = async () => {},
  onReload = () => window.location.reload(),
  download = downloadBlob,
  navigate = (url) => window.location.assign(url),
}) {
  let billing = null; // { plan, billing_enabled, price_configured } once fetched
  let bound = false;

  function body() {
    return document.getElementById("settings-account-body");
  }

  function dataBody() {
    return document.getElementById("settings-account-data");
  }

  // Row detail is available on demand through its tooltip.
  function row(label, action, note = "") {
    return (
      html`<div class="set-row acct-row"${note ? html` title="${note}"` : ""}><span class="acct-row-text"><span>${label}</span></span>${action}</div>`
    );
  }

  // The avatar mark: first letter of the display name (or the email).
  function initialOf(text) {
    const first = Array.from(String(text || "").trim())[0] || "?";
    return first.toUpperCase();
  }

  function render() {
    const el = body();
    const data = dataBody();
    if (!el) return;
    if (!appState.signedIn) {
      el.innerHTML =
        html`<div class="acct-guest"><div class="acct-actions"><button type="button" class="btn sm primary" data-acct="signin">Sign in</button><button type="button" class="btn sm" data-acct="register">Create account</button></div></div>`;
      if (data) data.innerHTML = "";
      return;
    }
    const account = appState.account || {};
    const rawEmail = account.email || appState.accountUsername || "";
    const email = rawEmail;
    const displayName = account.displayName || "";
    const shownName = displayName
      ? displayName
      : rawEmail.split("@")[0] || "Your account";
    const method = account.hasPassword ? "Email sign-in" : "Google sign-in";
    const plan = (billing && billing.plan) || account.plan || "free";
    const planTag = html`<span class="status-pill ${plan === "pro" ? "ok" : ""}">${plan === "pro" ? "Pro" : "Free"} plan</span>`;
    let planRow = "";
    if (billing && billing.billing_enabled) {
      if (plan === "pro") {
        planRow = row(
          "PrepForge Pro",
          html`<button type="button" class="btn sm" data-acct="portal">Manage subscription</button>`,
          "Invoices, payment method and cancellation are handled on the billing page.",
        );
      } else if (billing.price_configured) {
        planRow = row(
          "PrepForge Pro",
          html`<button type="button" class="btn sm primary" data-acct="upgrade">Upgrade</button>`,
          "You're on the free plan.",
        );
      }
    }
    el.innerHTML =
      html`<div class="acct-id"><span class="acct-avatar" aria-hidden="true">${initialOf(displayName || rawEmail)}</span><div class="acct-id-text"><div class="acct-id-name"><b data-acct-name${displayName ? "" : html` class="is-placeholder" title="No display name set: this part of your email is shown"`}>${shownName}</b><button type="button" class="btn sm ghost acct-edit" data-acct="rename" aria-label="Edit display name">Edit</button></div><div class="acct-id-email">${email}</div><div class="acct-id-meta"><span class="acct-tag">${method}</span>${planTag}</div></div><button type="button" class="btn sm acct-signout" data-acct="signout">Sign out</button></div>${account.hasPassword
        ? row(
          "Password",
          html`<button type="button" class="btn sm" data-acct="password">Change password</button>`,
          "Changing it signs out your other devices.",
        )
        : ""}${planRow}`;
    const dataHtml =
      html`<div class="acct-block-head"><b>Your data</b></div>${row(
        "Download a copy",
        html`<button type="button" class="btn sm" data-acct="export">Download</button>`,
        "Profile, games (PGN), repertoires and training history in one JSON file.",
      )}<details class="acct-danger-zone"><summary>Delete account</summary><div class="acct-danger"><p class="muted small">Removes the account and everything it owns. Copies other people already made of your shared repertoires stay theirs. This cannot be undone.</p><button type="button" class="btn sm danger" data-acct="delete">Delete account…</button></div></details>`;
    // Unit tests (and any host without the data slot) get everything in one place.
    if (data) data.innerHTML = dataHtml;
    else el.innerHTML += dataHtml;
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
    const owner = appState.accountUserId;
    const generation = appState.ownerGeneration;
    setStatus("Preparing your export…");
    const bundle = await api("/api/account/export", { responseType: "blob", timeoutMs: 300_000 });
    if (owner !== appState.accountUserId || generation !== appState.ownerGeneration) return;
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
    const onClick = (event) => {
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
    };
    el.addEventListener("click", onClick);
    dataBody()?.addEventListener("click", onClick);
  }

  // A small form dialog. With `submit`, the request runs inside the dialog so a
  // wrong current password (etc.) is shown in place instead of closing it.
  function formModal({ title, fields, okLabel = "OK", tone = "primary", validate = () => "", submit = null }) {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "modal-overlay";
      overlay.innerHTML =
        html`<div class="modal" role="dialog" aria-modal="true" aria-label="${title}"><div class="modal-title">${title}</div><div class="modal-body">${fields
          .map(
            (f) =>
              html`<label class="modal-field"><span>${f.label}</span><input name="${f.name}" type="${f.type === "password" ? "password" : "text"}" value="${f.value || ""}"${f.maxLength ? html` maxlength="${f.maxLength}"` : ""} autocomplete="${f.autocomplete || "off"}" /></label>`,
          )}<p class="auth-error" data-form-error role="alert" hidden></p></div><div class="modal-footer"><button class="btn ghost" data-form="cancel" type="button">Cancel</button><button class="btn ${tone === "danger" ? "danger" : "primary"}" data-form="ok" type="button">${okLabel}</button></div></div>`;
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

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
