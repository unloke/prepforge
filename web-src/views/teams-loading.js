import { html } from "../html.js";
import { teamRowsSkeleton, memberRowsSkeleton, sharedRepRowsSkeleton } from "./team-skeleton.js";
import { appState } from "../core/state.js";
import { PHONE_QUERY } from "../phone-layout.js";
import teamsStylesHref from "./teams.css?url";

let stylesReady;
function ensureStyles() {
  return stylesReady ||= new Promise((resolve, reject) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = teamsStylesHref;
    link.blocking = "render";
    link.onload = resolve;
    link.onerror = () => { link.remove(); stylesReady = null; reject(new Error("Teams styles could not load")); };
    document.head.append(link);
  });
}
// The complete skeleton uses the same stylesheet as the settled workspace.
void ensureStyles().catch(() => {});

// Paint the entire workspace before either lazy module is available.
function paintTeamsLoading() {
  const list = document.getElementById("teams-list");
  list.innerHTML = teamRowsSkeleton(appState.teams.length || 1);
  list.setAttribute("aria-busy", "true");
  document.querySelector("#view-teams .team-empty").hidden = true;
  document.querySelector("#view-teams .incoming").hidden = false;
  const incoming = document.getElementById("teams-shared");
  if (!incoming.children.length) incoming.innerHTML = sharedRepRowsSkeleton();
  const detail = document.getElementById("team-detail-card");
  if (!globalThis.matchMedia(PHONE_QUERY).matches && detail.hidden) {
    const known = appState.teams.find((team) => team.id === appState.selectedTeamId) || appState.teams[0];
    detail.hidden = false;
    detail.inert = true;
    detail.setAttribute("aria-busy", "true");
    document.getElementById("team-detail-name").innerHTML = known ? html`${known.name}` : html`<span class="skeleton-bar" style="width:120px"></span>`;
    document.getElementById("team-members").innerHTML = memberRowsSkeleton(known?.member_count ?? 3);
    document.getElementById("team-add-member").hidden = !!known && !["owner", "admin"].includes(known.role);
  }
  document.getElementById("teams-search").disabled = true;
  document.getElementById("teams-new").disabled = true;
  document.querySelector('[data-mirror="#teams-new"]').disabled = true;
}

function paintTeamsLoadError(retry) {
  document.getElementById("team-detail-card").hidden = true;
  document.querySelector("#view-teams .incoming").hidden = true;
  const list = document.getElementById("teams-list");
  list.setAttribute("aria-busy", "false");
  list.innerHTML = html`<div role="alert" class="empty-state">Teams could not load. <button class="btn sm" type="button">Retry</button></div>`;
  list.querySelector("button").onclick = retry;
}

export function loadTeamsWithShell(load) {
  if (!document.querySelector("#teams-list .team-row:not(.is-skeleton)")) paintTeamsLoading();
  return ensureStyles().then(load).catch(() => paintTeamsLoadError(() => loadTeamsWithShell(load)));
}

export function clearTeamDetail(render) {
  appState.selectedTeamId = null;
  const card = document.getElementById("team-detail-card");
  if (card) { card.hidden = true; card.inert = false; }
  render?.();
}
