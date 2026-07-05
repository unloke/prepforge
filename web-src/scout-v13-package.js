// Scout v13 — PrepPackage schema, coverage-component collapse, representative selection.
// Pure functions only — no DOM, no engine I/O.

import { isNestedPath, jeffreysLower } from "./scout-bias-routes.js";
import { AUDIT_MIN_SUBJECT_CHOSE, epdFromUcis } from "./scout-route-audit.js";

export const EVIDENCE_SOURCES = Object.freeze(["personal", "cohort", "engine"]);
export const PACKAGE_STYLES = Object.freeze(["solid", "sharp", "rare", "forcing"]);
export const PERSONAL_SUBJECT_PHRASES = Object.freeze(["他會", "他常"]);
export const EXTENSION_PLAN_HALF_MOVES = 4;

/**
 * @typedef {"personal"|"cohort"|"engine"} EvidenceSource
 */

/**
 * @typedef {object} EvidenceEdge
 * @property {string} uci
 * @property {string} [san]
 * @property {EvidenceSource} evidenceSource
 * @property {object} receipts
 * @property {string} [copy]
 * @property {string} [note]
 */

/**
 * @typedef {object} PrepPackage
 * @property {{ epd: string, ourEntryUcis: string[] }} entryRegion
 * @property {{ edges: EvidenceEdge[], personalAnchorPly: number, reachLB: number }} trunk
 * @property {{ mainline: EvidenceEdge[], branches: EvidenceEdge[][] }} extension
 * @property {"solid"|"sharp"|"rare"|"forcing"|null} style
 * @property {string[]} tendencyIds
 * @property {null} tier
 * @property {string[]} riskTags
 * @property {object} receipts
 * @property {string[]} notes
 */

/**
 * @typedef {object} CoverageCandidate
 * @property {string[]} trunkUcis
 * @property {string} trunkEndEpd
 * @property {string} entryEpd
 * @property {string[]} [entryUcis]
 * @property {string[]} extensionMainlineUcis
 * @property {string} subjectColor
 * @property {Array<{ k: number, n: number }>} trunkSegments
 * @property {number} anchorAttribution
 * @property {string[]} [tendencyIds]
 */

function isEvidenceSource(value) {
  return EVIDENCE_SOURCES.includes(value);
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value) {
  return Number.isFinite(value);
}

function validatePersonalReceipts(receipts, errors, prefix) {
  for (const key of ["games", "wins", "draws", "losses"]) {
    if (!finiteNumber(receipts[key])) {
      errors.push(`${prefix}: personal receipts.${key} must be a finite number`);
    }
  }
}

function validateCohortReceipts(receipts, errors, prefix) {
  for (const key of ["explorerGames", "sharePct", "ratingBand", "speed"]) {
    if (key === "sharePct") {
      if (!finiteNumber(receipts.sharePct)) {
        errors.push(`${prefix}: cohort receipts.sharePct must be a finite number`);
      }
      continue;
    }
    if (key === "explorerGames") {
      if (!finiteNumber(receipts.explorerGames)) {
        errors.push(`${prefix}: cohort receipts.explorerGames must be a finite number`);
      }
      continue;
    }
    if (receipts[key] === undefined || receipts[key] === null || receipts[key] === "") {
      errors.push(`${prefix}: cohort receipts.${key} is required`);
    }
  }
}

function validateEngineReceipts(receipts, errors, prefix) {
  if (!finiteNumber(receipts.evalCp)) {
    errors.push(`${prefix}: engine receipts.evalCp must be a finite number`);
  }
  if (hasOwn(receipts, "gapToBestCp") && !finiteNumber(receipts.gapToBestCp)) {
    errors.push(`${prefix}: engine receipts.gapToBestCp must be a finite number when present`);
  }
}

