const trees = new WeakMap();
const emptyNodeList = Object.freeze([]);

export function indexBuildNodes(nodes) {
  const byId = new Map();
  for (const node of nodes) {
    // The server sends parents first; reuse their IDs and matching FEN strings.
    const parent = byId.get(node.parent_id);
    if (parent) {
      node.parent_id = parent.id;
      if (node.fen_before === parent.fen) node.fen_before = parent.fen;
    }
    if (node.fen_after === node.fen) node.fen_after = node.fen;
    if (Array.isArray(node.tags) && !node.tags.length) node.tags = emptyNodeList;
    if (Array.isArray(node.arrows) && !node.arrows.length) node.arrows = emptyNodeList;
    if (Array.isArray(node.circles) && !node.circles.length) node.circles = emptyNodeList;
    byId.set(node.id, node);
  }
  return byId;
}

export function indexTree(nodes) {
  const children = new Map();
  for (const node of nodes) {
    const siblings = children.get(node.parent_id);
    if (siblings) siblings.push(node);
    else children.set(node.parent_id, [node]);
  }
  for (const siblings of children.values()) {
    if (siblings.length > 1) siblings.sort((a, b) => Number(!!b.is_mainline) - Number(!!a.is_mainline));
  }
  return children;
}

export function getBuildTree(build) {
  const { nodes, revision } = build;
  const cached = trees.get(build);
  // Optimistic adds push onto the array; deletes replace it. Server reconciles
  // replace the payload. All callers share one set of child lists per snapshot.
  if (cached?.nodes === nodes && cached.length === nodes.length && cached.revision === revision) return cached;
  const tree = {
    nodes, length: nodes.length, revision, children: indexTree(nodes),
    root: nodes.find((node) => node.depth === 0),
  };
  trees.set(build, tree);
  return tree;
}

export function invalidateBuildTree(build) {
  if (build) trees.delete(build);
}

export function summarizeBuild(build, tree = getBuildTree(build)) {
  const { nodes, children, root } = tree;
  let moves = 0, lines = 0, train = 0;
  for (const node of nodes) {
    if (!(node.depth > 0)) continue;
    moves++;
    if (!children.has(node.id)) lines++;
  }
  const stack = root ? [root] : [];
  while (stack.length) {
    const node = stack.pop();
    if (node.is_enabled === false) continue;
    if (node.depth > 0 && node.move_side === build.color) train++;
    const kids = children.get(node.id);
    if (kids) for (const child of kids) stack.push(child);
  }
  return { moves, lines, train };
}
