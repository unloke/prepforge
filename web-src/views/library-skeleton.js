import { html } from "../html.js";

// A first row, not a guessed number of repertoires. All slots use the loaded row's classes.
export function libraryRowsSkeleton() {
  return html`<div class="lib-row is-skeleton" aria-hidden="true"><span class="lib-opt">
    <span class="lib-cell-rep"><span class="color-dot skeleton-dot"></span><span class="lib-name">
      <span class="lib-name-line"><b class="name skeleton-text">Opening repertoire</b></span>
      <small class="rep-sub skeleton-text">White · moves to train</small>
    </span></span>
    <span class="lib-cell-mastery"><span class="lib-mastery"><span class="lib-mbar skeleton-text"></span><b class="skeleton-text">00%</b><span class="lib-mastery-word skeleton-text">mastered</span></span></span>
    <span class="lib-cell-queue"><button type="button" class="kchip skeleton-text" tabindex="-1" disabled>0 new</button></span>
    </span><span class="btn ghost icon row-menu-btn skeleton-text">⋯</span></div>`;
}