function validateSubjectDiscipline(edge, errors, prefix) {
  if (edge.evidenceSource === "personal") return;
  for (const field of ["copy", "note"]) {
    const text = edge[field];
    if (typeof text !== "string" || !text) continue;
    for (const phrase of PERSONAL_SUBJECT_PHRASES) {
      if (text.includes(phrase)) {
        errors.push(`${prefix}: non-personal edge ${field} must not contain "${phrase}"`);
      }
    }
  }
}

/**
 * @param {unknown} edge
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateEvidenceEdge(edge) {
  const errors = [];
  if (!isPlainObject(edge)) {
    return { ok: false, errors: ["EvidenceEdge must be a plain object"] };
  }
  if (typeof edge.uci !== "string" || !edge.uci) {
    errors.push("EvidenceEdge.uci is required");
  }
  if (!isEvidenceSource(edge.evidenceSource)) {
    errors.push(
      `EvidenceEdge.evidenceSource must be one of ${EVIDENCE_SOURCES.join(", ")}`,
    );
  }
  if (!isPlainObject(edge.receipts)) {
    errors.push("EvidenceEdge.receipts must be a plain object");
    return { ok: false, errors };
  }
  const prefix = `edge ${edge.uci || "?"}`;
  if (edge.evidenceSource === "personal") {
    validatePersonalReceipts(edge.receipts, errors, prefix);
  } else if (edge.evidenceSource === "cohort") {
    validateCohortReceipts(edge.receipts, errors, prefix);
  } else if (edge.evidenceSource === "engine") {
    validateEngineReceipts(edge.receipts, errors, prefix);
  }
  validateSubjectDiscipline(edge, errors, prefix);
  return { ok: errors.length === 0, errors };
}

function validateTrunkPersonalOnly(edges, errors, location) {
  for (const edge of edges) {
    if (edge.evidenceSource !== "personal") {
      errors.push(`${location}: trunk edges must be personal (got ${edge.evidenceSource})`);
    }
  }
}

function validateExtensionEdges(edges, errors, location) {
  for (const edge of edges) {
    if (edge.evidenceSource === "personal") {
      const games = edge.receipts?.games;
      if (!finiteNumber(games) || games < AUDIT_MIN_SUBJECT_CHOSE) {
        errors.push(
          `${location}: extension personal edge requires receipts.games >= ${AUDIT_MIN_SUBJECT_CHOSE}`,
        );
      }
    }
    const edgeResult = validateEvidenceEdge(edge);
    for (const err of edgeResult.errors) {
      if (!errors.includes(err)) errors.push(`${location}: ${err}`);
    }
  }
}

/**
 * @param {unknown} pkg
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validatePrepPackage(pkg) {
  const errors = [];
  if (!isPlainObject(pkg)) {
    return { ok: false, errors: ["PrepPackage must be a plain object"] };
  }

  if (!isPlainObject(pkg.entryRegion)) {
    errors.push("entryRegion is required");
  } else {
    if (typeof pkg.entryRegion.epd !== "string" || !pkg.entryRegion.epd) {
      errors.push("entryRegion.epd is required");
    }
    if (!Array.isArray(pkg.entryRegion.ourEntryUcis)) {
      errors.push("entryRegion.ourEntryUcis must be an array");
    }
  }

  if (!isPlainObject(pkg.trunk)) {
    errors.push("trunk is required");
  } else {
    if (!Array.isArray(pkg.trunk.edges)) {
      errors.push("trunk.edges must be an array");
    } else {
      validateTrunkPersonalOnly(pkg.trunk.edges, errors, "trunk");
      for (const edge of pkg.trunk.edges) {
        const edgeResult = validateEvidenceEdge(edge);
        for (const err of edgeResult.errors) errors.push(`trunk: ${err}`);
      }
    }
    if (!finiteNumber(pkg.trunk.personalAnchorPly) || pkg.trunk.personalAnchorPly < 0) {
      errors.push("trunk.personalAnchorPly must be a finite number >= 0");
    }
    if (!finiteNumber(pkg.trunk.reachLB)) {
      errors.push("trunk.reachLB must be a finite number");
    }
  }

  if (!isPlainObject(pkg.extension)) {
    errors.push("extension is required");
  } else {
    if (!Array.isArray(pkg.extension.mainline)) {
      errors.push("extension.mainline must be an array");
    } else {
      validateExtensionEdges(pkg.extension.mainline, errors, "extension.mainline");
    }
    if (!Array.isArray(pkg.extension.branches)) {
      errors.push("extension.branches must be an array");
    } else {
      for (let i = 0; i < pkg.extension.branches.length; i += 1) {
        const branch = pkg.extension.branches[i];
        if (!Array.isArray(branch)) {
          errors.push(`extension.branches[${i}] must be an array`);
          continue;
        }
        validateExtensionEdges(branch, errors, `extension.branches[${i}]`);
      }
    }
  }

  if (pkg.style !== null && !PACKAGE_STYLES.includes(pkg.style)) {
    errors.push(`style must be one of ${PACKAGE_STYLES.join(", ")} or null`);
  }
  if (!Array.isArray(pkg.tendencyIds)) {
    errors.push("tendencyIds must be an array");
  }
  if (pkg.tier !== null) {
    errors.push("tier must be null");
  }
  if (!Array.isArray(pkg.riskTags)) {
    errors.push("riskTags must be an array");
  }
  if (!isPlainObject(pkg.receipts)) {
    errors.push("receipts must be a plain object");
  }
  if (!Array.isArray(pkg.notes)) {
    errors.push("notes must be an array");
  }

  return { ok: errors.length === 0, errors };
}

/** Prefix EPDs along a trunk UCI path (empty path → no EPDs). */
export function pathEpdsFromUcis(trunkUcis) {
  if (!Array.isArray(trunkUcis) || trunkUcis.length === 0) return [];
  const out = [];
  for (let i = 1; i <= trunkUcis.length; i += 1) {
    out.push(epdFromUcis(trunkUcis.slice(0, i)));
  }
  return out;
}

