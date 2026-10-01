// Teams tab view (lazy-loaded from app.js). Lists the caller's teams, drills into
// one to manage membership, and surfaces repertoires shared to a team.
// Detail workspace follows the ui-prototype-v2 sheet: Members / Shared
// repertoires as two tabs over ONE panel (counts live on the tabs), with the
// invite-link status as a footer line under the tabs.
import "./teams.css";
import { createInviteDialogUi, formatDay, runInviteDialog } from "./team-invite.js";

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
  postJson,
  setStatus = () => {},
  setStatusError = () => {},
  activateModal = () => {},
  showConfirmModal = async () => false,
  requireSignIn = () => false,
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
      if (shared) {
        shared.innerHTML =
          '<div class="empty-state">Sign in to see repertoires your teams share with you.</div>';
      }
      setSharedHintVisible(false);
      renderTeamEmptyCard("signed-out");
      hideTeamDetail();
      return;
    }
    list.innerHTML = '<div class="empty-state">Loading…</div>';
    try {
      const payload = await api("/api/teams");
      appState.teams = payload.teams || [];
      renderTeamsList();
      renderTeamEmptyCard(appState.teams.length ? "choose" : "no-teams");
      // Re-open an expanded team after a reload so a member add/remove stays in view.
      if (appState.selectedTeamId && appState.teams.some((tm) => tm.id === appState.selectedTeamId)) {
        openTeamDetail(appState.selectedTeamId);
      } else if (appState.teams.length === 1) {
        // Only one team: open it rather than leaving a big "Choose a team" blank.
        openTeamDetail(appState.teams[0].id);
      } else {
        hideTeamDetail();
      }
    } catch (error) {
      list.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    }
    loadSharedRepertoires();
  }

  // The placeholder card beside the directory explains what to do next for the
  // current state (signed out / no teams yet / pick one) instead of a bare blank.
  const EMPTY_CARD_COPY = {
    "signed-out": {
      title: "Teams",
      body: "Coaches and clubs use teams to share repertoires read-only with their members. Sign in to create or join a team.",
    },
    "no-teams": {
      title: "No teams yet",
      body: "Create a team, then invite people with a shareable link or add existing PrepForge users by their Lichess username.",
    },
    choose: {
      title: "Choose a team",
      body: "Members and shared repertoires appear here.",
    },
  };
  function renderTeamEmptyCard(kind) {
    const copy = EMPTY_CARD_COPY[kind] || EMPTY_CARD_COPY.choose;
    const title = document.getElementById("team-empty-title");
    const body = document.getElementById("team-empty-body");
    if (title) title.textContent = copy.title;
    if (body) body.textContent = copy.body;
    // The signed-out card says "Sign in to create or join a team"; give it the
    // button to do so (UX walkthrough 2026-10-01 P2-10).
    const signIn = document.getElementById("team-empty-signin");
    if (signIn) {
      signIn.hidden = kind !== "signed-out";
      if (!signIn.dataset.bound) {
        signIn.dataset.bound = "true";
        signIn.addEventListener("click", () => requireSignIn("Sign in to create or join a team"));
      }
    }
  }

  // "Click to open (read-only)." only makes sense above a non-empty list.
  function setSharedHintVisible(visible) {
    const hint = document.getElementById("teams-shared-hint");
    if (hint) hint.hidden = !visible;
  }

  async function openInviteDialog(teamId) {
    const ui = createInviteDialogUi({ escapeHtml, activateModal });
    await runInviteDialog(teamId, {
      api,
      postJson,
      origin: window.location.origin,
      copyText: (text) => navigator.clipboard.writeText(text),
      confirm: showConfirmModal,
      setStatus,
      setStatusError,
      ui,
    });
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
    // Nothing to search until there is a team (signed out or none yet).
    const searchField = search?.closest?.(".search-field");
    if (searchField) searchField.hidden = !(appState.signedIn && appState.teams.length);
    // A guest already gets the Sign in button in the main card; a second
    // primary "New team" beside it only competes with it.
    const newTeam = document.getElementById("teams-new");
    if (newTeam) newTeam.hidden = !appState.signedIn;
    // hideTeamDetail() re-renders the list; keep the guest's sign-in line.
    if (!appState.signedIn) {
      list.innerHTML = '<div class="empty-state">Sign in to create and join teams.</div>';
      return;
    }
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
        const roleKey = escapeHtml(team.role || "member");
        return `
        <div class="team-row${selectedCls}" role="button" tabindex="0" data-team-id="${id}" aria-label="Open ${name}" aria-pressed="${appState.selectedTeamId === team.id}">
          <span class="tr-text">
            <span class="name">${name}</span>
            <span class="sub">${countLabel}</span>
          </span>
          <span class="team-role-badge r-${roleKey}">${role}</span>
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
          ? `<button type="button" class="btn sm team-unshare" data-rep-id="${id}" data-rep-name="${name}">Unshare</button>`
          : `<button type="button" class="btn sm team-copy" data-rep-id="${id}">Copy</button>`;
        return `
        <div class="mem-row team-shared-rep-row" role="button" tabindex="0" data-repertoire-id="${id}">
          <span class="color-dot ${color}"></span>
          <span class="mem-id">
            <span class="name">${name}</span>
            <span class="sub">· ${owner}</span>
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
    const expiresDay = formatDay(invite.expires_at);
    const when = expiresDay ? ` · expires ${expiresDay}` : "";
    foot.innerHTML =
      `Invite link active${when} · revoke from Invite`;
    foot.hidden = false;
  }

  return {
    loadTeams,
    renderTeamsList,
    renderTeamSharedRepertoires,
    selectTeamPane,
    renderTeamTabCounts,
    renderTeamInviteFooter,
    bindTeamTabs,
    renderTeamEmptyCard,
    setSharedHintVisible,
    openInviteDialog,
  };
}
