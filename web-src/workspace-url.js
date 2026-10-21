// Workspace deep-link codec. The hash encodes the active view and, when
// applicable, the open repertoire id and analysis ply. Query strings such as
// ?join= stay untouched so invite links keep working.

import { ANALYSIS_ROOT_PATH, isAnalysisNodePath } from "./analyze-node-path.js";

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

// Replay tabs must update the section before changing views. switchView owns
// the single history push; the section setter only prepares the canonical URL.
export function activateWorkspaceTab(
  { view, replaySection },
  { setReplaySection, switchView },
) {
  if (replaySection) {
    setReplaySection(replaySection, { focus: true, syncUrl: false });
  }
  switchView(view);
}

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

// Analyze's selected position. A mainline position is named by its ply alone, so the
// node is only carried when it names a branch — an ordinary `#/analyze?ply=5` link
// keeps its shape. The node value is the position's stable identity: `root` or the
// root-to-node UCI path (`e2e4-d7d6`). A `v<seq>` id is NOT accepted: sequence
// numbers come from creation order live but from depth-first order after a reload,
// so a saved number can name a different branch (or none).
function asAnalysisNode(raw) {
  const node = String(raw || "").trim();
  return isAnalysisNodePath(node) && node !== ANALYSIS_ROOT_PATH ? node : null;
}

export function formatWorkspaceHash({ view, replaySection, repertoireId, ply, node } = {}) {
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
  const nodeId = asAnalysisNode(node);
  if (nodeId) params.set("node", nodeId);
  const query = params.toString();
  return query ? `#/${hashView}?${query}` : `#/${hashView}`;
}

export function parseWorkspaceHash(hash) {
  const raw = String(hash || "").replace(/^#/, "");
  const trimmed = raw.replace(/^\/+/, "");
  if (!trimmed) {
    return { view: "dashboard", replaySection: null, repertoireId: null, ply: null, node: null };
  }
  const qIndex = trimmed.indexOf("?");
  const viewPart = qIndex >= 0 ? trimmed.slice(0, qIndex) : trimmed;
  const queryPart = qIndex >= 0 ? trimmed.slice(qIndex + 1) : "";
  const params = new URLSearchParams(queryPart);
  const ply = asPly(params.get("ply"));
  const node = asAnalysisNode(params.get("node"));
  const rep = params.get("rep");
  const slug = String(viewPart.split("/")[0] || "").toLowerCase();
  if (slug === "games" || slug === "scout" || slug === "replay") {
    return {
      view: "replay",
      replaySection: asReplaySection(slug === "replay" ? "games" : slug),
      repertoireId: rep ? String(rep) : null,
      ply: ply && ply > 0 ? ply : null,
      node: null,
    };
  }
  return {
    view: asView(slug),
    replaySection: null,
    repertoireId: rep ? String(rep) : null,
    ply: ply && ply > 0 ? ply : null,
    node,
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

// Views whose URL carries the open repertoire: only the builder shows one.
// Analyze's coach reads the book lines of every active repertoire rather than
// one named in the URL, so a rep= on an Analyze link would be a leftover from
// whatever Build last opened. Train carries the repertoire its queue drills
// instead (see trainQueueRepertoireId).
export const REPERTOIRE_VIEWS = Object.freeze(["build"]);
const REPERTOIRE_VIEW_SET = new Set(REPERTOIRE_VIEWS);

// The one repertoire Train's queue is drilling. A smart queue over all active
// repertoires (mixed) drills none, and a repertoire merely opened in Build is
// not what Train is set to — so neither may name one in the URL.
export function trainQueueRepertoireId(state) {
  if (state.smart) return state.smart.mixed ? null : state.smart.repertoireId || null;
  return (state.training && state.training.repertoire_id) || null;
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
      view === "train"
        ? trainQueueRepertoireId(state)
        : REPERTOIRE_VIEW_SET.has(view)
          ? (state.build && state.build.repertoire_id) ||
            state.trainingRepertoireId ||
            state.repertoireId ||
            null
          : null,
    ply:
      (state.currentView || state.view) === "analyze"
        ? asPly(state.analysisPly) || null
        : null,
    // An off-mainline Analyze position: the ply names a mainline move, so a branch
    // needs its node path to come back as the same position after a reload, a
    // shared link or Back/Forward.
    node:
      (state.currentView || state.view) === "analyze"
        ? asAnalysisNode(state.analysisNodePath)
        : null,
  };
}
