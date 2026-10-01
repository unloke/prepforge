// Team invite-link dialog. Opening it must never rotate the link: the raw code is
// hashed at rest (shown once, at mint time), so the dialog first reads the link's
// *status* and only mints a new code when the manager explicitly asks — with a
// confirmation when that would invalidate a link that is already live.
//
// A link minted in this browser session is remembered (in memory only) so the
// manager can reopen the dialog and copy it again without rotating it.

const sessionInviteUrls = new Map(); // teamId -> { url, createdAt }

export function rememberInviteUrl(teamId, url, createdAt = null) {
  sessionInviteUrls.set(teamId, { url, createdAt });
}

export function forgetInviteUrl(teamId) {
  sessionInviteUrls.delete(teamId);
}

export function knownInviteUrl(teamId, status) {
  if (!status || !status.exists) return null;
  const entry = sessionInviteUrls.get(teamId);
  if (!entry) return null;
  // A link rotated elsewhere (another tab/manager) has a newer created_at; the
  // remembered URL would be dead, so don't offer it.
  if (entry.createdAt && status.created_at && entry.createdAt !== status.created_at) return null;
  return entry.url;
}

function formatDay(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Pure view model for the dialog: what it says and which buttons it offers.
// Copy is the primary action whenever there is a link to copy; Revoke is always
// a secondary (quiet danger) action.
export function inviteDialogModel({ status, url }) {
  const exists = !!(status && status.exists);
  if (!exists) {
    return {
      state: "none",
      note:
        "No invite link yet. Generate one to share — anyone signed in who opens it joins the team as a member.",
      url: null,
      actions: [
        { id: "done", label: "Close", kind: "ghost" },
        { id: "generate", label: "Generate link", kind: "primary" },
      ],
    };
  }
  const created = formatDay(status.created_at);
  const since = created ? ` (created ${created})` : "";
  if (url) {
    return {
      state: "known",
      note:
        `This invite link is active${since}. Anyone signed in who opens it joins the team as a member.`,
      url,
      actions: [
        { id: "revoke", label: "Revoke link", kind: "danger-quiet" },
        { id: "generate", label: "Generate new link", kind: "ghost" },
        { id: "done", label: "Done", kind: "ghost" },
        { id: "copy", label: "Copy link", kind: "primary" },
      ],
    };
  }
  return {
    state: "hidden",
    note:
      `An invite link is active${since}. For security it's only shown once, when it's generated — ` +
      "if you no longer have it, generate a new link (the current one will stop working).",
    url: null,
    actions: [
      { id: "revoke", label: "Revoke link", kind: "danger-quiet" },
      { id: "done", label: "Close", kind: "ghost" },
      { id: "generate", label: "Generate new link", kind: "primary" },
    ],
  };
}

export function inviteDialogBodyHtml(model, escapeHtml) {
  const field = model.url
    ? `<label class="modal-field">
            <span>Invite link</span>
            <input type="text" value="${escapeHtml(model.url)}" data-invite-url readonly />
          </label>`
    : "";
  const buttons = model.actions
    .map((a) => `<button class="btn ${a.kind}" data-action="${a.id}" type="button">${escapeHtml(a.label)}</button>`)
    .join("");
  return `
        <div class="modal-title">Team invite link</div>
        <div class="modal-body">
          <p class="modal-note muted" data-invite-note>${escapeHtml(model.note)}</p>
          ${field}
        </div>
        <div class="modal-footer">${buttons}</div>`;
}

// Drives the dialog. `ui` abstracts the DOM so the flow is unit-testable:
//   ui.render(model) -> void, ui.nextAction() -> Promise<actionId|null>, ui.close()
export async function runInviteDialog(teamId, {
  api,
  postJson,
  origin,
  copyText,
  confirm,
  setStatus,
  setStatusError,
  ui,
}) {
  const path = `/api/teams/${encodeURIComponent(teamId)}/invite`;
  let status;
  try {
    status = await api(path);
  } catch (error) {
    ui.close();
    setStatusError(error.message);
    return;
  }
  let url = knownInviteUrl(teamId, status);
  const copy = async () => {
    if (!url) return false;
    try {
      await copyText(url);
      setStatus("Invite link copied");
      return true;
    } catch (_) {
      return false; // clipboard blocked — the link stays visible to copy by hand
    }
  };
  try {
    for (;;) {
      ui.render(inviteDialogModel({ status, url }));
      const action = await ui.nextAction();
      if (action === "copy") {
        if (!(await copy())) ui.selectUrl?.();
        continue;
      }
      if (action === "generate") {
        if (status.exists) {
          const ok = await confirm({
            title: "Generate a new invite link?",
            body: "The current link stops working immediately. Anyone you already sent it to will need the new one.",
            okLabel: "Generate new link",
            tone: "danger",
          });
          if (!ok) continue;
        }
        let payload;
        try {
          payload = await postJson(path, {});
        } catch (error) {
          setStatusError(error.message);
          continue;
        }
        url = `${origin}${payload.url}`;
        try {
          status = await api(path);
        } catch (_) {
          status = { exists: true, created_at: null, expires_at: payload.expires_at ?? null };
        }
        rememberInviteUrl(teamId, url, status.created_at || null);
        await copy();
        continue;
      }
      if (action === "revoke") {
        const ok = await confirm({
          title: "Revoke invite link?",
          body: "The link stops working immediately. Existing members stay in the team.",
          okLabel: "Revoke link",
          tone: "danger",
        });
        if (!ok) continue;
        try {
          await api(path, { method: "DELETE" });
          setStatus("Invite link revoked");
          status = { exists: false };
          url = null;
          forgetInviteUrl(teamId);
        } catch (error) {
          setStatusError(error.message);
        }
        continue;
      }
      break; // done / dismissed
    }
  } finally {
    ui.close();
  }
}

// DOM implementation of `ui` for runInviteDialog.
export function createInviteDialogUi({ escapeHtml, activateModal }) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = '<div class="modal invite-modal" role="dialog" aria-modal="true"></div>';
  const dialog = overlay.querySelector(".modal");
  let pending = null;
  const resolveWith = (value) => {
    const fn = pending;
    pending = null;
    fn?.(value);
  };
  const onKey = (event) => {
    // A confirm stacked on top inerts this overlay; let it handle its own Escape.
    if (event.key === "Escape" && !overlay.inert) {
      event.preventDefault();
      resolveWith(null);
    }
  };
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) resolveWith(null);
  });
  let activated = false;
  return {
    render(model) {
      if (!overlay.isConnected) {
        // Attached on first render, so a failed status fetch never flashes an empty modal.
        document.body.appendChild(overlay);
        document.addEventListener("keydown", onKey);
      }
      dialog.innerHTML = inviteDialogBodyHtml(model, escapeHtml);
      dialog.querySelectorAll("[data-action]").forEach((btn) => {
        btn.addEventListener("click", () => resolveWith(btn.dataset.action));
      });
      const primary = dialog.querySelector(".modal-footer .btn.primary");
      if (!activated) {
        activated = true;
        activateModal(overlay, { initialFocus: primary });
      } else {
        primary?.focus();
      }
    },
    nextAction() {
      return new Promise((resolve) => {
        pending = resolve;
      });
    },
    selectUrl() {
      const input = dialog.querySelector("[data-invite-url]");
      input?.focus();
      input?.select?.();
    },
    close() {
      document.removeEventListener("keydown", onKey);
      overlay.remove();
    },
  };
}
