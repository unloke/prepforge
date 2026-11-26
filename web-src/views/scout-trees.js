// Your repertoire trees for Scout's coverage checks: which moves your prep plays.
//
// One request reads every active tree in a slim form (no SAN/FEN, evaluations or
// training progress). A failed read fails Scout's start, so coverage is never
// counted against only some of your trees.

const TREES_URL = "/api/scout/trees";

/**
 * { white: [{ rep, lookup }], black: [...] } for the repertoires that answer a
 * scout of `color` ("white", "black" or "both"): every active one of the colour
 * you play against them. Throws when the trees can't be read.
 */
export async function loadScoutLookups({ api, repertoireChildLookup, color }) {
  const trees = (await api(TREES_URL))?.repertoires;
  if (!Array.isArray(trees)) throw new Error("Couldn't read your repertoires");
  const wanted = (rep) => rep.is_active !== false && (color === "both" || rep.color !== color);
  const lookups = { white: [], black: [] };
  for (const { nodes, ...rep } of trees) {
    if (wanted(rep)) lookups[rep.color]?.push({ rep, lookup: repertoireChildLookup(nodes || []) });
  }
  return lookups;
}
