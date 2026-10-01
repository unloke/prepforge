// Heading for the Repertoire move-tree context menu. Right-clicking a move left
// the selection where it was, so "Delete this move" had no visible target
// (UX walkthrough 2026-10-01 P2-8). The menu now names the move it acts on.
export function nodeMenuHeading(node) {
  if (!node || !node.san) return "Start position";
  const number = Number(node.move_number);
  if (!number) return node.san;
  return `${number}${node.move_side === "black" ? "…" : "."} ${node.san}`;
}
