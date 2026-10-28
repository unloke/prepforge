import { html } from "../html.js";

// Keep each loading row's identity, secondary line and tail in the slots used
// by its settled counterpart. aria-hidden because none of the bars announce
// a team, member or repertoire that isn't there yet.

const NAME_WIDTHS = [42, 34, 48];
const MEMBER_NAME_WIDTHS = [68, 54, 76];
const MEMBER_SUBLINE_WIDTHS = [92, 76, 104];
const SHARED_NAME_WIDTHS = [132, 108, 148];
const SHARED_SUBLINE_WIDTHS = [88, 72, 104];

// A team in the directory: name + member count, then the role badge.
export function teamRowsSkeleton(count = 3) {
  return html`${Array.from({ length: count }, (_, i) => html`
    <div class="team-row is-skeleton" aria-hidden="true">
      <span class="tr-text">
        <span class="skeleton-bar skeleton-name" style="width:${NAME_WIDTHS[i % NAME_WIDTHS.length]}%"></span>
        <span class="skeleton-bar skeleton-subline skeleton-thin" style="width:26%"></span>
      </span>
      <span class="skeleton-bar team-badge-skeleton"></span>
    </div>`)}`;
}

// One mem-row skeleton: the dot is the row's (avatar in members, colour dot in
// shared repertoires) and the tail is its action — a badge, or a small button.
export function memRowsSkeleton(count, { kind = "member", tail = "team-badge-skeleton", nameWidths = MEMBER_NAME_WIDTHS, sublineWidths = MEMBER_SUBLINE_WIDTHS } = {}) {
  const shared = kind === "shared";
  return html`${Array.from({ length: count }, (_, i) => html`
    <div class="mem-row is-skeleton ${shared ? "shared-rep-row shared-skeleton" : "team-member-row member-skeleton"}" aria-hidden="true">
      <span class="skeleton-dot"></span>
      <span class="mem-id">
        <span class="skeleton-bar skeleton-name" style="width:${nameWidths[i % nameWidths.length]}px"></span>
        <span class="skeleton-bar skeleton-subline skeleton-thin" style="width:${sublineWidths[i % sublineWidths.length]}px"></span>
      </span>
      <span class="team-member-tail">
        ${shared
          ? html`<span class="skeleton-bar team-badge-skeleton"></span><span class="skeleton-bar team-copy-skeleton ${tail}"></span>`
          : html`<span class="skeleton-bar member-role-skeleton"></span><span class="skeleton-bar member-action-skeleton"></span>`}
      </span>
    </div>`)}`;
}

export function memberRowsSkeleton(count = 3) {
  return memRowsSkeleton(count);
}

export function sharedRepRowsSkeleton(count = 2) {
  return memRowsSkeleton(count, {
    kind: "shared",
    tail: "team-btn-skeleton",
    nameWidths: SHARED_NAME_WIDTHS,
    sublineWidths: SHARED_SUBLINE_WIDTHS,
  });
}
