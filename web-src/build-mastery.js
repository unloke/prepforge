// The owner's per-node mastery over the open Build tree. It is Train's read
// (GET /api/train/mastery), kept beside the tree payload instead of inside it:
// the tree is the same for everyone who can open it, the colour is the owner's
// training progress. Shared and linked trees carry none.
import { buildRole } from "./share-roles.js";

// The mastery state of one node of the open tree, or null when uncoloured.
export function masteryOf(buildState, nodeId) {
  const held = buildState.buildMastery;
  if (!held || held.repertoireId !== buildState.build?.repertoire_id) return null;
  return held.byNode.get(nodeId) || null;
}

// deps: api, appState, buildState, repaint() (called once new colour lands).
// refresh() asks for the colour of the tree buildState.build holds, at most one
// request at a time: a refresh during a request asks once more after it. Every
// re-read asks, even at the same revision: a finished Train session moves the
// colour without moving the tree.
export function createBuildMastery({ api, appState, buildState, repaint }) {
  let inflight = null;
  let again = false;

  const coloured = (build) => !!build && !appState.sharedToken && buildRole(build) === "owner";

  async function run() {
    try {
      do {
        again = false;
        const build = buildState.build;
        if (!coloured(build)) break;
        const reply = await api(`/api/train/mastery?repertoire_id=${encodeURIComponent(build.repertoire_id)}`);
        // The view moved on (another repertoire, or the account changed) while
        // this was in flight: its own refresh asks for its own colour.
        if (!coloured(buildState.build) || buildState.build.repertoire_id !== reply.repertoire_id) continue;
        const held = buildState.buildMastery;
        if (held?.repertoireId === reply.repertoire_id && held.revision > reply.revision) continue;
        buildState.buildMastery = {
          repertoireId: reply.repertoire_id,
          revision: reply.revision,
          byNode: new Map(Object.entries(reply.mastery || {})),
        };
        repaint();
      } while (again);
    } catch {
      // The tree stays as last coloured; the next hydrate asks again.
    }
  }

  function refresh() {
    const build = buildState.build;
    if (!coloured(build)) {
      buildState.buildMastery = null;
      return Promise.resolve();
    }
    if (buildState.buildMastery && buildState.buildMastery.repertoireId !== build.repertoire_id) {
      buildState.buildMastery = null;
    }
    if (inflight) {
      again = true;
      return inflight;
    }
    inflight = run().finally(() => { inflight = null; });
    return inflight;
  }

  return { refresh };
}
