const MUTATIONS = new Set([
  "/api/build/rename", "/api/build/add-move", "/api/build/add-moves",
  "/api/build/delete-nodes", "/api/build/generate/apply-plan",
  "/api/build/action", "/api/build/annotations",
]);

export function withBuildRevision(path, body, build) {
  if (!MUTATIONS.has(path) || !build || body?.repertoire_id !== build.repertoire_id) return body;
  return { ...body, base_revision: body.base_revision ?? build.revision };
}

export function queuedBuildRevision(entries, build) {
  const revisions = entries.map((op) => op.base_revision).filter(Number.isInteger);
  return revisions.length ? Math.min(...revisions) : build?.revision;
}

export function advanceBuildRevision(build, payload, entries = []) {
  if (!build || !Number.isInteger(payload?.revision) || payload.revision < build.revision) return;
  const before = build.revision;
  build.revision = payload.revision;
  rebaseQueuedBuildRevision(entries, build.repertoire_id, before, payload.revision);
}

export function rebaseQueuedBuildRevision(entries, repertoireId, before, after) {
  for (const op of entries) {
    if (op.repertoire_id === repertoireId && op.base_revision === before) {
      op.base_revision = after;
    }
  }
}
