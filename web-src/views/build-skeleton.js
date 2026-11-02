import { html } from "../html.js";

// Use the score sheet's own grid, including its number gutter and side columns.
export function buildSkeleton() {
  return html`<div class="mtree build-skeleton" role="status" aria-label="Loading repertoire">${[0, 1, 2, 3, 4, 5].map((i) =>
    html`<div class="mtree-line is-main"><span class="mtree-num"><i class="skeleton-bar"></i></span><span class="mtree-move is-w"><i class="skeleton-bar" style="width:${[42, 55, 36][i % 3]}px"></i></span><span class="mtree-move is-b"><i class="skeleton-bar" style="width:${[38, 48, 52][i % 3]}px"></i></span></div>`
  )}</div>`;
}

export function paintBuildSkeleton(document) {
  const fork = document.getElementById("build-branchbar");
  if (fork) fork.hidden = true;
  const name = document.getElementById("build-rep-name");
  if (name) {
    name.innerHTML = html`<span class="color-dot skeleton-dot"></span><span class="skeleton-bar skeleton-line" style="display:inline-block;width:180px;max-width:70%"></span>`;
    name.title = "";
  }
  const tree = document.getElementById("builder-tree");
  if (tree) tree.innerHTML = buildSkeleton();
}
