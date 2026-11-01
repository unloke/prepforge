// Scout v13 — selection funnel + full-package audit integration (pure async).
// Reuses package collapse, style/memorability, and extension constants from steps 1–3.

import { AUDIT_MIN_SUBJECT_CHOSE } from "./scout-route-audit.js";
import { V12_BANNED_VOCAB } from "./scout-v12-report.js";
import { EXT_ENDPOINT_MIN_CP } from "./scout-v13-extension.js";
import {
  candidatePersonalScore,
  coverageComponents,
  selectComponentRepresentative,
  validatePrepPackage,
} from "./scout-v13-package.js";
import {
  checkMemorabilityBudget,
  classifyStyles,
  deriveRiskBadges,
  memPenalty,
} from "./scout-v13-style.js";

/** @typedef {import("./scout-v13-package.js").EvidenceEdge} EvidenceEdge */
/** @typedef {import("./scout-v13-style.js").StyleMetrics} StyleMetrics */
/** @typedef {import("./scout-v13-style.js").PkgRiskMetrics} PkgRiskMetrics */
/** @typedef {import("./scout-v13-style.js").MemorabilityTree} MemorabilityTree */
/** @typedef {import("./scout-v13-extension.js").BuildExtensionResult} ExtensionResult */

export const PACKAGES_PER_COLOR = 4;
/** Harness-calibratable overlap penalty for marginal backfill (design §4). */
export const MARGINAL_OVERLAP_COEF = 0.35;

const STYLE_BUCKETS = Object.freeze(["solid", "sharp", "rare", "forcing"]);

/**
 * @typedef {object} FunnelCandidate
 * @property {string} id
 * @property {"white"|"black"} subjectColor
 * @property {string[]} trunkUcis
 * @property {string} trunkEndEpd
 * @property {string} entryEpd
 * @property {string[]} entryUcis
 * @property {string[]} [extensionMainlineUcis]
 * @property {Array<{ k: number, n: number }>} trunkSegments
 * @property {number} anchorAttribution
 * @property {string[]} tendencyIds
 * @property {{ edges: EvidenceEdge[], personalAnchorPly: number, reachLB: number }} trunk
 * @property {ExtensionResult} extension
 * @property {StyleMetrics} styleMetrics
 * @property {Omit<PkgRiskMetrics, "primaryStyle">} riskMetrics
 * @property {Omit<MemorabilityTree, "style"> & { transpositionDivergence?: number }} memTree
 */

/**
 * @typedef {object} AuditProviders
 * @property {(ucis: string[]) => Promise<{ evalCp: number }>} auditLeafEval
 */

/**
 * @typedef {object} AuditedLeaf
 * @property {"mainline"|"branch"} kind
 * @property {number} [forkPlyIndex]
 * @property {string[]} ucis
 * @property {number} evalCp
 */

/**
 * @typedef {object} FunnelPackage
 * @property {string} id
 * @property {string[]} demotedNotes
 * @property {import("./scout-v13-package.js").PackageStyle|null} primaryStyle
 * @property {import("./scout-v13-package.js").PackageStyle[]} styles
 * @property {string[]} riskTags
 * @property {number} memPenaltyScore
 * @property {AuditedLeaf[]} auditedLeaves
 */

/**
 * @typedef {object} SelectionFunnelReport
 * @property {FunnelPackage[]} packages
 * @property {Array<{ color: string, bucket: string }>} bucketVacancies
 * @property {Array<{ id: string, reasons: string[] }>} eliminated
 * @property {Array<{ packageId: string, forkPlyIndex: number }>} prunedBranches
 */

function isOurTurn(pathLen, subjectColor) {
  return subjectColor === "black" ? pathLen % 2 === 0 : pathLen % 2 === 1;
}

/**
 * @param {string[]} a
 * @param {string[]} b
 */
