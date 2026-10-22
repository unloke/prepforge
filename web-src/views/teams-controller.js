import { html } from "../html.js";
import { appState } from "../core/state.js";
import { api, currentOwnerId, postJson, setStatus, setStatusError } from "../core/api.js";
import { showConfirmModal, showInputModal } from "../core/modals.js";
import { memberRowsSkeleton, sharedRepRowsSkeleton } from "./team-skeleton.js";
import { enterRows } from "../list-enter.js";
import { createInviteDialogUi, formatDay, runInviteDialog } from "./team-invite.js";
import { GRANT_ROLES, canCopy, roleLabel } from "../share-roles.js";

// Teams: the caller's teams, one team's members and roles, team share links,
// and the repertoires shared to the caller. Lazy-loaded with the Teams view;
// the functions stay at module level and createTeamsController binds the
// shell's state and helpers they share, once.

let switchView, editRepertoire, refreshDashboardRepertoires, requireSignIn, activateModal;

export function createTeamsController(deps) {
  ({ switchView, editRepertoire, refreshDashboardRepertoires, requireSignIn, activateModal } = deps);


const TEAM_ROLE_LABELS = { owner: "Owner", admin: "Admin", member: "Member" };

function teamRoleLabel(role) {
  return TEAM_ROLE_LABELS[role] || role;
}

function teamById(teamId) {
  return appState.teams.find((tm) => tm.id === teamId) || null;
}

let teamsModule = null;
let teamsView = null;

function preloadTeamsView() {
  if (!teamsModule) {
    teamsModule = import("./teams.js").catch((err) => {
      teamsModule = null;
      throw err;
    });
  }
  return teamsModule;
}

async function ensureTeamsView() {
  const mod = await preloadTeamsView();
  if (!teamsView) {
    teamsView = mod.createTeamsView({
      appState,
      api,
      hideTeamDetail,
      openTeamDetail,
      loadSharedRepertoires,
      editRepertoire,
      unshareRepertoireFromTeam,
      copySharedRepertoire,
      teamRoleLabel,
      postJson,
      setStatus,
      setStatusError,
      activateModal,
      showConfirmModal,
      requireSignIn,
    });
  }
  return teamsView;
}

async function loadTeams() {
  return (await ensureTeamsView()).loadTeams();
}

function renderTeamsList() {
  if (teamsView) return teamsView.renderTeamsList();
  void ensureTeamsView().then((view) => view.renderTeamsList()).catch(() => {});
}

// The invite line under the team tabs: what the team has NOW (no status means
// no line — never an implied link). Fed by openTeamDetail, and by teamInvite
// after the dialog, whose final status is the truth for that card.
function renderTeamInviteFooter(status) {
  const foot = document.getElementById("team-invite-foot");
  if (!foot) return;
  if (!status || !status.exists) {
    foot.hidden = true;
    foot.innerHTML = "";
    return;
  }
  const expiresDay = formatDay(status.expires_at);
  const when = expiresDay ? ` · expires ${expiresDay}` : "";
  foot.innerHTML = html`Invite link active${when} · revoke from Invite`;
  foot.hidden = false;
}

function hideTeamDetail() {
  appState.selectedTeamId = null;
  const card = document.getElementById("team-detail-card");
  if (card) card.hidden = true;
  renderTeamsList();
}

let teamDetailSeq = 0;
async function openTeamDetail(teamId) {
  const seq = ++teamDetailSeq;
  const owner = currentOwnerId();
  const generation = appState.ownerGeneration;
  const isCurrent = () => seq === teamDetailSeq && appState.selectedTeamId === teamId && owner === currentOwnerId() && generation === appState.ownerGeneration;
  appState.selectedTeamId = teamId;
  renderTeamsList(); // reflect the selected row
  for (const id of ["team-add-member", "team-detail-invite", "team-share-rep", "team-detail-rename", "team-detail-delete"]) {
    const button = document.getElementById(id);
    if (button) { button.hidden = true; button.onclick = null; }
  }
  const name = document.getElementById("team-detail-name");
  if (name) name.innerHTML = html`<span class="skeleton-bar skeleton-line" style="width:34%;vertical-align:middle"></span>`;
  const role = document.getElementById("team-detail-role");
  if (role) role.textContent = "";
  const shares = document.getElementById("team-shared-repertoires");
  if (shares) shares.innerHTML = sharedRepRowsSkeleton(2);
  teamsView?.renderTeamTabCounts({ members: 0, repertoires: 0 });
  renderTeamInviteFooter(null);
  const card = document.getElementById("team-detail-card");
  const membersEl = document.getElementById("team-members");
  if (!card || !membersEl) return;
  card.hidden = false;
  membersEl.innerHTML = memberRowsSkeleton(3);
  let detail;
  try {
    detail = await api(`/api/teams/${encodeURIComponent(teamId)}`);
  } catch (error) {
    if (!isCurrent()) return;
    membersEl.innerHTML = html`<div class="empty-state">${error.message}</div>`;
    return;
  }
  if (!isCurrent()) return;
  const myRole = detail.role;
  const canManage = myRole === "owner" || myRole === "admin";
  document.getElementById("team-detail-name").textContent = detail.name;
  const roleBadge = document.getElementById("team-detail-role");
  if (roleBadge) {
    roleBadge.textContent = teamRoleLabel(myRole);
    roleBadge.className = `team-role-badge r-${myRole}`;
  }
  const addBtn = document.getElementById("team-add-member");
  if (addBtn) {
    addBtn.hidden = !canManage;
    addBtn.onclick = () => addTeamMember(teamId);
  }
  const inviteBtn = document.getElementById("team-detail-invite");
  if (inviteBtn) {
    inviteBtn.hidden = !canManage;
    inviteBtn.onclick = () => teamInvite(teamId);
  }
  const shareBtn = document.getElementById("team-share-rep");
  if (shareBtn) {
    // Any member may share one of their OWN repertoires with the team.
    shareBtn.hidden = false;
    shareBtn.onclick = () => shareRepertoireIntoTeam(teamId);
  }
  const renameBtn = document.getElementById("team-detail-rename");
  if (renameBtn) {
    renameBtn.hidden = !canManage;
    renameBtn.onclick = () => renameTeam(teamId, detail.name);
  }
  const deleteBtn = document.getElementById("team-detail-delete");
  if (deleteBtn) {
    deleteBtn.hidden = myRole !== "owner";
    deleteBtn.onclick = () => deleteTeam(teamId, detail.name);
  }
  const members = detail.members || [];
  // Tab counts from the real payload (prototype puts them on the tabs) + the
  // manager-only invite footer, both before the member rows render.
  if (teamsView) {
    teamsView.renderTeamTabCounts({ members: members.length });
    renderTeamInviteFooter(detail.invite);
  }
  membersEl.innerHTML = html`${members
    .map((m) => {
      const name = m.display_name || m.lichess_username || "Member";
      const sub = m.lichess_username ? html`<span class="sub">· ${m.lichess_username}</span>` : "";
      const initial = Array.from(m.display_name || m.lichess_username || "M")[0].toUpperCase();
      const isMe = m.user_id === appState.accountUserId;
      const isOwner = m.role === "owner";
      const uid = m.user_id;
      const uname = m.display_name || m.lichess_username || "Member";
      // Owner row is fixed. Managers get an inline role control on every other row
      // (incl. their own, so an admin can step down) plus remove; a plain member only
      // sees a read-only badge and a Leave button on their own row. The server
      // enforces all of this too.
      let tail;
      if (isOwner) {
        tail = html`<span class="team-role-badge r-owner">${teamRoleLabel("owner")}</span>`;
      } else if (canManage) {
        const opts = ["member", "admin"]
          .map(
            (r) =>
              html`<option value="${r}"${m.role === r ? " selected" : ""}>${teamRoleLabel(r)}</option>`
          );
        const removeBtn = html`<button type="button" class="btn icon team-remove" data-user-id="${uid}" data-user-name="${uname}" data-self="${isMe ? "1" : "0"}"${isMe ? "" : html` title="Remove member" aria-label="Remove ${uname}"`}>${isMe ? "Leave" : "×"}</button>`;
        tail = html`<select class="team-role-select" data-user-id="${uid}" aria-label="Role for ${uname}">${opts}</select>${removeBtn}`;
      } else {
        const leaveBtn = isMe
          ? html`<button type="button" class="btn icon team-remove" data-user-id="${uid}" data-user-name="${uname}" data-self="1">Leave</button>`
          : "";
        tail = html`<span class="team-role-badge r-${m.role}">${teamRoleLabel(m.role)}</span>${leaveBtn}`;
      }
      return html`
        <div class="mem-row team-member-row">
          <span class="avatar sm" aria-hidden="true">${initial}</span>
          <span class="mem-id"><span class="name">${name}${isMe ? html` <span class="sub">(you)</span>` : ""}</span>${sub}</span>
          <span class="team-member-tail">${tail}</span>
        </div>`;
    })}`;
  enterRows(membersEl, { key: (row) => `${teamId}|${row.querySelector(".name")?.textContent || ""}` });
  membersEl.querySelectorAll(".team-role-select").forEach((sel) => {
    sel.addEventListener("change", () =>
      updateMemberRole(teamId, sel.dataset.userId, sel.value)
    );
  });
  membersEl.querySelectorAll(".team-remove").forEach((btn) => {
    btn.addEventListener("click", () =>
      removeTeamMember(teamId, btn.dataset.userId, btn.dataset.userName, btn.dataset.self === "1")
    );
  });
  renderTeamSharedRepertoires(teamId, detail.shared_repertoires || []);
}

// The last repertoires seen shared with each team, so "Share a repertoire"
// offers only the ones not there yet.
const teamSharedById = new Map();

function renderTeamSharedRepertoires(teamId, sharedReps) {
  teamSharedById.set(teamId, sharedReps);
  if (teamsView) return teamsView.renderTeamSharedRepertoires(teamId, sharedReps);
  void ensureTeamsView()
    .then((view) => view.renderTeamSharedRepertoires(teamId, sharedReps))
    .catch(() => {});
}

async function unshareRepertoireFromTeam(teamId, repertoireId, name) {
  const confirmed = await showConfirmModal({
    title: `Stop sharing "${name}"?`,
    body: "Team members lose access to it. You can share it again later.",
    okLabel: "Unshare",
    cancelLabel: "Cancel",
    tone: "danger",
  });
  if (!confirmed) return;
  try {
    await postJson("/api/repertoires/access/revoke", {
      repertoire_id: repertoireId,
      team_id: teamId,
    });
    setStatus(`Stopped sharing "${name}" with the team`);
    await refreshDashboardRepertoires();
    await openTeamDetail(teamId);
  } catch (error) {
    setStatusError(error.message);
  }
}

async function createTeam() {
  if (!requireSignIn("Sign in to create a team", "new-team")) return;
  const created = await showInputModal({
    title: "New team",
    okLabel: "Create",
    fields: [{ name: "name", label: "Team name", default: "" }],
    // The dialog holds its pending state while the request runs, so the click
    // reads as work in progress instead of a dropped click.
    onSubmit: async (result, close) => {
      const name = (result.name || "").trim();
      if (!name) {
        setStatus("Team name is empty");
        return;
      }
      try {
        const team = await postJson("/api/teams", { name });
        appState.selectedTeamId = team.id;
        // A fresh team starts empty: land on the Members tab (the empty Shared
        // tab would read as a glitch).
        teamsView?.selectTeamPane?.("members");
        setStatus(`Created team "${name}"`, { severity: "success" });
        await loadTeams();
        close(null);
        return team;
      } catch (error) {
        setStatusError(error.message);
        return null;
      }
    },
  });
  return created || null;
}

async function renameTeam(teamId, currentName) {
  const result = await showInputModal({
    title: "Rename team",
    okLabel: "Save",
    fields: [{ name: "name", label: "Team name", default: currentName }],
  });
  if (!result) return;
  const name = (result.name || "").trim();
  if (!name) {
    setStatus("Name is empty");
    return;
  }
  try {
    await api(`/api/teams/${encodeURIComponent(teamId)}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    });
    setStatus(`Renamed to "${name}"`);
    await loadTeams();
  } catch (error) {
    setStatusError(error.message);
  }
}

async function deleteTeam(teamId, name) {
  const confirmed = await showConfirmModal({
    title: "Delete team?",
    body: `"${name}" will be removed and all shared repertoires will become private again. Members lose access.`,
    okLabel: "Delete",
    cancelLabel: "Cancel",
    tone: "danger",
  });
  if (!confirmed) return;
  try {
    await api(`/api/teams/${encodeURIComponent(teamId)}`, { method: "DELETE" });
    hideTeamDetail();
    setStatus(`Deleted team "${name}"`);
    await loadTeams();
    await refreshDashboardRepertoires();
  } catch (error) {
    setStatusError(error.message);
  }
}

async function addTeamMember(teamId) {
  const result = await showInputModal({
    title: "Add member",
    okLabel: "Add",
    fields: [
      { name: "lichess_username", label: "Their Lichess username", default: "" },
      {
        name: "role",
        label: "Role",
        type: "select",
        default: "member",
        options: [
          { value: "member", label: "Member" },
          { value: "admin", label: "Admin (can manage members)" },
        ],
      },
      {
        type: "note",
        label:
          "They need a PrepForge account with Lichess linked. No account yet? Send them the invite link instead.",
      },
    ],
  });
  if (!result) return;
  const handle = (result.lichess_username || "").trim();
  if (!handle) {
    setStatus("Lichess username is empty");
    return;
  }
  try {
    await postJson(`/api/teams/${encodeURIComponent(teamId)}/members`, {
      lichess_username: handle,
      role: result.role || "member",
    });
    setStatus(`Added ${handle}`);
    await loadTeams();
  } catch (error) {
    // The server returns an actionable message (e.g. "...send them an invite link").
    setStatusError(error.message);
  }
}

async function updateMemberRole(teamId, userId, role) {
  try {
    await api(
      `/api/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(userId)}`,
      { method: "PATCH", body: JSON.stringify({ role }) }
    );
    setStatus(role === "admin" ? "Promoted to admin" : "Set to member");
  } catch (error) {
    setStatusError(error.message);
  }
  // Re-render either way: on success to reflect any rights change, on failure to
  // revert the <select> back to the server's truth.
  await openTeamDetail(teamId);
}

async function removeTeamMember(teamId, userId, label, isSelf) {
  const confirmed = await showConfirmModal({
    title: isSelf ? "Leave team?" : "Remove member?",
    body: isSelf
      ? "You'll lose access to repertoires shared with this team. You can be re-added later."
      : `Remove ${label} from the team? They'll lose access to its shared repertoires.`,
    okLabel: isSelf ? "Leave" : "Remove",
    cancelLabel: "Cancel",
    tone: "danger",
  });
  if (!confirmed) return;
  try {
    await api(
      `/api/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(userId)}`,
      { method: "DELETE" }
    );
    setStatus(isSelf ? "Left team" : `Removed ${label}`);
    if (isSelf) {
      hideTeamDetail();
      teamsView?.selectTeamPane?.("members");
    }
    await loadTeams();
  } catch (error) {
    setStatusError(error.message);
  }
}

