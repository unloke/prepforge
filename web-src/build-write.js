// Build's writes to the server. Every caller that changes a repertoire tree
// (autosave, annotations, node actions, Generate, rename, restore, discussions)
// posts through here, so the rules live in Build rather than in the generic
// request helpers of core/api.js:
//
// - Writes run one at a time, so each is applied on top of the last. The server
//   rebases every edit onto the current tree, so none carries the revision it
//   was made on.
// - The open tree advances only past its own write: exactly the next revision
//   means nobody else wrote in between. Otherwise the change feed fills the gap.
// - Other tabs and the live poller hear about every write (build-live.js).

import { appState, buildState } from "./core/state.js";
import { currentOwnerId, postJson } from "./core/api.js";
import { announceBuildWrite } from "./build-live.js";

export async function postBuildWrite(path, body, options = {}) {
  const build = buildState.build;
  const owner = currentOwnerId();
  const generation = appState.ownerGeneration;
  const previous = buildState.buildMutationSaving;
  const task = (async () => {
    if (previous) await previous.catch(() => {});
    if (owner !== currentOwnerId() || generation !== appState.ownerGeneration) throw new Error("Account changed");
    const before = build?.revision;
    const payload = await postJson(path, body, options);
    if (body?.repertoire_id === build?.repertoire_id) {
      if (buildState.build === build && payload?.revision === before + 1) build.revision = payload.revision;
      announceBuildWrite(body.repertoire_id);
    }
    return payload;
  })();
  buildState.buildMutationSaving = task;
  try { return await task; }
  finally { if (buildState.buildMutationSaving === task) buildState.buildMutationSaving = null; }
}