function sharesExtensionPlan(a, b) {
  const planA = a.extensionMainlineUcis || [];
  const planB = b.extensionMainlineUcis || [];
  const n = EXTENSION_PLAN_HALF_MOVES;
  if (planA.length < n || planB.length < n) return false;
  for (let i = 0; i < n; i += 1) {
    if (planA[i] !== planB[i]) return false;
  }
  return true;
}

function trunkPathsOverlap(a, b, epdsA, epdsB) {
  if (isNestedPath(a.trunkUcis || [], b.trunkUcis || [])) return true;
  if (a.trunkEndEpd && epdsB.includes(a.trunkEndEpd)) return true;
  if (b.trunkEndEpd && epdsA.includes(b.trunkEndEpd)) return true;
  return false;
}

function sameCoverageComponent(a, b, epdsA, epdsB) {
  if (a.entryEpd && b.entryEpd && a.entryEpd === b.entryEpd) return true;
  if (trunkPathsOverlap(a, b, epdsA, epdsB)) return true;
  if (sharesExtensionPlan(a, b)) return true;
  return false;
}

class UnionFind {
  constructor(n) {
    this.parent = Array.from({ length: n }, (_, i) => i);
    this.rank = new Array(n).fill(0);
  }

  find(x) {
    if (this.parent[x] !== x) this.parent[x] = this.find(this.parent[x]);
    return this.parent[x];
  }

  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    if (this.rank[ra] < this.rank[rb]) {
      this.parent[ra] = rb;
    } else if (this.rank[ra] > this.rank[rb]) {
      this.parent[rb] = ra;
    } else {
      this.parent[rb] = ra;
      this.rank[ra] += 1;
    }
  }
}

/**
 * Collapse package candidates into coverage components (design §3).
 * @param {CoverageCandidate[]} candidates
 * @returns {CoverageCandidate[][]}
 */
