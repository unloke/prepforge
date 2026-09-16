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

const VIEW_SET = new Set(WORKSPACE_VIEWS);

function asView(raw) {
  const view = String(raw || "").toLowerCase();
  return VIEW_SET.has(view) ? view : "dashboard";
}

function asPly(raw) {
  const ply = Number(raw);
  if (!Number.isFinite(ply) || ply < 0) return null;
  return Math.floor(ply);
}

export function formatWorkspaceHash({ view, repertoireId, ply } = {}) {
  const v = asView(view);
  const params = new URLSearchParams();
  if (repertoireId) params.set("rep", String(repertoireId));
  const plyNum = asPly(ply);
  if (plyNum && plyNum > 0) params.set("ply", String(plyNum));
  const query = params.toString();
  return query ? `#/${v}?${query}` : `#/${v}`;
}

export function parseWorkspaceHash(hash) {
  const raw = String(hash || "").replace(/^#/, "");
  const trimmed = raw.replace(/^\/+/, "");
  if (!trimmed) {
    return { view: "dashboard", repertoireId: null, ply: null };
  }
  const qIndex = trimmed.indexOf("?");
  const viewPart = qIndex >= 0 ? trimmed.slice(0, qIndex) : trimmed;
  const queryPart = qIndex >= 0 ? trimmed.slice(qIndex + 1) : "";
  const params = new URLSearchParams(queryPart);
  const ply = asPly(params.get("ply"));
  const rep = params.get("rep");
  return {
    view: asView(viewPart.split("/")[0]),
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
  return {
    view: asView(state.currentView || state.view),
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
