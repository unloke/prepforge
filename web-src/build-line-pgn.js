// "Copy line PGN" from the tree this tab already holds: no request, so it works
// for a move that is not saved yet and for a line under a disabled branch (the
// server's line export refuses both). Same headers and movetext as the server's
// RepertoireExportService._format_pgn.

const STARTING_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

const header = (name, value) => `[${name} "${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`;

// The moves from the first one down to ``nodeId``, or null when it isn't in the tree.
export function linePath(nodeById, nodeId) {
  const path = [];
  const seen = new Set();
  let node = nodeById.get(nodeId);
  if (!node) return null;
  while (node && !seen.has(node.id)) {
    seen.add(node.id);
    if (node.parent_id == null) return path.reverse();
    path.push(node);
    node = nodeById.get(node.parent_id);
  }
  return null; // a parent is missing: not a line of this tree
}

export function linePgn(build, nodeById, nodeId) {
  const path = linePath(nodeById, nodeId);
  if (!path) return null;
  const root = build.nodes.find((node) => node.parent_id == null);
  const rootFen = root?.fen || STARTING_FEN;
  const headers = [
    header("Event", build.name || ""),
    header("Site", "PrepForge Chess"),
    header("White", build.color === "black" ? "?" : "Repertoire"),
    header("Black", build.color === "black" ? "Repertoire" : "?"),
    header("Result", "*"),
    ...(rootFen === STARTING_FEN ? [] : [header("SetUp", "1"), header("FEN", rootFen)]),
  ];
  const parts = [];
  path.forEach((node, index) => {
    const previous = path[index - 1];
    if (node.move_side === "white") parts.push(`${node.move_number}.`);
    else if (!previous || previous.move_number !== node.move_number) parts.push(`${node.move_number}...`);
    parts.push(node.san);
  });
  parts.push("*");
  return `${headers.join("\n")}\n\n${parts.join(" ")}`;
}
