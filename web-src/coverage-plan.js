import { Chess } from "chess.js";
import { formatPlayTrail } from "./train-play.js";

export async function prepareCoverageReply({ build, gap, generate, signal, rating, depth }) {
  const parent = build.nodes.find((n) => n.id === gap.nodeId);
  if (!parent || parent.fen !== gap.fen) throw new Error("Preparation changed; check again");
  const chess = new Chess(parent.fen);
  const move = chess.move({ from: gap.moveUci.slice(0, 2), to: gap.moveUci.slice(2, 4), promotion: gap.moveUci[4] });
  if (!move) throw new Error("Gap move is no longer legal");
  const opponent = build.nodes.find((n) => n.parent_id === parent.id && n.uci === gap.moveUci);
  if (opponent?.is_enabled === false) throw new Error("This branch is disabled; enable it before preparing");
  const virtualId = "coverage-virtual-anchor";
  const virtual = { id: virtualId, parent_id: parent.id, depth: parent.depth + 1,
    fen: chess.fen(), uci: gap.moveUci, san: move.san, side_to_move: chess.turn() === "w" ? "white" : "black",
    is_prepared: false, is_enabled: true, is_mainline: false, source: "generated_maia3" };
  const snapshot = { ...build, nodes: build.nodes.map((n) => ({ ...n })) };
  if (!opponent) snapshot.nodes.push(virtual);
  const anchor = opponent || virtual;
  const generated = await generate({ build: snapshot, rootNodeId: anchor.id, ownColor: build.color,
    plyDepth: 3, detailMode: "simple", ownSideCandidateCount: 1,
    maiaRating: rating, depth, signal });
  if (signal?.aborted) throw new DOMException("Reply preview stopped", "AbortError");
  const additions = generated.changes.filter((c) => c.action === "planned_add");
  if (!additions.some((c) => c.parentRef === anchor.id)) throw new Error("No prepared reply was generated");
  const opponentRef = "tmp-coverage-opponent";
  const plan = { ...generated, rootNodeId: parent.id, changes: [
    ...(!opponent ? [{ action: "planned_add", tempId: opponentRef, parentRef: parent.id,
      moveUci: gap.moveUci, source: "generated_maia3", intendedMainline: false,
      engineEvaluation: null, maiaProbability: gap.prob }] : []),
    ...generated.changes.map((c) => ({ ...c,
      ...(c.parentRef === virtualId ? { parentRef: opponentRef } : {}),
    })),
  ] };
  const fens = new Map([[anchor.id, anchor.fen]]);
  const moves = [{ id: anchor.id, parentId: parent.id, san: move.san, before: parent.fen }];
  const ownNodeRefs = [];
  for (const change of additions) {
    const before = fens.get(change.parentRef) || snapshot.nodes.find((n) => n.id === change.parentRef)?.fen;
    if (!before) throw new Error("Reply preview contains an unknown parent");
    const game = new Chess(before);
    const m = game.move({ from: change.moveUci.slice(0, 2), to: change.moveUci.slice(2, 4), promotion: change.moveUci[4] });
    fens.set(change.tempId, game.fen());
    moves.push({ id: change.tempId, parentId: change.parentRef, san: m.san, before });
    if ((new Chess(before).turn() === "w" ? "white" : "black") === build.color) ownNodeRefs.push(change.tempId);
  }
  const rootFen = build.nodes.find((n) => n.depth === 0)?.fen;
  const path = formatPlayTrail((gap.pathSans || []).map((san) => ({ san })), rootFen);
  const line = [path, movetext(moves, parent.id, !path)].filter(Boolean).join(" ");
  return { gap, plan, rootNodeId: parent.id, fenAfter: anchor.fen,
    line, ownNodeRefs, addedMoves: plan.changes.filter((c) => c.action === "planned_add").length };
}

// PGN movetext of a move tree: the first child continues the line, siblings
// are (variations), so alternative replies never read as one sequence.
function movetext(moves, rootId, numberFirst) {
  const kids = new Map();
  for (const m of moves) kids.set(m.parentId, [...(kids.get(m.parentId) || []), m]);
  const num = (fen, force) => {
    const [, side, , , , full] = fen.split(" ");
    return side === "w" ? `${full}. ` : force ? `${full}... ` : "";
  };
  const walk = (id, force) => {
    const [main, ...alts] = kids.get(id) || [];
    if (!main) return [];
    return [
      `${num(main.before, force)}${main.san}`,
      ...alts.map((alt) => `(${[`${num(alt.before, true)}${alt.san}`, ...walk(alt.id, false)].join(" ")})`),
      ...walk(main.id, alts.length > 0),
    ];
  };
  return walk(rootId, numberFirst).join(" ");
}
