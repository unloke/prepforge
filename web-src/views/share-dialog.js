import { html } from "../html.js";
import "./share-dialog.css";
import { GRANT_ROLES, LINK_ROLES, roleLabel } from "../share-roles.js";

// The Share dialog: one place to choose who may use a repertoire and how.
// People and teams each get a role (view / copy / edit); "anyone with the link"
// gets view or copy. Every change is one request whose reply is the dialog's new
// state, so the dialog always shows what the server holds.

export const grantKey = (grant) => (grant.team_id ? `team:${grant.team_id}` : `user:${grant.user_id}`);
const grantTarget = (key) => {
  const [kind, id] = key.split(":");
  return kind === "team" ? { team_id: id } : { user_id: id };
};

const EMPTY_DRAFT = { target: "", person: "", role: "view" };

// Pure view model: what the dialog shows for this access state.
export function shareDialogModel({ name, state, teams = [], origin = "", error = "", draft = EMPTY_DRAFT }) {
  const sharedTeams = new Set(state.grants.filter((g) => g.team_id).map((g) => g.team_id));
  const link = state.link || {};
  return {
    name,
    grants: state.grants.map((g) => ({
      key: grantKey(g),
      name: g.name || (g.team_id ? "Team" : "Member"),
      sub: g.team_id ? "Team" : g.lichess_username && g.lichess_username !== g.name ? g.lichess_username : "",
      role: g.role,
    })),
    teams: teams.filter((t) => !sharedTeams.has(t.id)).map((t) => ({ value: `team:${t.id}`, label: t.name })),
    link: {
      on: !!link.share_enabled,
      role: link.share_role || "view",
      url: link.share_enabled && link.url ? `${origin}${link.url}` : null,
    },
    error,
    draft,
  };
}

const roleOptions = (roles, current) =>
  roles.map((r) => html`<option value="${r}"${r === current ? " selected" : ""}>${roleLabel(r)}</option>`);

export function shareDialogBodyHtml(model) {
  const { draft, link } = model;
  const target = model.teams.length
    ? html`<select class="share-target" data-share-target data-focus="add-target" aria-label="Share with">
        <option value="">Person</option>
        ${model.teams.map((t) => html`<option value="${t.value}"${t.value === draft.target ? " selected" : ""}>${t.label}</option>`)}
      </select>`
    : "";
  const rows = model.grants.map((g) => html`
      <li class="share-row" data-grant="${g.key}">
        <span class="share-who"><b>${g.name}</b>${g.sub ? html`<small>${g.sub}</small>` : ""}</span>
        <select class="share-role" data-grant-role="${g.key}" data-focus="role:${g.key}" aria-label="Role for ${g.name}">${roleOptions(GRANT_ROLES, g.role)}</select>
        <button type="button" class="btn icon share-remove" data-grant-remove="${g.key}" data-focus="remove:${g.key}" title="Remove access" aria-label="Remove ${g.name}"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>
      </li>`);
  return html`
    <div class="modal-title">Share “${model.name}”</div>
    <div class="modal-body share-body">
      <form class="share-add${target ? " has-target" : ""}" data-share-add novalidate>
        ${target}
        <input class="share-person" type="text" data-share-person data-focus="add-person" value="${draft.person}"${draft.target ? " hidden" : ""} placeholder="Email or Lichess username" aria-label="Email or Lichess username" autocomplete="off" autocapitalize="off" spellcheck="false" />
        <select class="share-role" data-share-add-role data-focus="add-role" aria-label="Role">${roleOptions(GRANT_ROLES, draft.role)}</select>
        <button class="btn sm" type="submit" data-focus="add-submit">Share</button>
      </form>
      ${model.error ? html`<p class="share-error" role="alert">${model.error}</p>` : ""}
      ${rows.length ? html`<ul class="share-list" aria-label="Who has access">${rows}</ul>` : ""}
      <div class="share-link">
        <div class="share-link-head">
          <button type="button" class="pf-switch${link.on ? " is-on" : ""}" role="switch" aria-checked="${link.on}" aria-labelledby="share-link-label" data-link-toggle data-focus="link-toggle"><span class="pf-knob"></span></button>
          <span class="share-link-label" id="share-link-label">Anyone with the link</span>
          ${link.on ? html`<select class="share-role" data-link-role data-focus="link-role" aria-label="Role for anyone with the link">${roleOptions(LINK_ROLES, link.role)}</select>` : ""}
        </div>
        ${link.url ? html`<div class="share-link-url">
          <input type="text" readonly value="${link.url}" data-link-url aria-label="Share link" />
          <button class="btn sm" type="button" data-action="copy" data-focus="copy">Copy</button>
        </div>` : ""}
      </div>
    </div>
    <div class="modal-footer">
      ${link.on ? html`<button class="btn ghost share-reset" type="button" data-action="rotate" data-focus="rotate">Reset link</button>` : ""}
      <button class="btn primary" type="button" data-action="done" data-focus="done">Done</button>
    </div>`;
}