function jaccardSimilarity(a, b) {
  const setA = new Set(a || []);
  const setB = new Set(b || []);
  if (setA.size === 0 && setB.size === 0) return 0;
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * @param {FunnelCandidate} candidate
 * @param {import("./scout-v13-package.js").PackageStyle|null} primaryStyle
 */
function assemblePrepPackage(candidate, primaryStyle) {
  const branchEdgeArrays = (candidate.extension.branches || []).map((b) => b.edges);
  return {
    entryRegion: {
      epd: candidate.entryEpd,
      ourEntryUcis: candidate.entryUcis || [],
    },
    trunk: candidate.trunk,
    extension: {
      mainline: candidate.extension.mainline || [],
      branches: branchEdgeArrays,
    },
    style: primaryStyle,
    tendencyIds: candidate.tendencyIds || [],
    tier: null,
    riskTags: [],
    receipts: {},
    notes: [],
  };
}

/**
 * Collect extension edges on subject (his) plies.
 * @param {FunnelCandidate} candidate
 * @returns {EvidenceEdge[]}
 */
function collectHisExtensionEdges(candidate) {
  const anchorLen = candidate.trunkUcis?.length ?? 0;
  const subjectColor = candidate.subjectColor;
  /** @type {EvidenceEdge[]} */
  const hisEdges = [];

  const mainline = candidate.extension.mainline || [];
  for (let i = 0; i < mainline.length; i += 1) {
    if (!isOurTurn(anchorLen + i, subjectColor)) {
      hisEdges.push(mainline[i]);
    }
  }

  for (const branch of candidate.extension.branches || []) {
    const fork = branch.forkPlyIndex;
    for (let j = 0; j < branch.edges.length; j += 1) {
      if (!isOurTurn(anchorLen + fork + j, subjectColor)) {
        hisEdges.push(branch.edges[j]);
      }
    }
  }

  return hisEdges;
}

/**
 * @param {FunnelCandidate} candidate
 * @param {import("./scout-v13-package.js").PackageStyle|null} primaryStyle
 */
function memorabilityTreeFor(candidate, primaryStyle) {
  return {
    leafCount: candidate.memTree.leafCount,
    forkCount: candidate.memTree.forkCount,
    maxRepliesPerFork: candidate.memTree.maxRepliesPerFork,
    onlyMoveCount: candidate.memTree.onlyMoveCount,
    conceptFamilies: candidate.memTree.conceptFamilies || [],
    style: primaryStyle,
  };
}

/**
 * @param {FunnelCandidate} candidate
 */
function memPenaltyScore(candidate) {
  const families = candidate.memTree.conceptFamilies || [];
  return memPenalty({
    forkCount: candidate.memTree.forkCount,
    uniqueConceptCount: families.length,
    onlyMoveCount: candidate.memTree.onlyMoveCount,
    transpositionDivergence: candidate.memTree.transpositionDivergence ?? 0,
  });
}

/**
 * @param {FunnelCandidate} candidate
 */
function pruneLastBranch(candidate) {
  const branches = [...(candidate.extension.branches || [])];
  branches.pop();
  const prevLeaf = candidate.extension.leafCount ?? 1;
  const newLeafCount = Math.max(1, prevLeaf - 1);
  const prevFork = candidate.memTree.forkCount ?? 0;
  return {
    ...candidate,
    extension: {
      ...candidate.extension,
      branches,
      leafCount: newLeafCount,
    },
    memTree: {
      ...candidate.memTree,
      leafCount: newLeafCount,
      forkCount: Math.max(0, prevFork - 1),
    },
  };
}

/**
 * @param {FunnelCandidate} candidate
 * @param {import("./scout-v13-package.js").PackageStyle|null} primaryStyle
 * @returns {{ ok: boolean, candidate: FunnelCandidate, reasons: string[] }}
 */
function resolveMemorabilityBudget(candidate, primaryStyle) {
  let working = candidate;
  /** @type {string[]} */
  const pruneReasons = [];

  while (true) {
    const budget = checkMemorabilityBudget(memorabilityTreeFor(working, primaryStyle));
    if (budget.ok) {
      return { ok: true, candidate: working, reasons: pruneReasons };
    }

    const branchCount = working.extension.branches?.length ?? 0;
    if (branchCount === 0) {
      return {
        ok: false,
        candidate: working,
        reasons: budget.violations.map((v) => `memorability:${v}`),
      };
    }

    working = pruneLastBranch(working);
    pruneReasons.push("memorability:prunedLastBranch");
  }
}

/**
 * @param {FunnelCandidate} candidate
 * @returns {{ pass: boolean, reasons: string[], candidate: FunnelCandidate|null, primaryStyle: import("./scout-v13-package.js").PackageStyle|null, styles: import("./scout-v13-package.js").PackageStyle[] }}
 */
function runHardGates(candidate) {
  /** @type {string[]} */
  const reasons = [];

  if (!candidate.extension?.ok) {
    reasons.push(`extension:${candidate.extension?.reason ?? "unknown"}`);
    return { pass: false, reasons, candidate: null, primaryStyle: null, styles: [] };
  }

  const trunkPersonal = (candidate.trunk?.edges || []).some(
    (edge) =>
      edge.evidenceSource === "personal" &&
      Number.isFinite(edge.receipts?.games) &&
      edge.receipts.games >= AUDIT_MIN_SUBJECT_CHOSE,
  );
  if (!trunkPersonal) {
    reasons.push("factuality:trunkPersonal");
  }

  const hisEdges = collectHisExtensionEdges(candidate);
  if (hisEdges.length > 0 && hisEdges.every((e) => e.evidenceSource === "engine")) {
    reasons.push("factuality:cohort");
  }

  const { primary, styles } = classifyStyles(candidate.styleMetrics);
  const schemaResult = validatePrepPackage(assemblePrepPackage(candidate, primary));
  if (!schemaResult.ok) {
    for (const err of schemaResult.errors) {
      reasons.push(`schema:${err}`);
    }
  }

  if (reasons.length > 0) {
    return { pass: false, reasons, candidate: null, primaryStyle: primary, styles };
  }

  const memResult = resolveMemorabilityBudget(candidate, primary);
  if (!memResult.ok) {
    return {
      pass: false,
      reasons: memResult.reasons,
      candidate: null,
      primaryStyle: primary,
      styles,
    };
  }

  return {
    pass: true,
    reasons: [],
    candidate: {
      ...memResult.candidate,
      primaryStyle: primary,
      styles,
      memPenaltyScore: memPenaltyScore(memResult.candidate),
    },
    primaryStyle: primary,
    styles,
  };
}

/**
 * @param {FunnelCandidate[]} survivors
 */
function collapseToRepresentatives(survivors) {
  /** @type {Map<string, FunnelCandidate[]>} */
  const byColor = new Map();
  for (const cand of survivors) {
    const color = cand.subjectColor;
    if (!byColor.has(color)) byColor.set(color, []);
    byColor.get(color).push({
      ...cand,
      extensionMainlineUcis: (cand.extension.mainline || []).map((e) => e.uci),
    });
  }

  /** @type {FunnelCandidate[]} */
  const representatives = [];
  for (const group of byColor.values()) {
    const components = coverageComponents(group);
    for (const component of components) {
      const { representative, demoted } = selectComponentRepresentative(component);
      const winnerSurvivor =
        survivors.find((s) => s.id === representative.id) ?? representative;
      representatives.push({
        ...winnerSurvivor,
        tendencyIds: representative.tendencyIds,
        demotedNotes: demoted.map((d) => d.note),
      });
    }
  }
  return representatives;
}

/**
 * @param {FunnelCandidate} candidate
 * @param {FunnelCandidate[]} alreadySelected
 */
function conceptJaccard(candidate, alreadySelected) {
  const families = candidate.memTree.conceptFamilies || [];
  if (!alreadySelected.length) return 0;
  let maxSim = 0;
  for (const selected of alreadySelected) {
    const other = selected.memTree.conceptFamilies || [];
    maxSim = Math.max(maxSim, jaccardSimilarity(families, other));
  }
  return maxSim;
}

/**
 * @param {FunnelCandidate} candidate
 * @param {FunnelCandidate[]} alreadySelected
 */
function marginalRelevance(candidate, alreadySelected) {
  const base = candidatePersonalScore(candidate);
  const overlap = conceptJaccard(candidate, alreadySelected);
  return base * (1 - MARGINAL_OVERLAP_COEF * overlap);
}

/**
 * @param {FunnelCandidate[]} claimants
 */
function pickBucketWinner(claimants) {
  return [...claimants].sort((a, b) => {
    const scoreDiff = candidatePersonalScore(b) - candidatePersonalScore(a);
    if (scoreDiff !== 0) return scoreDiff;
    return memPenaltyScore(a) - memPenaltyScore(b);
  })[0];
}

/**
 * @param {FunnelCandidate[]} representatives
 * @param {string} color
 */
function selectForColor(representatives, color) {
  const colorReps = representatives.filter((r) => r.subjectColor === color);
  /** @type {FunnelCandidate[]} */
  const selected = [];
  const usedIds = new Set();
  /** @type {Array<{ color: string, bucket: string }>} */
  const bucketVacancies = [];

  for (const bucket of STYLE_BUCKETS) {
    const claimants = colorReps.filter(
      (r) => !usedIds.has(r.id) && r.primaryStyle === bucket,
    );
    if (!claimants.length) {
      bucketVacancies.push({ color, bucket });
      continue;
    }
    const winner = pickBucketWinner(claimants);
    selected.push(winner);
    usedIds.add(winner.id);
  }

  const pool = colorReps.filter((r) => !usedIds.has(r.id));
  while (selected.length < PACKAGES_PER_COLOR && pool.length > 0) {
    pool.sort(
      (a, b) => marginalRelevance(b, selected) - marginalRelevance(a, selected),
    );
    const next = pool.shift();
    if (!next) break;
    selected.push(next);
    usedIds.add(next.id);
  }

  return { selected, bucketVacancies, reserve: pool };
}

/**
 * @param {FunnelCandidate} candidate
 */
function mainlineLeafUcis(candidate) {
  const mainline = (candidate.extension.mainline || []).map((e) => e.uci);
  return [...(candidate.trunkUcis || []), ...mainline];
}

/**
 * @param {FunnelCandidate} candidate
 * @param {{ forkPlyIndex: number, edges: EvidenceEdge[] }} branch
 */
function branchLeafUcis(candidate, branch) {
  const prefix = (candidate.extension.mainline || [])
    .slice(0, branch.forkPlyIndex)
    .map((e) => e.uci);
  const branchMoves = branch.edges.map((e) => e.uci);
  return [...(candidate.trunkUcis || []), ...prefix, ...branchMoves];
}

/**
 * @param {FunnelCandidate} candidate
 * @param {AuditProviders} providers
 * @returns {Promise<{
 *   ok: boolean,
 *   candidate: FunnelCandidate,
 *   auditedLeaves: AuditedLeaf[],
 *   prunedBranches: Array<{ packageId: string, forkPlyIndex: number }>,
 *   eliminateReason: string|null,
 * }>}
 */
async function auditPackageLeaves(candidate, providers) {
  /** @type {AuditedLeaf[]} */
  const auditedLeaves = [];
  /** @type {Array<{ packageId: string, forkPlyIndex: number }>} */
  const prunedBranches = [];
  let working = candidate;
  // Pruning restarts the branch scan; cache evals so surviving branches are not
  // re-audited (and not double-counted in the receipts).
  const evalCache = new Map();
  const evalLeaf = async (ucis) => {
    const key = ucis.join(" ");
    if (!evalCache.has(key)) {
      evalCache.set(key, await providers.auditLeafEval(ucis));
    }
    return evalCache.get(key);
  };
  const seenLeafKeys = new Set();
  const recordLeaf = (leaf) => {
    const key = `${leaf.kind}:${leaf.ucis.join(" ")}`;
    if (seenLeafKeys.has(key)) return;
    seenLeafKeys.add(key);
    auditedLeaves.push(leaf);
  };

  const mainUcis = mainlineLeafUcis(working);
  const mainEval = await evalLeaf(mainUcis);
  recordLeaf({
    kind: "mainline",
    ucis: mainUcis,
    evalCp: mainEval.evalCp,
  });

  if (mainEval.evalCp < EXT_ENDPOINT_MIN_CP) {
    return {
      ok: false,
      candidate: working,
      auditedLeaves,
      prunedBranches,
      eliminateReason: "audit:mainlineLeaf",
    };
  }

  let scanning = true;
  while (scanning) {
    scanning = false;
    const branches = [...(working.extension.branches || [])];
    for (let i = branches.length - 1; i >= 0; i -= 1) {
      const branch = branches[i];
      const leafUcis = branchLeafUcis(working, branch);
      const leafEval = await evalLeaf(leafUcis);
      recordLeaf({
        kind: "branch",
        forkPlyIndex: branch.forkPlyIndex,
        ucis: leafUcis,
        evalCp: leafEval.evalCp,
      });

      if (leafEval.evalCp < EXT_ENDPOINT_MIN_CP) {
        branches.splice(i, 1);
        prunedBranches.push({
          packageId: working.id,
          forkPlyIndex: branch.forkPlyIndex,
        });
        const newLeafCount = Math.max(1, (working.extension.leafCount ?? 1) - 1);
        working = {
          ...working,
          extension: {
            ...working.extension,
            branches,
            leafCount: newLeafCount,
          },
          memTree: {
            ...working.memTree,
            leafCount: newLeafCount,
            forkCount: Math.max(0, (working.memTree.forkCount ?? 0) - 1),
          },
        };

        const memResult = resolveMemorabilityBudget(working, working.primaryStyle ?? null);
        if (!memResult.ok) {
          return {
            ok: false,
            candidate: working,
            auditedLeaves,
            prunedBranches,
            eliminateReason: memResult.reasons[0] ?? "memorability:afterAuditPrune",
          };
        }
        working = memResult.candidate;
        scanning = true;
        break;
      }
    }
  }

  return {
    ok: true,
    candidate: working,
    auditedLeaves,
    prunedBranches,
    eliminateReason: null,
  };
}

/**
 * @param {FunnelCandidate} rep
 */
function toOutputPackage(rep, auditedLeaves) {
  const primaryStyle = rep.primaryStyle ?? null;
  const riskTags = deriveRiskBadges({
    ...rep.riskMetrics,
    primaryStyle,
  });

  return {
    id: rep.id,
    subjectColor: rep.subjectColor,
    trunkUcis: rep.trunkUcis,
    trunkEndEpd: rep.trunkEndEpd,
    entryEpd: rep.entryEpd,
    entryUcis: rep.entryUcis,
    tendencyIds: rep.tendencyIds,
    trunk: rep.trunk,
    extension: rep.extension,
    demotedNotes: rep.demotedNotes || [],
    primaryStyle,
    styles: rep.styles || [],
    riskTags,
    memPenaltyScore: rep.memPenaltyScore ?? memPenaltyScore(rep),
    auditedLeaves,
  };
}

/**
 * Run the Scout v13 selection funnel (design §4, §11 step 4).
 * @param {FunnelCandidate[]} candidates
 * @param {AuditProviders} providers
 * @param {object} [_opts] — reserved for harness overrides.
 * @returns {Promise<SelectionFunnelReport>}
 */
export async function runSelectionFunnel(candidates, providers, _opts = {}) {
  /** @type {Array<{ id: string, reasons: string[] }>} */
  const eliminated = [];

  /** @type {FunnelCandidate[]} */
  const survivors = [];
  for (const candidate of candidates) {
    const gate = runHardGates(candidate);
    if (!gate.pass) {
      eliminated.push({ id: candidate.id, reasons: gate.reasons });
      continue;
    }
    survivors.push(gate.candidate);
  }

  const representatives = collapseToRepresentatives(survivors);

  /** @type {FunnelPackage[]} */
  const packages = [];
  /** @type {Array<{ color: string, bucket: string }>} */
  const bucketVacancies = [];
  /** @type {Array<{ packageId: string, forkPlyIndex: number }>} */
  const prunedBranches = [];

  const colors = [...new Set(representatives.map((r) => r.subjectColor))];
  for (const color of colors) {
    const { selected, bucketVacancies: vacancies, reserve } = selectForColor(
      representatives,
      color,
    );
    bucketVacancies.push(...vacancies);

    /** @type {FunnelCandidate[]} */
    const pending = [...selected];
    /** @type {FunnelCandidate[]} */
    const backfillPool = [
      ...reserve,
      ...representatives.filter(
        (r) =>
          r.subjectColor === color &&
          !pending.some((p) => p.id === r.id) &&
          !reserve.some((p) => p.id === r.id),
      ),
    ];

    const seenBackfill = new Set(pending.map((p) => p.id));
    for (const rep of backfillPool) {
      if (!seenBackfill.has(rep.id)) seenBackfill.add(rep.id);
    }

    let slotIndex = 0;
    while (slotIndex < pending.length) {
      const rep = pending[slotIndex];
      const audit = await auditPackageLeaves(rep, providers);

      if (audit.eliminateReason === "audit:mainlineLeaf") {
        eliminated.push({ id: rep.id, reasons: ["audit:mainlineLeaf"] });
        pending.splice(slotIndex, 1);

        const alreadyIds = new Set([
          ...packages.map((p) => p.id),
          ...pending.map((p) => p.id),
          ...eliminated.map((e) => e.id),
        ]);

        const replacement = [...backfillPool]
          .filter((r) => r.subjectColor === color && !alreadyIds.has(r.id))
          .sort(
            (a, b) =>
              marginalRelevance(b, pending) - marginalRelevance(a, pending),
          )[0];

        if (replacement) {
          pending.push(replacement);
          seenBackfill.add(replacement.id);
        }
        continue;
      }

      if (!audit.ok) {
        eliminated.push({
          id: rep.id,
          reasons: audit.eliminateReason ? [audit.eliminateReason] : ["audit:failed"],
        });
        pending.splice(slotIndex, 1);
        continue;
      }

      prunedBranches.push(...audit.prunedBranches);
      packages.push(toOutputPackage(audit.candidate, audit.auditedLeaves));
      slotIndex += 1;
    }
  }

  const report = {
    packages,
    bucketVacancies,
    eliminated,
    prunedBranches,
  };

  assertReportClean(report);
  return report;
}

/**
 * Ensure funnel report never leaks internal model fields or banned vocabulary.
 * @param {SelectionFunnelReport} report
 */
export function assertReportClean(report) {
  const json = JSON.stringify(report);
  if (json.includes("piTilt")) {
    throw new Error("funnel report must not contain piTilt");
  }
  const lower = json.toLowerCase();
  for (const word of V12_BANNED_VOCAB) {
    if (lower.includes(word.toLowerCase())) {
      throw new Error(`funnel report must not contain banned vocab: ${word}`);
    }
  }
}