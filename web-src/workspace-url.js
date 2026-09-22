// Workspace deep-link codec. The hash encodes the active view and, when
// applicable, the open repertoire id and analysis ply. Query strings such as
// ?join= stay untouched so invite links keep working.

export const WORKSPACE_VIEWS = [
  "dashboard",
  "analyze",
  "build",
  "train",
  "replay",
  "teams",
  "settings",
];

// Games and Scout share the `replay` view internally (two panels in one
// section) but have distinct deep links: #/games and #/scout. They are URL
// aliases, not separate views — the canonical location is always
// { view: "replay", replaySection }.
export const REPLAY_SECTIONS = ["games", "scout"];

const VIEW_SET = new Set(WORKSPACE_VIEWS);

function asReplaySection(raw) {
  const section = String(raw || "").toLowerCase();
  return section === "scout" ? "scout" : "games";
}

function asView(raw) {
  const view = String(raw || "").toLowerCase();
  return VIEW_SET.has(view) ? view : "dashboard";
}

function asPly(raw) {
  const ply = Number(raw);
  if (!Number.isFinite(ply) || ply < 0) return null;
  return Math.floor(ply);
}

export function formatWorkspaceHash({ view, replaySection, repertoireId, ply } = {}) {
  const rawView = String(view || "").toLowerCase();
  // Canonical form: replay + section always serializes to the section alias
  // (#/games or #/scout). Accepting a bare { view: "games"/"scout" } keeps
  // callers from needing to know the internal view name.
  let v;
  let section = null;
  if (rawView === "games" || rawView === "scout") {
    v = "replay";
    section = asReplaySection(rawView);
  } else {
    v = asView(rawView);
    if (v === "replay") section = asReplaySection(replaySection || "games");
  }
  const hashView = section || v;
  const params = new URLSearchParams();
  if (repertoireId) params.set("rep", String(repertoireId));
  const plyNum = asPly(ply);
  if (plyNum && plyNum > 0) params.set("ply", String(plyNum));
  const query = params.toString();
  return query ? `#/${hashView}?${query}` : `#/${hashView}`;
}

export function parseWorkspaceHash(hash) {
  const raw = String(hash || "").replace(/^#/, "");
  const trimmed = raw.replace(/^\/+/, "");
  if (!trimmed) {
    return { view: "dashboard", replaySection: null, repertoireId: null, ply: null };
  }
  const qIndex = trimmed.indexOf("?");
  const viewPart = qIndex >= 0 ? trimmed.slice(0, qIndex) : trimmed;
  const queryPart = qIndex >= 0 ? trimmed.slice(qIndex + 1) : "";
  const params = new URLSearchParams(queryPart);
  const ply = asPly(params.get("ply"));
  const rep = params.get("rep");
  const slug = String(viewPart.split("/")[0] || "").toLowerCase();
  if (slug === "games" || slug === "scout" || slug === "replay") {
    return {
      view: "replay",
      replaySection: asReplaySection(slug === "replay" ? "games" : slug),
      repertoireId: rep ? String(rep) : null,
      ply: ply && ply > 0 ? ply : null,
    };
  }
  return {
    view: asView(slug),
    replaySection: null,
    repertoireId: rep ? String(rep) : null,
    ply: ply && ply > 0 ? ply : null,
  };
}

export function parseWorkspaceLocation(href) {
  const url = new URL(String(href), "http://prepforge.local/");
  return parseWorkspaceHash(url.hash);
}

export function serializeWorkspaceLocation(loc, currentHref) {
  const url = new URL(String(currentHref || "http://prepforge.local/"), "http://prepforge.local/");
  return `${url.pathname}${url.search}${formatWorkspaceHash(loc)}`;
}

export function workspaceLocationFromState(state = {}) {
  const view = asView(state.currentView || state.view);
  return {
    view,
    replaySection:
      view === "replay"
        ? asReplaySection(state.replaySection || state.replay_section)
        : null,
    repertoireId:
      (state.build && state.build.repertoire_id) ||
      state.trainingRepertoireId ||
      state.repertoireId ||
      null,
    ply:
      (state.currentView || state.view) === "analyze"
        ? asPly(state.analysisPly) || null
        : null,
  };
}
