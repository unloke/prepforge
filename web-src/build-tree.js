const trees = new WeakMap();
const emptyNodeList = Object.freeze([]);
const STRING_POOL_MIN_NODES = 1024;

function internString(pool, value) {
  return typeof value === "string" ? (pool[value] ??= value) : value;
}

export function indexBuildNodes(nodes) {
  const byId = new Map();
  // Large JSON trees repeat many move and enum strings. Pool them only during
  // indexing; small trees don't save enough to justify the extra lookups.
  const strings = nodes.length >= STRING_POOL_MIN_NODES ? Object.create(null) : null;
  for (const node of nodes) {
    // The server sends parents first; reuse their IDs and matching FEN strings.
    const parent = byId.get(node.parent_id);
    if (parent) {
      node.parent_id = parent.id;
      if (node.fen_before === parent.fen) node.fen_before = parent.fen;
    }
    if (node.fen_after === node.fen) node.fen_after = node.fen;
    if (strings) {
      if (node.san) node.san = internString(strings, node.san);
      if (node.uci) node.uci = internString(strings, node.uci);
      if (node.move_side) node.move_side = internString(strings, node.move_side);
      if (node.side_to_move) node.side_to_move = internString(strings, node.side_to_move);
      if (node.source) node.source = internString(strings, node.source);
    }
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
  for (const [parentId, siblings] of children) {
    if (siblings.length < 2) continue;
    for (let i = 1; i < siblings.length; i++) {
      if (siblings[i].is_mainline && !siblings[i - 1].is_mainline) {
        siblings.sort((a, b) => Number(!!b.is_mainline) - Number(!!a.is_mainline));
        break;
      }
    }
    // The index is read-only between rebuilds. Drop the spare capacity from push().
    children.set(parentId, siblings.slice());
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
