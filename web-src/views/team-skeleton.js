import { html } from "../html.js";

// Keep each loading row's identity, secondary line and tail in the slots used
// by its settled counterpart. aria-hidden because none of the bars announce
// a team, member or repertoire that isn't there yet.


// A team in the directory: name + member count, then the role badge.
export function teamRowsSkeleton(count = 3) {
  return html`${Array.from({ length: count }, () => html`
    <div class="team-row is-skeleton" aria-hidden="true">
      <span class="tr-text"><span class="name skeleton-text">Opening workshop</span><span class="sub skeleton-text">0 members</span></span>
      <span class="team-role-badge skeleton-text">Owner</span>
    </div>`)}`;
}

// One mem-row skeleton: the dot is the row's (avatar in members, colour dot in
// shared repertoires) and the tail is its action — a badge, or a small button.
export function memRowsSkeleton(count, { kind = "member", tail = "team-badge-skeleton" } = {}) {
  const shared = kind === "shared";
  return html`${Array.from({ length: count }, () => html`
    <div class="mem-row is-skeleton ${shared ? "shared-rep-row shared-skeleton" : "team-member-row member-skeleton"}" aria-hidden="true">
      <span class="skeleton-dot"></span>
      <span class="mem-id">
        ${shared ? html`<span class="name skeleton-text">Opening repertoire</span><span class="sub skeleton-text">Shared by a team</span>` : html`<span class="name skeleton-text">Team member</span>`}
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
  });
}
