import { html } from "../html.js";

// Teams' two panes (members, shared repertoires) and the directory all list
// rows of the same shape, so they all show the same loading skeleton: the row's
// own markup with the still-unknown values as bars. aria-hidden, because none
// of it announces a team, member or repertoire that isn't there yet.

const NAME_WIDTHS = [62, 48, 70];
const MEMBER_NAME_WIDTHS = [58, 42, 66];

// A team in the directory: name + member count, then the role badge.
export function teamRowsSkeleton(count = 3) {
  return html`${Array.from({ length: count }, (_, i) => html`
    <div class="team-row is-skeleton" aria-hidden="true">
      <span class="tr-text">
        <span class="skeleton-bar" style="width:${NAME_WIDTHS[i % NAME_WIDTHS.length]}%"></span>
        <span class="skeleton-bar skeleton-thin" style="width:32%"></span>
      </span>
      <span class="skeleton-bar team-badge-skeleton"></span>
    </div>`)}`;
}

// One mem-row skeleton: the dot is the row's (avatar in members, colour dot in
// shared repertoires) and the tail is its action — a badge, or a small button.
export function memRowsSkeleton(count, { dot = "", tail = "team-badge-skeleton", nameWidths = NAME_WIDTHS } = {}) {
  const dotStyle = dot ? ` style="${dot}"` : "";
  return html`${Array.from({ length: count }, (_, i) => html`
    <div class="mem-row is-skeleton" aria-hidden="true">
      <span class="skeleton-dot"${dotStyle}></span>
      <span class="mem-id">
        <span class="skeleton-bar" style="width:${nameWidths[i % nameWidths.length]}%"></span>
        <span class="skeleton-bar skeleton-thin" style="width:26%"></span>
      </span>
      <span class="team-member-tail"><span class="skeleton-bar ${tail}"></span></span>
    </div>`)}`;
}

export function memberRowsSkeleton(count = 3) {
  return memRowsSkeleton(count, { dot: "width:24px;height:24px", nameWidths: MEMBER_NAME_WIDTHS });
}

export function sharedRepRowsSkeleton(count = 2) {
  return memRowsSkeleton(count, { dot: "width:11px;height:11px", tail: "team-btn-skeleton" });
}
