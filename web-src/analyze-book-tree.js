// One repertoire as Analyze's book walks it, from a slim tree ({ id, name,
// color, nodes } with { id, parent_id, uci, is_enabled, is_mainline } nodes,
// as GET /api/analyze/book sends it): playable moves keyed by "parentId|uci",
// and each parent's moves in order. Null for a tree with no root.
export function bookRepFromTree(tree) {
  const children = new Map();
  const kids = new Map();
  let rootId = null;
  for (const node of tree?.nodes || []) {
    if (!node.parent_id) {
      rootId = node.id;
      continue;
    }
    if (node.is_enabled === false || !node.uci) continue;
    const move = { id: node.id, uci: node.uci, is_mainline: node.is_mainline };
    children.set(`${node.parent_id}|${node.uci}`, move);
    if (!kids.has(node.parent_id)) kids.set(node.parent_id, []);
    kids.get(node.parent_id).push(move);
  }
  return rootId ? { id: tree.id, name: tree.name, color: tree.color, rootFen: tree.root_fen, rootId, children, kids } : null;
}