export function coverageComponents(candidates) {
  if (!candidates?.length) return [];
  const n = candidates.length;
  // Prefix EPDs cost a chess.js replay per candidate — compute once, not per pair.
  const pathEpds = candidates.map((c) => pathEpdsFromUcis(c.trunkUcis));
  const uf = new UnionFind(n);
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      if (sameCoverageComponent(candidates[i], candidates[j], pathEpds[i], pathEpds[j])) {
        uf.union(i, j);
      }
    }
  }
  const buckets = new Map();
  for (let i = 0; i < n; i += 1) {
    const root = uf.find(i);
    if (!buckets.has(root)) buckets.set(root, []);
    buckets.get(root).push(candidates[i]);
  }
  const roots = [...buckets.keys()].sort((a, b) => a - b);
  return roots.map((root) => buckets.get(root));
}

/**
 * Product of Jeffreys LB over trunk HIS segments only (design §4 Stage 2).
 * @param {Array<{ k: number, n: number }>} trunkSegments
 */
export function personalReachFromSegments(trunkSegments) {
  if (!trunkSegments?.length) return 1;
  let product = 1;
  for (const seg of trunkSegments) {
    product *= jeffreysLower(seg.k, seg.n);
  }
  return product;
}

/** Stage-2 score: trunk personalReach × anchor attribution (extension excluded). */
export function candidatePersonalScore(candidate) {
  const reach = personalReachFromSegments(candidate.trunkSegments);
  const attribution = Math.max(0, Number(candidate.anchorAttribution) || 0);
  return reach * attribution;
}

function entryUcisKey(candidate) {
  const moves = candidate.entryUcis;
  return Array.isArray(moves) ? moves.join(" ") : "";
}

function tendencyDiffNote(representative, candidate) {
  const repIds = new Set(representative.tendencyIds || []);
  const otherIds = (candidate.tendencyIds || []).filter((id) => !repIds.has(id));
  if (!otherIds.length) return null;
  return `此計畫亦由傾向 ${otherIds.join("、")} 支持`;
}

function entryDiffNote(representative, candidate) {
  const repKey = entryUcisKey(representative);
  const candKey = entryUcisKey(candidate);
  if (!candKey || candKey === repKey) return null;
  return `亦可由走序 ${candKey} 進入`;
}

function demotedNote(representative, candidate) {
  const tendencyNote = tendencyDiffNote(representative, candidate);
  const entryNote = entryDiffNote(representative, candidate);
  if (tendencyNote && entryNote) return `${tendencyNote}；${entryNote}`;
  return tendencyNote || entryNote || "同元件候選";
}

function mergeTendencyIds(representative, component) {
  const merged = new Set(representative.tendencyIds || []);
  for (const cand of component) {
    for (const id of cand.tendencyIds || []) merged.add(id);
  }
  return [...merged];
}

/**
 * Pick one representative per coverage component — argmax over whole component (§3 裁決修訂).
 * @param {CoverageCandidate[]} component
 * @returns {{ representative: CoverageCandidate, demoted: Array<{ candidate: CoverageCandidate, note: string }> }}
 */
export function selectComponentRepresentative(component) {
  if (!component?.length) {
    throw new Error("selectComponentRepresentative requires a non-empty component");
  }
  let bestIdx = 0;
  let bestScore = -Infinity;
  for (let i = 0; i < component.length; i += 1) {
    const score = candidatePersonalScore(component[i]);
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  const winner = component[bestIdx];
  const demoted = [];
  for (let i = 0; i < component.length; i += 1) {
    if (i === bestIdx) continue;
    demoted.push({
      candidate: component[i],
      note: demotedNote(winner, component[i]),
    });
  }
  const representative = {
    ...winner,
    tendencyIds: mergeTendencyIds(winner, component),
  };
  return { representative, demoted };
}