// Drives the dialog. `ui` abstracts the DOM so the flow is unit-testable:
//   ui.render(model), ui.nextAction() -> Promise<{type, ...}|null>, ui.selectUrl(), ui.close()
// Returns whether anything changed, so the caller can refresh the Library.
export async function runShareDialog(repertoireId, {
  name, api, postJson, origin, copyText, confirm, setStatus, setStatusError, loadTeams, ui,
}) {
  const statePath = `/api/repertoires/access?repertoire_id=${encodeURIComponent(repertoireId)}`;
  let state;
  try {
    state = await api(statePath);
  } catch (error) {
    ui.close();
    setStatusError(error.message);
    return false;
  }
  const teams = await Promise.resolve(loadTeams?.()).catch(() => []) || [];
  let error = "";
  let draft = EMPTY_DRAFT;
  let changed = false;
  const send = async (path, body) => {
    try {
      const reply = await postJson(path, { repertoire_id: repertoireId, ...body });
      error = "";
      changed = true;
      return reply;
    } catch (err) {
      error = err.message;
      return null;
    }
  };
  // Link replies carry only the link; re-read so the URL and grants agree.
  const refresh = async () => {
    try {
      state = await api(statePath);
    } catch (err) {
      error = err.message;
    }
  };
  const copyLink = async () => {
    if (!state.link?.url) return;
    try {
      await copyText(`${origin}${state.link.url}`);
      setStatus("Link copied");
    } catch (_) {
      ui.selectUrl?.(); // clipboard blocked: the link stays selected to copy by hand
    }
  };
  try {
    for (;;) {
      ui.render(shareDialogModel({ name, state, teams, origin, error, draft }));
      const action = await ui.nextAction();
      if (!action || action.type === "done") break;
      if (action.type === "add") {
        draft = { target: action.target || "", person: action.person || "", role: action.role || "view" };
        const who = draft.target ? grantTarget(draft.target) : { person: draft.person.trim() };
        if (!draft.target && !who.person) {
          error = "Enter an email or Lichess username";
          continue;
        }
        const reply = await send("/api/repertoires/access", { ...who, role: draft.role });
        if (reply) {
          state = reply;
          draft = EMPTY_DRAFT;
        }
      } else if (action.type === "role") {
        const reply = await send("/api/repertoires/access", { ...grantTarget(action.key), role: action.role });
        if (reply) state = reply;
      } else if (action.type === "remove") {
        const reply = await send("/api/repertoires/access/revoke", grantTarget(action.key));
        if (reply) state = reply;
      } else if (action.type === "link") {
        if (state.link?.share_enabled) {
          const ok = await confirm({
            title: "Turn off the link?",
            body: "The link stops working. Turning it back on makes a new one.",
            okLabel: "Turn off",
            tone: "danger",
          });
          if (!ok) continue;
          if (await send("/api/repertoires/share-link/revoke", {})) await refresh();
        } else if (await send("/api/repertoires/share-link", { role: state.link?.share_role || "view" })) {
          await refresh();
          await copyLink();
        }
      } else if (action.type === "link-role") {
        if (await send("/api/repertoires/share-link", { role: action.role })) await refresh();
      } else if (action.type === "copy") {
        await copyLink();
      } else if (action.type === "rotate") {
        const ok = await confirm({
          title: "Reset the link?",
          body: "The current link stops working. Anyone you sent it to will need the new one.",
          okLabel: "Reset link",
          tone: "danger",
        });
        if (!ok) continue;
        if (await send("/api/repertoires/share-link/rotate", {})) {
          await refresh();
          await copyLink();
        }
      }
    }
  } finally {
    ui.close();
  }
  return changed;
}

// DOM implementation of `ui` for runShareDialog.
export function createShareDialogUi({ activateModal }) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = html`<div class="modal share-modal" role="dialog" aria-modal="true" aria-label="Share repertoire"></div>`;
  const dialog = overlay.querySelector(".modal");
  let pending = null;
  let activated = false;
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
  const field = (sel) => dialog.querySelector(sel);
  return {
    render(model) {
      // A re-render replaces the controls: keep focus on the same control.
      const focusKey = document.activeElement?.closest?.("[data-focus]")?.dataset.focus;
      if (!overlay.isConnected) {
        document.body.appendChild(overlay);
        document.addEventListener("keydown", onKey);
      }
      dialog.innerHTML = shareDialogBodyHtml(model);
      const target = field("[data-share-target]");
      const person = field("[data-share-person]");
      target?.addEventListener("change", () => {
        person.hidden = !!target.value;
      });
      field("[data-share-add]").addEventListener("submit", (event) => {
        event.preventDefault();
        resolveWith({
          type: "add",
          target: target?.value || "",
          person: person.value,
          role: field("[data-share-add-role]").value,
        });
      });
      dialog.querySelectorAll("[data-grant-role]").forEach((sel) => {
        sel.addEventListener("change", () => resolveWith({ type: "role", key: sel.dataset.grantRole, role: sel.value }));
      });
      dialog.querySelectorAll("[data-grant-remove]").forEach((btn) => {
        btn.addEventListener("click", () => resolveWith({ type: "remove", key: btn.dataset.grantRemove }));
      });
      field("[data-link-toggle]").addEventListener("click", () => resolveWith({ type: "link" }));
      field("[data-link-role]")?.addEventListener("change", (event) =>
        resolveWith({ type: "link-role", role: event.target.value }));
      dialog.querySelectorAll("[data-action]").forEach((btn) => {
        btn.addEventListener("click", () => resolveWith({ type: btn.dataset.action }));
      });
      const keep = focusKey && dialog.querySelector(`[data-focus="${focusKey}"]`);
      const done = field('[data-action="done"]');
      if (!activated) {
        activated = true;
        // On a touch screen focusing the field would throw the keyboard over the dialog.
        const typing = window.matchMedia?.("(pointer: fine)").matches;
        activateModal(overlay, { initialFocus: typing ? person : done });
      } else {
        ((keep && !keep.hidden && keep) || (person.hidden ? done : person)).focus();
      }
    },
    nextAction() {
      return new Promise((resolve) => {
        pending = resolve;
      });
    },
    selectUrl() {
      const input = field("[data-link-url]");
      input?.focus();
      input?.select?.();
    },
    close() {
      document.removeEventListener("keydown", onKey);
      overlay.remove();
    },
  };
}
