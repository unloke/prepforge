import { html } from "../html.js";
import { teamRowsSkeleton } from "./team-skeleton.js";

// Paint before either lazy module or its stylesheet is available.
function paintTeamsLoading() {
  const list = document.getElementById("teams-list");
  list.innerHTML = teamRowsSkeleton();
  list.setAttribute("aria-busy", "true");
  document.querySelector("#view-teams .team-empty").hidden = true;
  document.querySelector("#view-teams .incoming").hidden = true;
  document.getElementById("teams-search").disabled = true;
  document.getElementById("teams-new").disabled = true;
  document.querySelector('[data-mirror="#teams-new"]').disabled = true;
}

function paintTeamsLoadError(retry) {
  const list = document.getElementById("teams-list");
  list.setAttribute("aria-busy", "false");
  list.innerHTML = html`<div role="alert" class="empty-state">Teams could not load. <button class="btn sm" type="button">Retry</button></div>`;
  list.querySelector("button").onclick = retry;
}

export function loadTeamsWithShell(load) {
  if (!document.querySelector("#teams-list .team-row:not(.is-skeleton)")) paintTeamsLoading();
  return load().catch(() => paintTeamsLoadError(() => loadTeamsWithShell(load)));
}