// The team's shareable join link. Opening the dialog reads the link's status and
// never rotates it; minting a new code is an explicit, confirmed action inside
// the dialog (views/team-invite.js).
async function teamInvite(teamId) {
  // The dialog stays open across actions. Its own openTeamDetail re-read is a
  // snapshot from opening time and paints AFTER the dialog closes, so the line
  // is repainted from the dialog's last known status after that read, not before.
  let status = null;
  const ui = createInviteDialogUi({
    activateModal,
    onInviteStatus: (next) => { status = next; renderTeamInviteFooter(next); },
  });
  try {
    status = await runInviteDialog(teamId, {
      api,
      postJson,
      origin: window.location.origin,
      copyText: (text) => navigator.clipboard.writeText(text),
      confirm: showConfirmModal,
      setStatus,
      setStatusError,
      ui,
    });
  } catch (error) {
    setStatusError(error.message);
  }
  await openTeamDetail(teamId);
  renderTeamInviteFooter(status);
}

// In-team "add a repertoire": share one of the caller's OWN repertoires with this
// team at a role every member gets. The repertoire's Share dialog changes it later.
async function shareRepertoireIntoTeam(teamId) {
  let reps = [];
  try {
    const payload = await api("/api/repertoires");
    reps = payload.repertoires || [];
  } catch (error) {
    setStatusError(error.message);
    return;
  }
  const already = new Set((teamSharedById.get(teamId) || []).map((r) => r.id));
  const candidates = reps.filter((r) => !already.has(r.id));
  if (!candidates.length) {
    setStatus(
      reps.length ? "All your repertoires are already shared here" : "You have no repertoires to share"
    );
    return;
  }
  const result = await showInputModal({
    title: "Share a repertoire",
    okLabel: "Share",
    fields: [
      {
        name: "repertoire",
        label: "Repertoire",
        type: "select",
        default: candidates[0].id,
        options: candidates.map((r) => ({ value: r.id, label: r.name })),
      },
      {
        name: "role",
        label: "Members",
        type: "select",
        default: "view",
        options: GRANT_ROLES.map((r) => ({ value: r, label: roleLabel(r) })),
      },
    ],
  });
  if (!result || !result.repertoire) return;
  try {
    await postJson("/api/repertoires/access", {
      repertoire_id: result.repertoire,
      team_id: teamId,
      role: result.role || "view",
    });
    setStatus("Shared with the team");
    await refreshDashboardRepertoires();
    await openTeamDetail(teamId);
  } catch (error) {
    setStatusError(error.message);
  }
}

