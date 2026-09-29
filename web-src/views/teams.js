// Teams tab view (lazy-loaded from app.js). Lists the caller's teams, drills into
// one to manage membership, and surfaces repertoires shared to a team.
// Detail workspace follows the ui-prototype-v2 sheet: Members / Shared
// repertoires as two tabs over ONE panel (counts live on the tabs), with the
// invite-link status as a footer line under the tabs.
import "./teams.css";

export function createTeamsView({
  appState,
  api,
  escapeHtml,
  hideTeamDetail,
  openTeamDetail,
  loadSharedRepertoires,
  editRepertoire,
  unshareRepertoireFromTeam,
  copySharedRepertoire,
  teamRoleLabel,
}) {
  function selectTeamPane(pane) {
    document.querySelectorAll("[data-team-pane]").forEach((tab) => {
      const active = tab.dataset.teamPane === pane;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
    });
    document.querySelectorAll("[data-team-panel]").forEach((panel) => {
      panel.hidden = panel.dataset.teamPanel !== pane;
    });
  }

  function bindTeamTabs() {
    document.querySelectorAll("[data-team-pane]").forEach((tab) => {
      if (tab.dataset.teamTabsBound === "1") return;
      tab.dataset.teamTabsBound = "1";
      tab.addEventListener("click", () => selectTeamPane(tab.dataset.teamPane));
      tab.addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
        event.preventDefault();
        const next = tab.dataset.teamPane === "members" ? "repertoires" : "members";
        selectTeamPane(next);
        document.querySelector(`[data-team-pane="${next}"]`)?.focus();
      });
    });
  }

  // Real counts on the tabs (prototype "Members 3 / Shared repertoires 2"),
  // hidden while there is nothing to count. Renderers patch one dimension each
  // (detail members / shared repertoires); the other keeps its last real value.
  const tabCounts = { members: 0, repertoires: 0 };
  function renderTeamTabCounts(patch = {}) {
    Object.assign(tabCounts, patch);
    document.querySelectorAll("[data-team-count]").forEach((el) => {
      const n = tabCounts[el.dataset.teamCount] || 0;
      el.textContent = String(n);
      el.hidden = !(n > 0);
    });
  }

  function teamMemberCountLabel(count) {
    const n = Number(count) || 0;
    return `${n} member${n === 1 ? "" : "s"}`;
  }

  async function loadTeams() {
    const list = document.getElementById("teams-list");
    const shared = document.getElementById("teams-shared");
    if (!list) return;
    if (!appState.signedIn) {
      list.innerHTML = '<div class="empty-state">Sign in to create and join teams.</div>';
      if (shared) shared.innerHTML = "";
      hideTeamDetail();
      return;
    }
    list.innerHTML = '<div class="empty-state">Loading…</div>';
    try {
      const payload = await api("/api/teams");
      appState.teams = payload.teams || [];
      renderTeamsList();
      // Re-open an expanded team after a reload so a member add/remove stays in view.
      if (appState.selectedTeamId && appState.teams.some((tm) => tm.id === appState.selectedTeamId)) {
        openTeamDetail(appState.selectedTeamId);
      } else {
        hideTeamDetail();
      }
    } catch (error) {
      list.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    }
    loadSharedRepertoires();
  }

  function renderTeamsList() {
    const list = document.getElementById("teams-list");
    if (!list) return;
    const search = document.getElementById("teams-search");
    if (search && !search.dataset.bound) {
      search.dataset.bound = "true";
      search.addEventListener("input", renderTeamsList);
    }
    bindTeamTabs();
    if (!appState.teams.length) {
      list.innerHTML = '<div class="empty-state">No teams yet.</div>';
      return;
    }
    const query = (search?.value || "").trim().toLocaleLowerCase();
    const visibleTeams = appState.teams.filter((team) => team.name.toLocaleLowerCase().includes(query));
    list.innerHTML = visibleTeams.length ? visibleTeams
      .map((team) => {
        const id = escapeHtml(team.id);
        const name = escapeHtml(team.name);
        const role = escapeHtml(teamRoleLabel(team.role));
        const countLabel = escapeHtml(teamMemberCountLabel(team.member_count));
        const selectedCls = appState.selectedTeamId === team.id ? " is-selected" : "";
        const roleCls = team.role === "owner" ? " team-row-owner" : " team-row-member";
        return `
        <div class="list-item team-row${selectedCls}${roleCls}" role="button" tabindex="0" data-team-id="${id}" aria-label="Open ${name}" aria-pressed="${appState.selectedTeamId === team.id}">
          <span>
            <span class="name">${name}</span>
            <span class="sub">${countLabel}</span>
          </span>
          <span class="team-role-badge">${role}</span>
        </div>`;
      })
      .join("") : '<div class="empty-state">No teams match your search.</div>';
    list.querySelectorAll(".team-row").forEach((row) => {
      const open = () => openTeamDetail(row.dataset.teamId);
      row.addEventListener("click", open);
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open();
        }
      });
    });
  }

  function renderTeamSharedRepertoires(teamId, sharedReps) {
    renderTeamTabCounts({ repertoires: sharedReps.length });
    const container = document.getElementById("team-shared-repertoires");
    if (!container) return;
    if (!sharedReps.length) {
      container.innerHTML =
        '<div class="empty-state">No repertoires shared yet.</div>';
      return;
    }
    container.innerHTML = sharedReps
      .map((item) => {
        const id = escapeHtml(item.id);
        const name = escapeHtml(item.name);
        const color = escapeHtml(item.color);
        const owner = escapeHtml(item.owner_display_name || "member");
        const isMine = item.owner_user_id === appState.accountUserId;
        // Your own shared rep: Unshare. Someone else's: Copy to your account (fork).
        const action = isMine
          ? `<button type="button" class="ib team-unshare" data-rep-id="${id}" data-rep-name="${name}">Unshare</button>`
          : `<button type="button" class="ib team-copy" data-rep-id="${id}">Copy</button>`;
        return `
        <div class="list-item team-shared-rep-row" role="button" tabindex="0" data-repertoire-id="${id}">
          <span>
            <span class="color-dot ${color}"></span>
            <span class="name">${name}</span>
            <span class="sub"> · ${owner}</span>
          </span>
          <span class="team-member-tail">${action}</span>
        </div>`;
      })
      .join("");
    container.querySelectorAll(".team-shared-rep-row").forEach((row) => {
      const open = () => editRepertoire(row.dataset.repertoireId);
      row.addEventListener("click", (event) => {
        if (event.target.closest(".team-unshare") || event.target.closest(".team-copy")) return;
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
    container.querySelectorAll(".team-unshare").forEach((btn) => {
      btn.addEventListener("click", (event) => {
        event.stopPropagation();
        unshareRepertoireFromTeam(teamId, btn.dataset.repId, btn.dataset.repName);
      });
    });
    container.querySelectorAll(".team-copy").forEach((btn) => {
      btn.addEventListener("click", (event) => {
        event.stopPropagation();
        copySharedRepertoire(btn.dataset.repId);
      });
    });
  }

  // Prototype invite footer: one muted line naming the team's live invite link.
  // Data comes from the real detail payload (managers only); anything else hides
  // the line rather than implying a link exists.
  function renderTeamInviteFooter(detail) {
    const foot = document.getElementById("team-invite-foot");
    if (!foot) return;
    const invite = detail && detail.invite;
    if (!invite || !invite.exists) {
      foot.hidden = true;
      foot.innerHTML = "";
      return;
    }
    const expires = invite.expires_at ? new Date(invite.expires_at) : null;
    const when =
      expires && !Number.isNaN(expires.getTime())
        ? ` · expires ${expires.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
        : "";
    foot.innerHTML =
      `Invite link active${when} · revoke from Invite`;
    foot.hidden = false;
  }

  return { loadTeams, renderTeamsList, renderTeamSharedRepertoires, selectTeamPane, renderTeamTabCounts, renderTeamInviteFooter, bindTeamTabs };
}
