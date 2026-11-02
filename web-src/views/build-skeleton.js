import { html } from "../html.js";

// Use the score sheet's own grid, including its number gutter and side columns.
export function buildSkeleton() {
  return html`<div class="mtree build-skeleton" role="status" aria-label="Loading repertoire"><div class="mtree-line is-main" aria-hidden="true">${[0, 1, 2, 3, 4, 5].map((i) =>
    html`<span class="mtree-num"><span class="skeleton-text">${i + 1}.</span></span><span class="mtree-move is-w"><span class="skeleton-text">${["e4", "Nf3", "Bb5"][i % 3]}</span></span><span class="mtree-move is-b"><span class="skeleton-text">${["e5", "Nc6", "a6"][i % 3]}</span></span>`
  )}</div></div>`;
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
