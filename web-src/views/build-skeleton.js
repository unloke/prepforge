import { html } from "../html.js";

// Use the score sheet's own grid, including its number gutter and side columns.
export function buildSkeleton() {
  return html`<div class="mtree build-skeleton" role="status" aria-label="Loading repertoire">${[0, 1, 2, 3, 4, 5].map((i) =>
    html`<div class="mtree-line is-main"><span class="mtree-num"><i class="skeleton-bar"></i></span><span class="mtree-move is-w"><i class="skeleton-bar" style="width:${[42, 55, 36][i % 3]}px"></i></span><span class="mtree-move is-b"><i class="skeleton-bar" style="width:${[38, 48, 52][i % 3]}px"></i></span></div>`
  )}</div>`;
}