// Copy a team-shared repertoire the caller doesn't own into their own account.
async function copySharedRepertoire(repertoireId) {
  try {
    const result = await postJson("/api/repertoires/fork", { repertoire_id: repertoireId });
    setStatus(`Copied "${result.name}" to your repertoires`);
    await refreshDashboardRepertoires();
  } catch (error) {
    setStatusError(error.message);
  }
}

let sharedRepertoiresSeq = 0;
async function loadSharedRepertoires() {
  const seq = ++sharedRepertoiresSeq;
  const owner = currentOwnerId();
  const generation = appState.ownerGeneration;
  const isCurrent = () => seq === sharedRepertoiresSeq && owner === currentOwnerId() && generation === appState.ownerGeneration;
  const container = document.getElementById("teams-shared");
  if (!container) return;
  // First load only: a refresh keeps the rows on screen until the fresh ones
  // land, instead of flashing a skeleton over them.
  if (!container.querySelector?.(".shared-rep-row")) container.innerHTML = sharedRepRowsSkeleton(2);
  try {
    const payload = await api("/api/repertoires");
    if (!isCurrent()) return;
    const shared = payload.shared || [];
    if (!shared.length) {
      container.innerHTML =
        html`<div class="empty-state">Nothing shared with you yet.</div>`;
      return;
    }
    container.innerHTML = html`${shared
      .map((item) => {
        const id = item.id;
        const name = item.name;
        const color = item.color || "white";
        const team = item.team_id ? teamById(item.team_id) : null;
        const via = item.team_id ? `via ${team ? team.name : "a team"}` : item.owner_display_name || "";
        return html`
          <div class="mem-row shared-rep-row" role="button" tabindex="0" data-repertoire-id="${id}">
            <span class="color-dot ${color}"></span>
            <span class="mem-id">
              <span class="name">${name}</span>
              ${via ? html`<span class="sub">${via}</span>` : ""}
            </span>
            <span class="team-member-tail">
              <span class="team-role-badge share-role-badge">${roleLabel(item.role)}</span>
              ${canCopy(item.role) ? html`<button type="button" class="btn sm team-copy" data-rep-id="${id}">Copy</button>` : ""}
            </span>
          </div>`;
      })}`;
    enterRows(container, { key: (row) => row.dataset.repertoireId });
    container.querySelectorAll(".shared-rep-row").forEach((row) => {
      const open = () => openSharedRepertoire(row.dataset.repertoireId);
      row.addEventListener("click", (event) => {
        if (event.target.closest(".team-copy")) return;
        open();
      });
      row.addEventListener("keydown", (event) => {
        if (event.target !== row) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open();
        }
      });
    });
    container.querySelectorAll(".team-copy").forEach((btn) => {
      btn.addEventListener("click", (event) => {
        event.stopPropagation();
        copySharedRepertoire(btn.dataset.repId);
      });
    });
  } catch (error) {
    if (!isCurrent()) return;
    container.innerHTML = html`<div class="empty-state">${error.message}</div>`;
  }
}

async function openSharedRepertoire(repertoireId) {
  await editRepertoire(repertoireId);
}

  return {
    invalidateRequests: () => { teamDetailSeq++; sharedRepertoiresSeq++; },
    teamRoleLabel,
    teamById,
    preloadTeamsView,
    ensureTeamsView,
    loadTeams,
    renderTeamsList,
    renderTeamInviteFooter,
    hideTeamDetail,
    openTeamDetail,
    renderTeamSharedRepertoires,
    unshareRepertoireFromTeam,
    createTeam,
    renameTeam,
    deleteTeam,
    addTeamMember,
    updateMemberRole,
    removeTeamMember,
    teamInvite,
    shareRepertoireIntoTeam,
    copySharedRepertoire,
    loadSharedRepertoires,
    openSharedRepertoire,
  };
}
