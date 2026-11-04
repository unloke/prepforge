import { Chess } from "chess.js";

export const ATLAS_QUALITY_VERSION = "documentation-clarity-v1";

// Note presence only: no language classifier, correctness claim or length bonus.
function hasProse(value) {
  if (typeof value !== "string") return false;
  const text = value
    .replace(/\[%[^\]]*\]/g, " ")
    .replace(/https?:\/\/[^\s)\]>]+|www\.[^\s]+/gi, " ")
    .replace(/<[^>]*>|&(?:#\d+|#x[\da-f]+|[a-z]+);/gi, " ")
    .replace(/\$\d+|\b(?:1-0|0-1|1\/2-1\/2)\b/g, " ")
    .replace(/\b(?:O-O(?:-O)?|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?|[a-h][1-8][a-h][1-8][qrbn]?)\b[+#?!]*/g, " ")
    .replace(/\b(?:NAG|eval)\b/gi, " ");
  return /\p{L}/u.test(text);
}
const hasNote = (node) => [node.comment, node.typical_plan, node.strategic_idea,
  node.tactical_warning].some(hasProse);
const hasSignpost = (node) => hasNote(node) || (node.tags || []).some((tag) =>
  typeof tag === "string" && !/^(?:source|auto|engine)(?:$|[\s:_-])/i.test(tag.trim()) && hasProse(tag));
const positionKey = (fen) => new Chess(fen).fen().split(" ").slice(0, 4).join(" ");

/** Synchronous browser/offline documentation heuristic, not true repertoire quality.
 * All enabled reachable branches are inspected, including demonstrations/games.
 * Decisions: side-to-move from FEN; select enabled prepared mainline, otherwise
 * first enabled prepared child, then enabled mainline, then first enabled child
 * in input order. This selects note context, not an author recommendation.
 * A current-position note or that selected child's note qualifies a decision.
 * Forks require EACH enabled child to have local prose or a descriptive tag.
 * Per metric canonical positions count once; repeated occurrences must ALL pass
 * (conservative intersection). Copies/extra notes cannot increase their weight.
 * Score is the equal mean of applicable percentages; no moves => null score.
 * Notes apply only to Starting notes, including when scoping to a subtree.
 */
export function atlasClarity({ nodes = [], myColor, rootNodeId = null, notes = "" }) {
  if (!["white", "black"].includes(myColor)) throw new Error("Invalid Atlas color");
  const byId = new Map(), children = new Map();
  for (const node of nodes) {
    if (byId.has(node.id)) throw new Error("Duplicate repertoire node");
    byId.set(node.id, node);
    if (node.parent_id != null) {
      if (!children.has(node.parent_id)) children.set(node.parent_id, []);
      children.get(node.parent_id).push(node);
    }
  }
  const roots = nodes.filter((n) => n.parent_id == null);
  if (rootNodeId == null && roots.length > 1) throw new Error("Multiple repertoire roots");
  const root = byId.get(rootNodeId ?? roots[0]?.id);
  const maps = [new Map(), new Map(), new Map(), new Map()];
  let occurrences = 0, moves = 0;
  const positions = new Set();
  if (root) {
    const ancestors = new Set();
    let ancestor = root;
    while (ancestor) {
      if (ancestors.has(ancestor.id)) throw new Error("Repertoire contains a cycle");
      ancestors.add(ancestor.id);
      if (ancestor.is_enabled === false) throw new Error("Atlas root has a disabled ancestor");
      if (ancestor.parent_id == null) break;
      ancestor = byId.get(ancestor.parent_id);
      if (!ancestor) throw new Error("Disconnected Atlas root");
    }
    const seen = new Set(), stack = [root];
    while (stack.length) {
      const node = stack.pop();
      if (seen.has(node.id)) throw new Error("Repertoire contains a cycle");
      seen.add(node.id);
      const next = (children.get(node.id) || []).filter((n) => n.is_enabled !== false);
      const key = positionKey(node.fen);
      const record = (index, pass) => maps[index].set(key, (maps[index].get(key) ?? true) && pass);
      occurrences++;
      positions.add(key);
      moves += next.length;
      if (next.length && key.split(" ")[1] === (myColor === "white" ? "w" : "b")) {
        const prepared = next.filter((n) => n.is_prepared === true);
        const selected = prepared.find((n) => n.is_mainline) || prepared[0]
          || next.find((n) => n.is_mainline) || next[0];
        record(0, hasNote(node) || Boolean(selected && hasNote(selected)));
      }
      if (new Set(next.map((n) => positionKey(n.fen))).size > 1) record(1, next.every(hasSignpost));
      if (!next.length) record(2, hasNote(node));
      if (node.id === root.id) record(3, hasNote(node) || hasProse(notes));
      stack.push(...next.slice().reverse());
    }
  } else if (rootNodeId != null) throw new Error("Unknown Atlas root");
  const labels = [["decisionNotes", "Decision notes"], ["forkSignposts", "Fork signposts"],
    ["endpointNotes", "Endpoint notes"], ["startingNotes", "Starting notes"]];
  const facets = labels.map(([key, label], i) => {
    const denominator = maps[i].size;
    const numerator = [...maps[i].values()].filter(Boolean).length;
    return { key, label, value: denominator ? 100 * numerator / denominator : null, numerator, denominator };
  });
  const applicable = facets.filter((f) => f.value !== null);
  return {
    score: moves && applicable.length ? applicable.reduce((sum, f) => sum + f.value, 0) / applicable.length : null,
    facets,
    counts: { positions: positions.size, occurrences, moves },
    algorithmVersion: ATLAS_QUALITY_VERSION,
  };
}
