import { MAX_PLAN_CHANGES } from "../generated/shared-constants.js";

export const GEN_DEFAULT_MAIN_PCT = 10;
export const GEN_DEFAULT_BRANCH_PCT = 30;

// Typical Maia reply counts; each own-side position generates one candidate.
function estimatedPlies({ plyDepth, mainThreshold, branchThreshold, userToMove = true }) {
  const repliesAt = (share) => Math.min(6, 1 + 0.2 / Math.max(0.01, Number(share) || 0.1));
  const mainReplies = repliesAt(mainThreshold ?? GEN_DEFAULT_MAIN_PCT / 100);
  const branchReplies = repliesAt(branchThreshold ?? GEN_DEFAULT_BRANCH_PCT / 100);
  const plies = [];
  let branchNodes = 0;
  for (let ply = 1; ply <= Math.max(1, Number(plyDepth) || 1); ply++) {
    const userPly = userToMove ? ply % 2 === 1 : ply % 2 === 0;
    if (!userPly) branchNodes = branchNodes * branchReplies + (mainReplies - 1);
    plies.push(1 + branchNodes);
  }
  return plies;
}

export function estimateBuildGenerateTotal(options) {
  const total = estimatedPlies(options).reduce((sum, count) => sum + count, 0);
  return Math.min(MAX_PLAN_CHANGES, Math.max(4, Math.ceil(total * 1.2)));
}

export function generateExistingPlies(nodes, rootId, maxDepth, ownColor) {
  const children = new Map();
  for (const node of nodes || []) {
    if (!children.has(node.parent_id)) children.set(node.parent_id, []);
    children.get(node.parent_id).push(node);
  }
  const counts = [];
  const seen = new Set([rootId]);
  const visit = (id, ply) => {
    if (ply >= maxDepth) return;
    for (const child of children.get(id) || []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      // The planner preserves, but does not expand, manual prepared own moves.
      if (child.source === "manual" && child.is_prepared
        && child.move_side === ownColor) continue;
      counts[ply] = (counts[ply] || 0) + 1;
      visit(child.id, ply + 1);
    }
  };
  if (nodes?.some((node) => node.id === rootId)) visit(rootId, 0);
  return counts;
}

export function generateEstimateRange(options, existingPlies = []) {
  const total = estimatedPlies(options).reduce((sum, count, ply) => sum + Math.max(0, count - (existingPlies[ply] || 0)), 0);
  const nice = (n) => (n >= 50 ? Math.round(n / 10) * 10 : n >= 20 ? Math.round(n / 5) * 5 : Math.round(n));
  const high = Math.min(MAX_PLAN_CHANGES, nice(Math.ceil(total * 1.2)));
  return { low: Math.min(high, nice(total * 0.4)), high };
}

export function generateEstimateText(options, existingPlies = []) {
  const { low, high } = generateEstimateRange(options, existingPlies);
  return low === high ? `${high}` : `${low}–${high}`;
}
