// One repertoire as Analyze's book walks it, from a /api/build/load payload (the
// same shape a Build hydrate holds): playable moves keyed by "parentId|uci", and
// each parent's moves in order. Null for a tree with no root.
export function bookRepFromLoad(data) {
  const children = new Map();
  const kids = new Map();
  let rootId = null;
  for (const node of data?.nodes || []) {
    if (!node.parent_id) {
      rootId = node.id;
      continue;
    }
    if (node.is_enabled === false || !node.uci) continue;
    const move = { id: node.id, san: node.san, uci: node.uci, is_mainline: node.is_mainline };
    children.set(`${node.parent_id}|${node.uci}`, move);
    if (!kids.has(node.parent_id)) kids.set(node.parent_id, []);
    kids.get(node.parent_id).push(move);
  }
  return rootId ? { id: data.repertoire_id, name: data.name, color: data.color, rootId, children, kids } : null;
}
