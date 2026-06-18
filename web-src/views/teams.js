// Teams tab view (lazy-loaded from app.js). Lists the caller's teams, drills into
// one to manage membership, and surfaces repertoires shared to a team.

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
    if (!appState.teams.length) {
      list.innerHTML = '<div class="empty-state">No teams yet. Create one to start sharing.</div>';
      return;
    }
    list.innerHTML = appState.teams
      .map((team) => {
        const id = escapeHtml(team.id);
        const name = escapeHtml(team.name);
        const role = escapeHtml(teamRoleLabel(team.role));
        const countLabel = escapeHtml(teamMemberCountLabel(team.member_count));
        const selectedCls = appState.selectedTeamId === team.id ? " is-selected" : "";
        return `
        <div class="list-item team-row${selectedCls}" role="button" tabindex="0" data-team-id="${id}">
          <span>
            <span class="name">${name}</span>
            <span class="sub"> · ${countLabel}</span>
          </span>
          <span class="team-role-badge">${role}</span>
        </div>`;
      })
      .join("");
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
    const container = document.getElementById("team-shared-repertoires");
    if (!container) return;
    if (!sharedReps.length) {
      container.innerHTML =
        '<div class="empty-state">No repertoires shared yet. Use “Share a repertoire” above to add one.</div>';
      return;
    }
    container.innerHTML = sharedReps
      .map((item) => {
        const id = escapeHtml(item.id);
        const name = escapeHtml(item.name);
        const color = escapeHtml(item.color);
        const owner = escapeHtml(item.owner_display_name || item.owner_email || "member");
        const isMine = item.owner_user_id === appState.accountUserId;
        // Your own shared rep: Unshare. Someone else's: Copy to your account (fork).
        const action = isMine
          ? `<button type="button" class="ib team-unshare" data-rep-id="${id}" data-rep-name="${name}" title="Stop sharing">Unshare</button>`
          : `<button type="button" class="ib team-copy" data-rep-id="${id}" title="Copy to my account">Copy</button>`;
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

  return { loadTeams, renderTeamsList, renderTeamSharedRepertoires };
}