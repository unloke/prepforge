// Your repertoire trees for Scout's coverage checks: which moves your prep plays.
//
// One request reads every active tree in a slim form (no SAN/FEN, evaluations or
// training progress). A server without that endpoint answers with the old shape,
// so Scout then falls back to each tree's Build payload, read side by side.

const TREES_URL = "/api/scout/trees";

/**
 * { white: [{ rep, lookup }], black: [...] } for the repertoires that answer a
 * scout of `color` ("white", "black" or "both"): every active one of the colour
 * you play against them.
 */
export async function loadScoutLookups({ api, repertoireChildLookup, color }) {
  const wanted = (rep) => rep.is_active !== false && (color === "both" || rep.color !== color);
  const lookups = { white: [], black: [] };
  const add = (rep, nodes) => lookups[rep.color]?.push({ rep, lookup: repertoireChildLookup(nodes) });

  let trees = null;
  try {
    trees = (await api(TREES_URL))?.repertoires;
  } catch {
    trees = null; // the per-tree read below says what is wrong, if anything is
  }
  if (Array.isArray(trees)) {
    for (const { nodes, ...rep } of trees) if (wanted(rep)) add(rep, nodes || []);
    return lookups;
  }

  const myReps = ((await api("/api/repertoires")).repertoires || []).filter(wanted);
  const loaded = await Promise.all(myReps.map((rep) =>
    api(`/api/build/load?repertoire_id=${encodeURIComponent(rep.id)}`)
      .then((payload) => ({ rep, nodes: payload.nodes }))
      .catch(() => null))); // unreadable repertoire — skip it
  for (const entry of loaded) if (entry) add(entry.rep, entry.nodes);
  return lookups;
}
