import { Chess } from "chess.js";

export function createGeneratePreview({ build, byId, isCurrent, render, onClear = () => {},
  frame = (fn) => requestAnimationFrame(fn), cancelFrame = (id) => cancelAnimationFrame(id),
  later = (fn) => setTimeout(fn, 100), cancelLater = (id) => clearTimeout(id),
}) {
  const ids = new Set();
  const parents = new Set();
  let raf = null, timer = null, closed = false;
  const unschedule = () => {
    if (raf !== null) cancelFrame(raf);
    if (timer !== null) cancelLater(timer);
    raf = timer = null;
  };
  const flush = () => {
    unschedule();
    if (closed) return;
    if (!isCurrent()) return clear();
    render(parents);
    parents.clear();
  };
  const clear = (paint = true) => {
    if (closed) return;
    closed = true;
    onClear();
    unschedule();
    build.nodes = build.nodes.filter((node) => !ids.has(node.id));
    for (const id of ids) byId.delete(id);
    ids.clear();
    parents.clear();
    if (paint && isCurrent()) render();
  };
  return {
    clear,
    add(change) {
      if (closed) return;
      if (!isCurrent()) return clear();
      if (change.action !== "planned_add") return;
      const parent = byId.get(change.parentRef);
      if (!parent) throw new Error("Missing generation preview parent");
      const chess = new Chess(parent.fen);
      const move = chess.move({ from: change.moveUci.slice(0, 2), to: change.moveUci.slice(2, 4),
        promotion: change.moveUci[4] });
      const node = {
        id: change.tempId, parent_id: parent.id, depth: parent.depth + 1,
        san: move.san, uci: change.moveUci, fen: chess.fen(),
        move_number: Number(parent.fen.split(" ")[5]),
        move_side: move.color === "w" ? "white" : "black",
        is_enabled: true, is_mainline: change.intendedMainline,
        preview: true, previewEntering: true,
      };
      build.nodes.push(node);
      byId.set(node.id, node);
      ids.add(node.id);
      parents.add(parent.id);
      if (raf === null) {
        raf = frame(flush);
        timer = later(flush);
      }
    },
  };
}
