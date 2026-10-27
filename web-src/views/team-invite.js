import { html } from "../html.js";
import { modalDialog, openModal } from "../core/dialog.js";
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

// A link minted earlier in this browser session keeps its created_at: GET
// status reports the row's own timestamp, which a fresh mint leaves unset.
export function inviteCreatedAt(teamId, status) {
  return status?.created_at || (teamId ? sessionInviteUrls.get(teamId)?.createdAt : null) || null;
}

// Dates read "Sep 30" in the English UI whatever the browser locale (Scout and
// Games already pin "en"; a zh-TW browser showed "9月30日" here).
export function formatDay(iso) {
  if (!iso) return "";
  // SQLite hands back naive UTC timestamps; without a zone JS would read them as
  // local time and show the wrong day near midnight.
  const s = String(iso);
  const d = new Date(/T.*(Z|[+-]\d\d:?\d\d)$/.test(s) ? s : `${s}Z`);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// Pure view model for the dialog: what it says and which buttons it offers.
// The dialog carries one line of live status and nothing else standing — what a
// link is for belongs in the button/label; what it does ("the old one stops
// working") belongs in the confirmation.
//
// Copy is the primary action whenever there is a link to copy; Revoke is
// always a secondary (quiet danger) action.
export function inviteDialogModel({ status, url, teamId = null }) {
  if (url) {
    const since = formatDay(inviteCreatedAt(teamId, status));
    return {
      state: "known",
      note: since ? `Invite link active · created ${since}` : "Invite link active",
      url,
      actions: [
        { id: "revoke", label: "Revoke link", kind: "danger-quiet" },
        { id: "generate", label: "New link", kind: "ghost" },
        { id: "done", label: "Done", kind: "ghost" },
        { id: "copy", label: "Copy link", kind: "primary" },
      ],
    };
  }
  if (status && status.exists) {
    const since = formatDay(inviteCreatedAt(teamId, status));
    return {
      state: "hidden",
      note: since ? `Invite link active · created ${since}` : "Invite link active",
      url: null,
      actions: [
        { id: "revoke", label: "Revoke link", kind: "danger-quiet" },
        { id: "done", label: "Close", kind: "ghost" },
        { id: "generate", label: "New link", kind: "primary" },
      ],
    };
  }
  return {
    state: "none",
    note: "No invite link yet",
    url: null,
    actions: [
      { id: "done", label: "Close", kind: "ghost" },
      { id: "generate", label: "Generate link", kind: "primary" },
    ],
  };
}

export function inviteDialogBodyHtml(model) {
  const field = model.url
    ? html`<label class="modal-field">
            <span>Invite link</span>
            <input type="text" value="${model.url}" data-invite-url readonly />
          </label>`
    : "";
  const buttons = model.actions
    .map((a) => html`<button class="btn ${a.kind}" data-action="${a.id}" type="button">${a.label}</button>`);
  // A phone sheet closes from its title bar (the footer's Done/Close is
  // hidden there), so the footer keeps one row of link actions.
  const done = model.actions.find((a) => a.id === "done");
  return html`
        <div class="modal-title">Team invite link${done ? html`<button class="invite-done" data-action="done" type="button">${done.label}</button>` : ""}</div>
        <div class="modal-body">
          ${model.state === "known" && model.note ? html`<p class="modal-note muted" data-invite-note>${model.note}</p>` : ""}
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
    return status;
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
  const publish = () => ui.status?.(status);
  try {
    for (;;) {
      ui.render(inviteDialogModel({ status, url, teamId }));
      publish();
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
        // The mint instant is known; remember it so the dialog dates the link
        // even if the status read below lands before the row's timestamp.
        const mintedAt = new Date().toISOString();
        try {
          status = await api(path);
        } catch (_) {
          status = { exists: true, created_at: null, expires_at: payload.expires_at ?? null };
        }
        rememberInviteUrl(teamId, url, status.created_at || mintedAt);
        publish();
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
          publish();
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
  // The last KNOWN status, returned so the caller's line can follow a mint or
  // revoke. A fresh read here could land before the server commits the change.
  return status;
}

// DOM implementation of `ui` for runInviteDialog.
export function createInviteDialogUi({ onInviteStatus = () => {} } = {}) {
  // The name lives on the persistent dialog: replacing its body after a
  // generate/copy/revoke action cannot orphan an aria-labelledby reference.
  const dialog = modalDialog("invite-modal", { "aria-label": "Team invite link" });
  let pending = null;
  let close = null;
  const resolveWith = (value) => {
    const fn = pending;
    pending = null;
    fn?.(value);
  };
  return {
    // The caller re-reads the team while this dialog is open; its fresh link
    // status is the one the card's line must show.
    status(status) {
      onInviteStatus(status);
    },
    render(model) {
      // Opened on first render, so a failed status fetch never flashes an empty modal.
      dialog.innerHTML = inviteDialogBodyHtml(model);
      dialog.querySelectorAll("[data-action]").forEach((btn) => {
        btn.addEventListener("click", () => resolveWith(btn.dataset.action));
      });
      const primary = dialog.querySelector(".modal-footer .btn.primary");
      if (!close) {
        close = openModal(dialog, { initialFocus: primary, onDismiss: () => resolveWith(null) });
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
      close?.();
    },
  };
}
