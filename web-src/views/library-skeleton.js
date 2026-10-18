import { html } from "../html.js";

// The Library's first-load rows: a library row's own cells with the unknown
// values as bars. aria-hidden; the list itself carries the loading status.
const ROWS = [
  { name: 58, sub: 34, mastery: 82, chips: [null, 52] },
  { name: 44, sub: 28, mastery: 60, chips: [null] },
  { name: 66, sub: 40, mastery: 74, chips: [64] },
  { name: 36, sub: 22, mastery: 52, chips: [46] },
];

const bar = (cls, w) => (w == null
  ? html`<span class="skeleton-bar${cls}"></span>`
  : html`<span class="skeleton-bar${cls}" style="width:${w}%"></span>`);

export function libraryRowsSkeleton() {
  return html`${ROWS.map((row) => html`
    <div class="lib-row is-skeleton" aria-hidden="true">
      <span class="lib-cell-rep">
        <span class="skeleton-dot"></span>
        <span class="skeleton-stack">
          ${bar("", row.name)}
          ${bar(" skeleton-thin", row.sub)}
        </span>
      </span>
      <span class="lib-cell-mastery">${bar("", row.mastery)}</span>
      <span class="lib-cell-queue">${row.chips.map((w) => bar(" skeleton-chip", w))}</span>
    </div>`)}`;
}
