import { html } from "../html.js";
import { storedSession } from "../controllers/session-store.js";

// Rows use the loaded row's classes. The count comes from the stored session
// when a returning account knows it; otherwise one row is the honest minimum.
export function libraryRowsSkeleton(count = 1) {
  const rows = Math.max(1, Math.min(8, Number(count) || 1));
  return html`${Array.from({ length: rows }, () => html`<div class="lib-row is-skeleton" aria-hidden="true"><span class="lib-opt">
    <span class="lib-cell-rep"><span class="color-dot skeleton-dot"></span><span class="lib-name">
      <span class="lib-name-line"><b class="name skeleton-text">Opening repertoire</b></span>
      <small class="rep-sub skeleton-text">White · moves to train</small>
    </span></span>
    <span class="lib-cell-mastery"><span class="lib-mastery"><span class="lib-mbar skeleton-text"></span><b class="skeleton-text">00%</b><span class="lib-mastery-word skeleton-text">mastered</span></span></span>
    <span class="lib-cell-queue"><button type="button" class="kchip skeleton-text" tabindex="-1" disabled>0 new</button></span>
    </span><span class="btn ghost icon row-menu-btn skeleton-text">⋯</span></div>`)}`;
}

// Reserve the Today strip while a returning account's dashboard load is in
// flight; without it the whole Library table drops by the strip's height when
// the first response lands.
export function dashboardTodaySkeleton() {
  return html`<div class="today-streak" aria-hidden="true"><span class="today-count skeleton-text">0</span><span class="today-unit skeleton-text">day streak</span></div>
    <div class="today-body" aria-hidden="true"><p class="today-queue skeleton-text">0 due now</p><p class="today-more skeleton-text">0 new moves to learn</p></div>
    <div class="today-aside" aria-hidden="true"><p class="today-recap skeleton-text">0 reviewed in 7 days · 0 mastered · 0 weak spots</p><p class="today-counts skeleton-text">0 analyses · 0 repertoires · 0 sessions</p></div>
    <span class="btn primary skeleton-text" aria-hidden="true">Train</span>`;
}

export function paintDashboardSkeleton(doc) {
  const session = storedSession();
  const rows = doc.getElementById("dashboard-repertoires");
  if (rows) rows.innerHTML = libraryRowsSkeleton(session?.repertoire_count);
  const today = doc.getElementById("dashboard-today");
  if (session && today) {
    today.innerHTML = dashboardTodaySkeleton();
    today.hidden = false;
  }
}
