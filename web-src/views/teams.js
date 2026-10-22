import { html } from "../html.js";
// Teams tab view (lazy-loaded from app.js). Lists the caller's teams, drills into
// one to manage membership, and surfaces repertoires shared to a team.
// Detail workspace follows the ui-prototype-v2 sheet: Members / Shared
// repertoires as two tabs over ONE panel (counts live on the tabs), with the
// invite-link status as a footer line under the tabs.
import "./teams.css";
import { loadTeamDirectory } from "../team-directory.js";
import { staggerRows } from "../list-enter.js";
import { teamRowsSkeleton } from "./team-skeleton.js";

export function createTeamsView({
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

  let loadSeq = 0;
  async function loadTeams() {
    const seq = ++loadSeq;
    const owner = appState.accountUserId;
    const generation = appState.ownerGeneration;
    const isCurrent = () => seq === loadSeq && owner === appState.accountUserId && generation === appState.ownerGeneration;
    const list = document.getElementById("teams-list");
    const shared = document.getElementById("teams-shared");
    if (!list) return;
    // Before /api/auth/me lands, the session is UNKNOWN, not signed out. Painting
    // guest state here is what flashed "Sign in to create or join a team" for a
    // signed-in user on reload, so hold a neutral loading state until auth is
    // known instead — including the owner-scoped affordances.
    if (!appState.authKnown) {
      const sharedCard = shared && shared.closest ? shared.closest(".card") : null;
      if (sharedCard) sharedCard.hidden = true;
      const searchField = document.getElementById("teams-search")?.closest?.(".search-field");
      if (searchField) searchField.hidden = true;
      const newTeam = document.getElementById("teams-new");
      if (newTeam) newTeam.hidden = true;
      list.innerHTML = teamRowsSkeleton(3);
      return;
    }
    // A guest gets one Sign in, in the main card; the list and the shares card
    // have nothing to show yet, so they don't repeat it.
    const sharedCard = shared && shared.closest ? shared.closest(".card") : null;
    if (sharedCard) sharedCard.hidden = !appState.signedIn;
    if (!appState.signedIn) {
      list.innerHTML = "";
      if (shared) shared.innerHTML = "";
      renderTeamEmptyCard("signed-out");
      hideTeamDetail();
      return;
    }
    list.innerHTML = teamRowsSkeleton(3);
    try {
      const teams = await loadTeamDirectory(appState, api, { refresh: true });
      if (!isCurrent() || teams === null) return;
      renderTeamsList();
      // Only a team the user picked opens on its own (a reload, or a member
      // add/remove). A single-team directory used to auto-expand, which skipped
      // the list and hid the empty card under "Choose a team / Select a team
      // from the list" — the card now explains how to get a second team.
      if (appState.selectedTeamId && appState.teams.some((team) => team.id === appState.selectedTeamId)) {
        openTeamDetail(appState.selectedTeamId);
      } else {
        hideTeamDetail();
      }
      renderTeamEmptyCard(appState.teams.length ? "choose" : "no-teams");
    } catch (error) {
      if (!isCurrent()) return;
      // A failure says what went wrong and how to retry, like the Library's.
      list.innerHTML = html`<div role="alert" class="empty-state">${error.message} <button class="btn sm" type="button">Retry</button></div>`;
      list.querySelector("button")?.addEventListener("click", loadTeams);
    }
    if (isCurrent()) loadSharedRepertoires();
  }

  // The placeholder card beside the directory says what to do next for the
  // current state (signed out / no teams yet / none picked) instead of a bare
  // blank. It names the state and the one step that changes it; it does not
  // describe what a team holds.
  const EMPTY_CARD_COPY = {
    "signed-out": {
      title: "Teams",
      body: "Sign in to create or join a team.",
    },
    "no-teams": {
      title: "No teams yet",
      body: "Create a team, then invite people with a link.",
    },
    choose: {
      title: "No team selected",
      body: "Choose a team from the directory.",
    },
  };
  function renderTeamEmptyCard(kind) {
    const copy = EMPTY_CARD_COPY[kind] || EMPTY_CARD_COPY.choose;
    const title = document.getElementById("team-empty-title");
    const body = document.getElementById("team-empty-body");
    if (title) title.textContent = copy.title;
    if (body) body.textContent = copy.body;
    // The page composes around the state: with no team yet the empty card is the
    // first-run panel and carries its own New team (teams.css).
    document.querySelector("#view-teams .teams")?.setAttribute("data-empty", kind);
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
    // Same rule as loadTeams(): until the session is known the collection is not
    // "empty", it is unread.
    if (!appState.authKnown) {
      list.innerHTML = teamRowsSkeleton(3);
      return;
    }
    // hideTeamDetail() re-renders the list; keep the guest's sign-in line.
    if (!appState.signedIn) {
      list.innerHTML = "";
      return;
    }
    // No teams: the card beside the directory already says "No teams yet" and how
    // to start one, so the directory is just empty.
    if (!appState.teams.length) {
      list.innerHTML = "";
      return;
    }
    const query = (search?.value || "").trim().toLocaleLowerCase();
    const visibleTeams = appState.teams.filter((team) => team.name.toLocaleLowerCase().includes(query));
    list.innerHTML = visibleTeams.length ? html`${visibleTeams
      .map((team) => {
        const id = team.id;
        const name = team.name;
        const role = teamRoleLabel(team.role);
        const countLabel = teamMemberCountLabel(team.member_count);
        const selectedCls = appState.selectedTeamId === team.id ? " is-selected" : "";
        const roleKey = team.role || "member";
        return html`
        <div class="team-row${selectedCls}" role="button" tabindex="0" data-team-id="${id}" aria-label="Open ${name}" aria-pressed="${appState.selectedTeamId === team.id}">
          <span class="tr-text">
            <span class="name">${name}</span>
            <span class="sub">${countLabel}</span>
          </span>
          <span class="team-role-badge r-${roleKey}">${role}</span>
        </div>`;
      })}` : html`<div class="empty-state">No teams match your search.</div>`;
    staggerRows(list);
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
        html`<div class="empty-state">No repertoires shared yet.</div>`;
      return;
    }
    container.innerHTML = html`${sharedReps
      .map((item) => {
        const id = item.id;
        const name = item.name;
        const color = item.color;
        const owner = item.owner_display_name || "member";
        const isMine = item.owner_user_id === appState.accountUserId;
        // Your own shared rep: Unshare. Someone else's: Copy to your account (fork).
        const action = isMine
          ? html`<button type="button" class="btn sm team-unshare" data-rep-id="${id}" data-rep-name="${name}">Unshare</button>`
          : html`<button type="button" class="btn sm team-copy" data-rep-id="${id}">Copy</button>`;
        return html`
        <div class="mem-row team-shared-rep-row" role="button" tabindex="0" data-repertoire-id="${id}">
          <span class="color-dot ${color}"></span>
          <span class="mem-id">
            <span class="name">${name}</span>
            <span class="sub">· ${owner}</span>
          </span>
          <span class="team-member-tail">${action}</span>
        </div>`;
      })}`;
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

  return {
    invalidateRequests: () => { loadSeq++; },
    loadTeams,
    renderTeamsList,
    renderTeamSharedRepertoires,
    selectTeamPane,
    renderTeamTabCounts,
    bindTeamTabs,
    renderTeamEmptyCard,
  };
}
