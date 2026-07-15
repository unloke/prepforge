// Scout robust-Y Phase-0 — zero-engine inventory / same-v2-X feasibility gate.
// Research-only pure module. Imports production Scout helpers read-only; never
// modifies web-src or production Scout/UI. Product always preserve-v2.

import { isAbsolute, relative, resolve } from "node:path";

import { Chess } from "chess.js";

import {
  PRODUCT_VERDICT,
  computePlayersSha256,
  discoverCohortPairs,
  orderedPlayerIds,
} from "../../web-src/scout-meta-maia-p0.js";
import {
  sha256Buffer,
  sha256Hex,
} from "../../web-src/scout-v15-study.js";
import { lineLastSeen } from "../../web-src/scout-stats.js";
import {
  SCOUT_BRANCH_SCORE_CAP,
  buildOpeningTrie,
  branchPathKey,
  isEarlyResignCollapse,
  normalizeToOpponentTerminal,
  rankGamePlan,
  rankedOpeningBranches,
  terminalMoveIsOpponent,
  triePathKey,
} from "../../web-src/scout.js";

// ── Constants ──────────────────────────────────────────────────────────────

export const RY_PROTOCOL_KIND = "scout-robust-y-p1-protocol";
export const RY_PROTOCOL_ID = "robust-y-p1";
export const RY_REPORT_KIND = "scout-robust-y-p1-phase0-report";
export const RY_REPORT_VERSION = 1;
export const RY_MANIFEST_KIND = "scout-robust-y-p1-phase0-manifest";
export const RY_FINAL_REPORT_NAME = "report.json";
export const RY_SUMMARY_NAME = "summary.md";
export const RY_PHASE0_STARTED_NAME = "phase0-started.json";
export const RY_V2_X_SOURCE = "v2-train-only-no-maia-phase0";

export const RY_STATES = Object.freeze({
  UNINITIALIZED: "uninitialized",
  FROZEN: "frozen",
  PHASE0_COMPLETE: "phase0-complete",
  VERIFIED: "verified",
});

export const RY_STATE_TRANSITIONS = Object.freeze({
  [RY_STATES.UNINITIALIZED]: [RY_STATES.FROZEN],
  [RY_STATES.FROZEN]: [RY_STATES.PHASE0_COMPLETE],
  [RY_STATES.PHASE0_COMPLETE]: [RY_STATES.VERIFIED],
  [RY_STATES.VERIFIED]: [],
});

export const RY_VERDICTS = Object.freeze({
  PHASE0_RUNNABLE: "PHASE0_RUNNABLE",
  PHASE0_INSUFFICIENT_INVENTORY: "PHASE0_INSUFFICIENT_INVENTORY",
  INVALID: "INVALID",
});

export const RY_DEPTH_BINS = Object.freeze([
  { name: "2-4", min: 2, max: 4 },
  { name: "5-8", min: 5, max: 8 },
  { name: "9-12", min: 9, max: 12 },
]);

const MS_PER_UTC_DAY = 86_400_000;

const LOCKED = Object.freeze({
  cohortRoot: "tmp/cohort-unbrainless87",
  forbiddenInputs: ["*-fit.json", "network", "engine", "maia-inference", "d8", "d18"],
  claimForbids: [
    "product or card authorization",
    "human study authorization",
    "v2 replacement claims",
    "confirmatory opponent future-move proof",
    "engine-phase authorization from Phase0 alone",
    "network acquisition",
    "24k-game rating panels",
    "reinterpretation of sealed rating Stage1 verdicts",
  ],
  subjectColors: ["white", "black"],
  v2Pipeline: {
    primarySource: "v2-train-only-no-maia-phase0",
    module: "web-src/scout.js",
    imports: ["buildOpeningTrie", "rankedOpeningBranches", "rankGamePlan"],
    exclude: [
      "maia-rerank",
      "explorer",
      "engine-patterns",
      "repertoire",
      "prefilter-enrichment",
    ],
    topKAfterCollapse: 1,
    terminalNormalization: "production normalizeToOpponentTerminal",
    mustEndOnOpponentMove: true,
    usableLengthPlies: [2, 12],
    surface: "scout-report.js-no-enrichment",
    candidateCap: SCOUT_BRANCH_SCORE_CAP,
    lineLastSeen: "web-src/scout-stats.js#lineLastSeen",
  },
  windows: {
    minTrainGames: 30,
    futureWindowGames: 10,
    strideGames: 10,
    maxCutoffsPerPlayerColor: 4,
  },
  gates: {
    minTotalUsableUnits: 40,
    minPlayersWithUsableUnit: 12,
    minRepeatSupportedUnits: 20,
    minPlayersWithRepeatSupportedUnit: 10,
    v2FutureEntryBinaryRateMin: 0.10,
    v2FutureEntryBinaryRateMax: 0.90,
    medianFutureGamesExact: 10,
    noTrainFutureLeakage: true,
  },
  grounded: {
    arm: "grounded-x-robust-y",
    maxOurDecisionPoints: 5,
    maxPlies: 12,
    minDistinctGames: 2,
    minDistinctDates: 2,
    selectionRule: "deepest qualifying prefix on newest train game; tie-break longer then lexical UCI path",
    singletonRole: "diagnostic-only-never-phase0-s1",
  },
  futureP1: {
    selectionDepth: 8,
    auditDepth: 18,
    safetyGapMaxCp: 30,
    selectionRule: "d8 only for candidate choice",
    auditRule: "d18 only for intrinsic audit; no evaluation reuse in selection",
    replyUncertainty: "union of Stockfish best defences and rating-band Maia replies; no target future reply probabilities",
    intrinsicVFormula: "leave-one-reply-out equal-weight concession vs best defence from our perspective at d18",
    unitWeightAbstainRule: "one card or abstain; abstain sets V=0 and W=0",
    primaryDeltaXFixedNote: "futurePrefixEntryBinary identical because X is fixed",
    phase1aRequirement: "robust-Y must differ from v2-Y on enough units; not assessed in Phase0",
    conditionalExploratoryNote: "Future recurrence band [0.10,0.90] conditions same-panel P1 only; cannot estimate unconditional/generalizable effect or confirm anything; does not tune Y.",
    bootstrapNote: "Up to 4 nested-train cutoffs per player-color are correlated; future P1 must use player-cluster/hierarchical bootstrap and cannot treat cutoffs as independent.",
  },
  futureRecurrenceRule: "factual prefix re-entry over the 10-game future window only",
  reportHashCanonicalJson: "pretty-printed 2-space JSON with reportSha256 field omitted",
  claimExploratoryNote: "Lower rating-moderation panel is visible and sealed for Stage1; this reuse is exploratory analysis-lock only and cannot confirm or authorize product.",
  claimPhase0Scope: "zero-engine inventory and prefix-recurrence diagnostics only; Y not generated",
  lifecycle: {
    commands: ["freeze", "phase0", "verify", "status"],
    studyRoot: "tmp/scout-robust-y/robust-y-p1",
    requiredArtifacts: [
      "protocol.snapshot.json",
      "manifest.json",
      "phase0-started.json",
      "phase0/summary.md",
      "phase0/report.json",
      "phase0/per-unit",
    ],
    phase0StartedMarker: "phase0-started.json",
    protocolSourceAfterFreeze: "protocol.snapshot.json",
    protocolSha256Convention: "raw protocol file bytes at freeze; canonical JSON helper is synthetic-only",
    reportHashField: "reportSha256",
    reportHashOmitField: true,
  },
  expectedPlayerCount: 17,
});

export { discoverCohortPairs, orderedPlayerIds, PRODUCT_VERDICT, sha256Buffer, sha256Hex };

// ── Protocol / state ───────────────────────────────────────────────────────

export function sha256RobustYProtocolCanonical(protocol) {
  const canonical = { ...(protocol || {}) };
  delete canonical.protocolSha256;
  return sha256Hex(`${JSON.stringify(canonical, null, 2)}\n`);
}

export function assertRyStateTransition(from, to) {
  const allowed = RY_STATE_TRANSITIONS[from];
  if (!Array.isArray(allowed) || !allowed.includes(to)) {
    throw new Error(`illegal robust-y state transition: ${from} -> ${to}`);
  }
}

function arraysEqual(a, b) {
  return Array.isArray(a) && Array.isArray(b)
    && a.length === b.length
    && a.every((v, i) => v === b[i]);
}

function lockedArrayEqual(actual, expected, label, errors) {
  if (!arraysEqual(actual, expected)) errors.push(`${label} locked mismatch`);
}

export function normalizeCohortRootRel(absOrRelPath, rootDir = "") {
  const root = resolve(String(rootDir || "") || process.cwd());
  const target = resolve(root, absOrRelPath);
  const rel = relative(root, target).split("\\").join("/");
  if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
    return null;
  }
  return rel;
}

export function assertFreezeCohortRoot({ protocol, cohortRootAbs, rootDir } = {}) {
  const expected = protocol?.inputs?.cohortRoot ?? LOCKED.cohortRoot;
  const actual = normalizeCohortRootRel(cohortRootAbs, rootDir);
  if (actual == null) {
    return {
      ok: false,
      errors: ["cohort root resolves outside project root or via traversal"],
      expected,
      actual: null,
    };
  }
  if (actual !== expected) {
    return {
      ok: false,
      errors: [`cohort root ${actual} !== protocol.inputs.cohortRoot ${expected}`],
      expected,
      actual,
    };
  }
  return { ok: true, cohortRoot: actual, expected };
}

export function validateRobustYProtocol(protocol) {
  const errors = [];
  if (protocol?.kind !== RY_PROTOCOL_KIND) errors.push(`kind must be ${RY_PROTOCOL_KIND}`);
  if (protocol?.protocolId !== RY_PROTOCOL_ID) errors.push(`protocolId must be ${RY_PROTOCOL_ID}`);
  if (protocol?.role !== "exploratory-zero-network-robust-y-phase0-analysis-lock") {
    errors.push("role must be exploratory-zero-network-robust-y-phase0-analysis-lock");
  }
  if (protocol?.productAuthorization !== false) errors.push("productAuthorization must be false");
  if (protocol?.cannotAuthorizeCards !== true) errors.push("cannotAuthorizeCards must be true");
  if (protocol?.cannotAuthorizeHumanStudy !== true) errors.push("cannotAuthorizeHumanStudy must be true");
  if (protocol?.productVerdict !== PRODUCT_VERDICT) errors.push(`productVerdict must be ${PRODUCT_VERDICT}`);
  if (protocol?.preserveV2Regardless !== true) errors.push("preserveV2Regardless must be true");
  if (protocol?.labelsAlreadyVisible !== true) errors.push("labelsAlreadyVisible must be true");
  if (protocol?.dataAlreadyVisible !== true) errors.push("dataAlreadyVisible must be true");
  if (protocol?.analysisLock !== true) errors.push("analysisLock must be true");
  if (protocol?.confirmatoryPreregistration !== false) {
    errors.push("confirmatoryPreregistration must be false");
  }
  if (protocol?.nextWorkRequiresNewProtocol !== true) {
    errors.push("nextWorkRequiresNewProtocol must be true");
  }

  const claim = protocol?.claimBoundary || {};
  if (claim.noFutureMoveProof !== true) errors.push("claimBoundary.noFutureMoveProof must be true");
  lockedArrayEqual(claim.forbids, LOCKED.claimForbids, "claimBoundary.forbids", errors);
  if (claim.exploratoryNote !== LOCKED.claimExploratoryNote) {
    errors.push("claimBoundary.exploratoryNote locked mismatch");
  }
  if (claim.phase0Scope !== LOCKED.claimPhase0Scope) {
    errors.push("claimBoundary.phase0Scope locked mismatch");
  }

  const inputs = protocol?.inputs || {};
  if (inputs.cohortRoot !== LOCKED.cohortRoot) {
    errors.push(`inputs.cohortRoot must be ${LOCKED.cohortRoot}`);
  }
  lockedArrayEqual(inputs.forbiddenInputs, LOCKED.forbiddenInputs, "inputs.forbiddenInputs", errors);
  if (inputs.expectedPlayerCount !== LOCKED.expectedPlayerCount) {
    errors.push("inputs.expectedPlayerCount locked mismatch");
  }
  if (inputs.phase0UsesGameJsonOnly !== true) {
    errors.push("inputs.phase0UsesGameJsonOnly must be true");
  }
  if (inputs.deterministicPins !== true) errors.push("inputs.deterministicPins must be true");

  const du = protocol?.decisionUnits || {};
  if (du.grain !== "player-color-cutoff") errors.push("decisionUnits.grain locked mismatch");
  lockedArrayEqual(du.subjectColor, LOCKED.subjectColors, "decisionUnits.subjectColor", errors);
  if (du.noGameCrossing !== true) errors.push("decisionUnits.noGameCrossing must be true");
  lockedArrayEqual(du.ordering, ["datestamp", "gameId"], "decisionUnits.ordering", errors);

  const windows = du.windows || {};
  for (const [k, v] of Object.entries(LOCKED.windows)) {
    if (windows[k] !== v) errors.push(`decisionUnits.windows.${k} locked mismatch`);
  }
  if (windows.strideGames !== windows.futureWindowGames) {
    errors.push("decisionUnits.windows.strideGames must equal futureWindowGames");
  }

  const gates = protocol?.phase0Gates || {};
  for (const [k, v] of Object.entries(LOCKED.gates)) {
    if (gates[k] !== v) errors.push(`phase0Gates.${k} locked mismatch`);
  }

  const xSel = protocol?.xSelection || {};
  if (xSel.primarySource !== LOCKED.v2Pipeline.primarySource) {
    errors.push("xSelection.primarySource locked mismatch");
  }
  const v2 = xSel.v2Pipeline || {};
  if (v2.module !== LOCKED.v2Pipeline.module) errors.push("xSelection.v2Pipeline.module locked mismatch");
  lockedArrayEqual(v2.imports, LOCKED.v2Pipeline.imports, "xSelection.v2Pipeline.imports", errors);
  lockedArrayEqual(v2.exclude, LOCKED.v2Pipeline.exclude, "xSelection.v2Pipeline.exclude", errors);
  if (v2.topKAfterCollapse !== LOCKED.v2Pipeline.topKAfterCollapse) {
    errors.push("xSelection.v2Pipeline.topKAfterCollapse locked mismatch");
  }
  if (v2.terminalNormalization !== LOCKED.v2Pipeline.terminalNormalization) {
    errors.push("xSelection.v2Pipeline.terminalNormalization locked mismatch");
  }
  if (v2.mustEndOnOpponentMove !== LOCKED.v2Pipeline.mustEndOnOpponentMove) {
    errors.push("xSelection.v2Pipeline.mustEndOnOpponentMove must be true");
  }
  lockedArrayEqual(v2.usableLengthPlies, LOCKED.v2Pipeline.usableLengthPlies, "xSelection.v2Pipeline.usableLengthPlies", errors);
  if (v2.surface !== LOCKED.v2Pipeline.surface) errors.push("xSelection.v2Pipeline.surface locked mismatch");
  if (v2.candidateCap !== LOCKED.v2Pipeline.candidateCap) {
    errors.push("xSelection.v2Pipeline.candidateCap locked mismatch");
  }
  if (v2.lineLastSeen !== LOCKED.v2Pipeline.lineLastSeen) {
    errors.push("xSelection.v2Pipeline.lineLastSeen locked mismatch");
  }

  const grounded = xSel.groundedInventory || {};
  if (grounded.arm !== LOCKED.grounded.arm) errors.push("xSelection.groundedInventory.arm locked mismatch");
  if (grounded.maxOurDecisionPoints !== LOCKED.grounded.maxOurDecisionPoints) {
    errors.push("xSelection.groundedInventory.maxOurDecisionPoints locked mismatch");
  }
  if (grounded.maxPlies !== LOCKED.grounded.maxPlies) {
    errors.push("xSelection.groundedInventory.maxPlies locked mismatch");
  }
  if (grounded.productClaimMinDistinctGames !== LOCKED.grounded.minDistinctGames) {
    errors.push("xSelection.groundedInventory.productClaimMinDistinctGames locked mismatch");
  }
  if (grounded.productClaimMinDistinctDates !== LOCKED.grounded.minDistinctDates) {
    errors.push("xSelection.groundedInventory.productClaimMinDistinctDates locked mismatch");
  }
  if (grounded.selectionRule !== LOCKED.grounded.selectionRule) {
    errors.push("xSelection.groundedInventory.selectionRule locked mismatch");
  }
  if (grounded.singletonRole !== LOCKED.grounded.singletonRole) {
    errors.push("xSelection.groundedInventory.singletonRole locked mismatch");
  }
  if (grounded.trainOnly !== true) errors.push("xSelection.groundedInventory.trainOnly must be true");

  const prefix = xSel.prefixSupport || {};
  if (prefix.rule !== "exact UCI prefix match on train games only") {
    errors.push("xSelection.prefixSupport.rule locked mismatch");
  }
  if (prefix.distinctGames !== "count distinct gameId with ucis beginning with prefix") {
    errors.push("xSelection.prefixSupport.distinctGames locked mismatch");
  }
  if (prefix.distinctDates !== "count distinct normalized datestamp/day among supporting games") {
    errors.push("xSelection.prefixSupport.distinctDates locked mismatch");
  }

  const futureRec = xSel.futureRecurrence || {};
  lockedArrayEqual(
    futureRec.fields,
    ["futurePrefixEntryCount", "futurePrefixEntryRate", "futurePrefixEntryBinary"],
    "xSelection.futureRecurrence.fields",
    errors,
  );
  if (futureRec.notPrediction !== true) errors.push("xSelection.futureRecurrence.notPrediction must be true");
  if (futureRec.rule !== LOCKED.futureRecurrenceRule) {
    errors.push("xSelection.futureRecurrence.rule locked mismatch");
  }

  const primary = protocol?.futureArms?.primary || {};
  if (primary.name !== "same-v2-x-robust-y") {
    errors.push("futureArms.primary.name must be same-v2-x-robust-y");
  }
  if (primary.comparator !== "same-v2-x-v2-y") {
    errors.push("futureArms.primary.comparator must be same-v2-x-v2-y");
  }
  const secondary = protocol?.futureArms?.secondary || {};
  if (secondary.name !== "grounded-x-robust-y") {
    errors.push("futureArms.secondary.name must be grounded-x-robust-y");
  }

  const fp1 = protocol?.futureP1 || {};
  if (fp1.implementedInPhase0 !== false) errors.push("futureP1.implementedInPhase0 must be false");
  if (fp1.productAuthorization !== false) errors.push("futureP1.productAuthorization must be false");
  if (fp1.selectionDepth !== LOCKED.futureP1.selectionDepth) {
    errors.push("futureP1.selectionDepth locked mismatch");
  }
  if (fp1.auditDepth !== LOCKED.futureP1.auditDepth) {
    errors.push("futureP1.auditDepth locked mismatch");
  }
  if (fp1.intrinsicV?.safetyGapMaxCp !== LOCKED.futureP1.safetyGapMaxCp) {
    errors.push("futureP1.intrinsicV.safetyGapMaxCp locked mismatch");
  }
  if (fp1.unitWeight?.formula !== "W = futurePrefixEntryBinary * V") {
    errors.push("futureP1.unitWeight.formula locked mismatch");
  }
  if (fp1.primaryDelta?.formula !== "mean W(robustY) - mean W(v2Y) on same X units") {
    errors.push("futureP1.primaryDelta.formula locked mismatch");
  }
  if (fp1.conditionalExploratoryOnly !== true) {
    errors.push("futureP1.conditionalExploratoryOnly must be true");
  }
  if (fp1.cutoffCorrelationNote !== LOCKED.futureP1.bootstrapNote) {
    errors.push("futureP1.cutoffCorrelationNote locked mismatch");
  }
  if (fp1.replyUncertainty !== LOCKED.futureP1.replyUncertainty) {
    errors.push("futureP1.replyUncertainty locked mismatch");
  }
  if (fp1.selectionRule !== LOCKED.futureP1.selectionRule) {
    errors.push("futureP1.selectionRule locked mismatch");
  }
  if (fp1.auditRule !== LOCKED.futureP1.auditRule) {
    errors.push("futureP1.auditRule locked mismatch");
  }
  if (fp1.intrinsicV?.formula !== LOCKED.futureP1.intrinsicVFormula) {
    errors.push("futureP1.intrinsicV.formula locked mismatch");
  }
  if (fp1.unitWeight?.abstainRule !== LOCKED.futureP1.unitWeightAbstainRule) {
    errors.push("futureP1.unitWeight.abstainRule locked mismatch");
  }
  if (fp1.primaryDelta?.xFixedNote !== LOCKED.futureP1.primaryDeltaXFixedNote) {
    errors.push("futureP1.primaryDelta.xFixedNote locked mismatch");
  }
  if (fp1.phase1aRequirement !== LOCKED.futureP1.phase1aRequirement) {
    errors.push("futureP1.phase1aRequirement locked mismatch");
  }
  if (fp1.conditionalExploratoryNote !== LOCKED.futureP1.conditionalExploratoryNote) {
    errors.push("futureP1.conditionalExploratoryNote locked mismatch");
  }

  const lc = protocol?.lifecycle || {};
  lockedArrayEqual(lc.commands, LOCKED.lifecycle.commands, "lifecycle.commands", errors);
  if (lc.studyRoot !== LOCKED.lifecycle.studyRoot) errors.push("lifecycle.studyRoot locked mismatch");
  lockedArrayEqual(lc.requiredArtifacts, LOCKED.lifecycle.requiredArtifacts, "lifecycle.requiredArtifacts", errors);
  if (lc.phase0StartedMarker !== LOCKED.lifecycle.phase0StartedMarker) {
    errors.push("lifecycle.phase0StartedMarker locked mismatch");
  }
  if (lc.protocolSha256Convention !== LOCKED.lifecycle.protocolSha256Convention) {
    errors.push("lifecycle.protocolSha256Convention locked mismatch");
  }
  if (lc.reportHashField !== LOCKED.lifecycle.reportHashField) {
    errors.push("lifecycle.reportHashField locked mismatch");
  }
  if (lc.reportHashOmitField !== LOCKED.lifecycle.reportHashOmitField) {
    errors.push("lifecycle.reportHashOmitField locked mismatch");
  }
  if (lc.finalReportLast !== true) errors.push("lifecycle.finalReportLast must be true");
  if (lc.singlePhase0Lock !== true) errors.push("lifecycle.singlePhase0Lock must be true");
  const rh = protocol?.reportHash || {};
  if (rh.algorithm !== "sha256") errors.push("reportHash.algorithm must be sha256");
  if (rh.canonicalJson !== LOCKED.reportHashCanonicalJson) {
    errors.push("reportHash.canonicalJson locked mismatch");
  }

  return { ok: errors.length === 0, errors, role: protocol?.role || null };
}

// ── Lifecycle helpers ──────────────────────────────────────────────────────

function joinStudyPath(studyRoot, name) {
  const root = String(studyRoot || "").replace(/[/\\]+$/, "");
  return `${root}/${name}`.replace(/\\/g, "/");
}

export function listPhase0BurnMarkers(studyRoot, {
  exists = () => false,
  state = null,
  events = [],
} = {}) {
  const markers = [];
  const root = String(studyRoot || "").replace(/[/\\]+$/, "");
  if (exists(joinStudyPath(root, RY_PHASE0_STARTED_NAME))) {
    markers.push(RY_PHASE0_STARTED_NAME);
  }
  if (exists(joinStudyPath(root, "phase0", RY_FINAL_REPORT_NAME))) {
    markers.push(`phase0/${RY_FINAL_REPORT_NAME}`);
  }
  if ((events || []).some((e) => e.type === "phase0")) markers.push("event:phase0");
  if (state?.state === RY_STATES.PHASE0_COMPLETE || state?.state === RY_STATES.VERIFIED) {
    markers.push(`state:${state.state}`);
  }
  return [...new Set(markers)];
}

export function refuseIfPhase0Burned(studyRoot, {
  exists = () => false,
  state = null,
  events = [],
} = {}) {
  const markers = listPhase0BurnMarkers(studyRoot, { exists, state, events });
  if (state?.state === RY_STATES.PHASE0_COMPLETE || state?.state === RY_STATES.VERIFIED) {
    throw new Error(
      `robust-y single-phase0 lock: state is ${state.state}; phase0 cannot run again`,
    );
  }
  if (exists(joinStudyPath(studyRoot, RY_PHASE0_STARTED_NAME))
    && !exists(joinStudyPath(studyRoot, `phase0/${RY_FINAL_REPORT_NAME}`))) {
    throw new Error(
      "robust-y single-phase0 lock: phase0-started.json exists without report; study is burned",
    );
  }
  if ((events || []).filter((e) => e.type === "phase0").length > 0) {
    throw new Error("robust-y single-phase0 lock: duplicate phase0 event; study cannot rerun");
  }
  if (markers.length && state?.state !== RY_STATES.FROZEN) {
    // frozen + started-without-report handled above
  }
}

export function describePhase0StuckState(studyRoot, {
  exists = () => false,
  state = null,
  events = [],
} = {}) {
  const root = String(studyRoot || "").replace(/[/\\]+$/, "");
  const hasStarted = exists(joinStudyPath(root, RY_PHASE0_STARTED_NAME));
  const hasReport = exists(joinStudyPath(root, `phase0/${RY_FINAL_REPORT_NAME}`));
  const hasPhase0Event = (events || []).some((e) => e.type === "phase0");
  if (hasStarted && !hasReport) {
    return {
      stuck: true,
      reason: "phase0-started-without-report",
      message: "phase0-started.json exists but report.json is missing; study is burned and INVALID",
    };
  }
  if (state?.state === RY_STATES.PHASE0_COMPLETE && !hasReport) {
    return {
      stuck: true,
      reason: "phase0-complete-state-without-report",
      message: "state is phase0-complete but report.json is missing; study is INVALID",
    };
  }
  if (hasPhase0Event && !hasReport) {
    return {
      stuck: true,
      reason: "phase0-event-without-report",
      message: "phase0 event exists but report.json is missing; study is INVALID",
    };
  }
  return { stuck: false, reason: null, message: null };
}

export function shouldRunFullScientificRecompute(state) {
  return state === RY_STATES.PHASE0_COMPLETE || state === RY_STATES.VERIFIED;
}

// ── Game normalization / windows ───────────────────────────────────────────

export function gameIdOf(game) {
  const raw = game?.gameId ?? game?.id ?? "";
  const id = String(raw).trim();
  return id || "";
}

export function gameDatestamp(game) {
  const v = game?.datestamp ?? game?.playedAt ?? game?.date ?? null;
  if (v == null || v === "") return 0;
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.trim())) {
    const parsed = Date.parse(`${v.trim()}T00:00:00.000Z`);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return n;
  const parsed = Date.parse(String(v));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** Deterministic UTC calendar day key (YYYY-MM-DD) from datestamp or ms. */
export function utcDayKey(game) {
  const v = game?.datestamp ?? game?.playedAt ?? game?.date ?? null;
  if (v == null || v === "") return null;
  if (typeof v === "string") {
    const trimmed = v.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  }
  const ms = gameDatestamp(game);
  if (!ms) return null;
  const dayIndex = Math.floor(ms / MS_PER_UTC_DAY);
  return new Date(dayIndex * MS_PER_UTC_DAY).toISOString().slice(0, 10);
}

export function validateGameRecordForPhase0(game) {
  const id = gameIdOf(game);
  if (!id) return { ok: false, reason: "missing-game-id" };
  if (!utcDayKey(game)) return { ok: false, reason: "missing-or-invalid-date" };
  const ucis = game?.ucis;
  const sans = game?.openingSans?.length ? game.openingSans : game?.sans;
  if (!Array.isArray(ucis) || ucis.length === 0) return { ok: false, reason: "missing-ucis" };
  if (!Array.isArray(sans) || sans.length !== ucis.length) {
    return { ok: false, reason: "sans-ucis-length-mismatch" };
  }
  return { ok: true };
}

export function auditPlayerColorTimeline(games, subjectColor, { excludeCollapse = true } = {}) {
  const filtered = (games || [])
    .filter((g) => g?.color === subjectColor)
    .filter((g) => !(excludeCollapse && isEarlyResignCollapse(g)));
  const issues = [];
  const seenIds = new Set();
  for (const g of filtered) {
    const quality = validateGameRecordForPhase0(g);
    if (!quality.ok) {
      issues.push({ gameId: gameIdOf(g) || null, reason: quality.reason });
    }
    const id = gameIdOf(g);
    if (!id) continue;
    if (seenIds.has(id)) issues.push({ gameId: id, reason: "duplicate-game-id" });
    seenIds.add(id);
  }
  return { ok: issues.length === 0, issues, games: filtered };
}

export function normalizeColorGames(games, subjectColor, { excludeCollapse = true } = {}) {
  return (games || [])
    .filter((g) => g?.color === subjectColor)
    .filter((g) => !(excludeCollapse && isEarlyResignCollapse(g)))
    .filter((g) => Array.isArray(g?.ucis) && g.ucis.length > 0)
    .map((g) => ({
      ...g,
      gameId: gameIdOf(g),
      datestamp: gameDatestamp(g),
    }));
}

export function sortGamesChronologically(games) {
  return [...games].sort((a, b) => {
    const ds = (a.datestamp || 0) - (b.datestamp || 0);
    if (ds !== 0) return ds;
    return gameIdOf(a).localeCompare(gameIdOf(b));
  });
}

export function buildEligibleCutoffs(gameCount, protocol = null) {
  const w = protocol?.decisionUnits?.windows || {};
  const minTrain = w.minTrainGames ?? LOCKED.windows.minTrainGames;
  const future = w.futureWindowGames ?? LOCKED.windows.futureWindowGames;
  const stride = w.strideGames ?? LOCKED.windows.strideGames;
  const maxCutoffs = w.maxCutoffsPerPlayerColor ?? LOCKED.windows.maxCutoffsPerPlayerColor;
  const eligible = [];
  for (let cutoff = minTrain; cutoff + future <= gameCount; cutoff += stride) {
    eligible.push(cutoff);
  }
  return eligible.slice(-maxCutoffs);
}

export function splitTrainFuture(sortedGames, cutoff, protocol = null) {
  const futureN = protocol?.decisionUnits?.windows?.futureWindowGames
    ?? LOCKED.windows.futureWindowGames;
  const train = sortedGames.slice(0, cutoff);
  const future = sortedGames.slice(cutoff, cutoff + futureN);
  return { train, future, cutoff, futureGameCount: future.length };
}

function auditWindowGames(games) {
  const issues = [];
  for (const g of games || []) {
    const quality = validateGameRecordForPhase0(g);
    if (!quality.ok) issues.push({ gameId: gameIdOf(g) || null, reason: quality.reason });
  }
  return issues;
}

function validateWindowChronology(train, future) {
  if (!train?.length || !future?.length) {
    return { ok: false, reason: "empty-train-or-future-window" };
  }
  const lastTrain = train[train.length - 1];
  const firstFuture = future[0];
  const lastStamp = gameDatestamp(lastTrain);
  const firstStamp = gameDatestamp(firstFuture);
  const lastId = gameIdOf(lastTrain);
  const firstId = gameIdOf(firstFuture);
  if (lastStamp > firstStamp || (lastStamp === firstStamp && lastId.localeCompare(firstId) >= 0)) {
    return { ok: false, reason: "train-future-chronology-violation" };
  }
  return { ok: true };
}

export function buildDecisionWindowsForPlayerColor(games, subjectColor, protocol = null) {
  const timeline = auditPlayerColorTimeline(games, subjectColor);
  const filtered = sortGamesChronologically(normalizeColorGames(games, subjectColor));
  const cutoffs = buildEligibleCutoffs(filtered.length, protocol);
  const futureN = protocol?.decisionUnits?.windows?.futureWindowGames
    ?? LOCKED.windows.futureWindowGames;
  return cutoffs.map((cutoff) => {
    const { train, future } = splitTrainFuture(filtered, cutoff, protocol);
    const trainIds = new Set(train.map((g) => gameIdOf(g)));
    const futureIds = new Set(future.map((g) => gameIdOf(g)));
    const overlap = [...trainIds].filter((id) => futureIds.has(id));
    const windowQualityIssues = [
      ...(timeline.ok ? [] : timeline.issues),
      ...auditWindowGames(train),
      ...auditWindowGames(future),
    ];
    const chronology = validateWindowChronology(train, future);
    if (!chronology.ok) windowQualityIssues.push({ gameId: null, reason: chronology.reason });
    const dataQualityOk = windowQualityIssues.length === 0;
    return {
      subjectColor,
      cutoff,
      trainGames: train,
      futureGames: future,
      trainGameCount: train.length,
      futureGameCount: future.length,
      trainGameIds: [...trainIds],
      futureGameIds: [...futureIds],
      trainFutureOverlap: overlap,
      leakageFree: overlap.length === 0 && future.length === futureN,
      dataQualityOk,
      dataQualityIssues: windowQualityIssues,
    };
  });
}

// ── Prefix utilities ───────────────────────────────────────────────────────

export function prefixKey(ucis) {
  return triePathKey(ucis || [], 64);
}

export function hasExactPrefix(game, prefixUcis) {
  const ucis = game?.ucis;
  if (!Array.isArray(ucis) || !Array.isArray(prefixUcis)) return false;
  if (prefixUcis.length > ucis.length) return false;
  for (let i = 0; i < prefixUcis.length; i += 1) {
    if (ucis[i] !== prefixUcis[i]) return false;
  }
  return true;
}

export function computePrefixSupport(trainGames, prefixUcis) {
  const supporting = (trainGames || []).filter((g) => hasExactPrefix(g, prefixUcis));
  const gameIds = [...new Set(supporting.map((g) => gameIdOf(g)).filter(Boolean))];
  const dayKeys = [...new Set(supporting.map((g) => utcDayKey(g)).filter(Boolean))];
  const qualityIssues = supporting
    .map((g) => ({ gameId: gameIdOf(g), quality: validateGameRecordForPhase0(g) }))
    .filter((row) => !row.quality.ok);
  return {
    distinctGames: gameIds.length,
    distinctDates: dayKeys.length,
    gameIds,
    dayKeys,
    dataQualityOk: qualityIssues.length === 0,
    dataQualityIssues: qualityIssues.map((row) => ({
      gameId: row.gameId || null,
      reason: row.quality.reason,
    })),
  };
}

export function computeFuturePrefixReentry(futureGames, prefixUcis) {
  if (!prefixUcis?.length) {
    return {
      futurePrefixEntryCount: 0,
      futurePrefixEntryRate: 0,
      futurePrefixEntryBinary: 0,
    };
  }
  const n = futureGames?.length || 0;
  const count = (futureGames || []).filter((g) => hasExactPrefix(g, prefixUcis)).length;
  return {
    futurePrefixEntryCount: count,
    futurePrefixEntryRate: n > 0 ? count / n : 0,
    futurePrefixEntryBinary: count > 0 ? 1 : 0,
  };
}

export function isLegalParsablePrefix(ucis) {
  if (!ucis?.length) return false;
  try {
    const chess = new Chess();
    for (const uci of ucis) {
      const move = chess.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci[4] || undefined,
      });
      if (!move) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function depthBinForLength(plies) {
  const n = Number(plies);
  for (const bin of RY_DEPTH_BINS) {
    if (n >= bin.min && n <= bin.max) return bin.name;
  }
  return null;
}

// ── v2 train-only X (scout-report.js no-enrichment surface) ────────────────

function trieBaselineScorePct(trie) {
  return trie?.count ? Math.round((trie.score / trie.count) * 100) : 0;
}

/** Golden reference: mirrors scout-report.js weakness target path without Maia/prefilter/engine. */
export function selectV2ScoutReportNoEnrichmentTop1(trainGames, subjectColor, {
  speedFilter = "all",
  profile = null,
} = {}) {
  const filtered = normalizeColorGames(trainGames, subjectColor);
  if (!filtered.length) return { abstentionReason: "no-train-games", ucis: null, line: null, lengthPlies: null };

  const trie = buildOpeningTrie(filtered, subjectColor, { speedFilter });
  if (!trie?.gameCount) return { abstentionReason: "empty-trie", ucis: null, line: null, lengthPlies: null };

  const baseline = profile?.colorStats?.[subjectColor]?.scorePct ?? trieBaselineScorePct(trie);
  const { branches, ancestorFreq } = rankedOpeningBranches(filtered, subjectColor, {
    speedFilter,
    limit: SCOUT_BRANCH_SCORE_CAP,
  });
  if (!branches.length) {
    return { abstentionReason: "no-opening-branches", ucis: null, line: null, lengthPlies: null };
  }

  const ranked = rankGamePlan(branches, baseline, {
    oppColor: subjectColor,
    games: filtered,
    speedFilter,
    lineLastSeen,
    ancestorFreq,
    limit: 1,
  });
  if (!ranked.length) {
    return { abstentionReason: "rank-game-plan-empty", ucis: null, line: null, lengthPlies: null };
  }

  const top = ranked[0];
  const ucis = top.ucis;
  const lengthPlies = ucis?.length ?? null;
  return {
    abstentionReason: null,
    ucis,
    line: top.line || (ucis ? branchPathKey(ucis) : null),
    lengthPlies,
    baselineScorePct: baseline,
    branchGames: top.games ?? null,
    branchShare: top.share ?? null,
    lastSeen: top.lastSeen ?? null,
  };
}

export function selectV2TrainOnlyX(trainGames, subjectColor) {
  const golden = selectV2ScoutReportNoEnrichmentTop1(trainGames, subjectColor, { speedFilter: "all" });
  if (golden.abstentionReason) {
    return {
      source: RY_V2_X_SOURCE,
      ucis: null,
      line: null,
      lengthPlies: null,
      abstentionReason: golden.abstentionReason,
    };
  }

  const ucis = golden.ucis;
  const lengthPlies = golden.lengthPlies;
  if (!isLegalParsablePrefix(ucis)) {
    return {
      source: RY_V2_X_SOURCE,
      ucis,
      line: golden.line,
      lengthPlies,
      abstentionReason: "illegal-or-unparsable-prefix",
    };
  }
  if (!terminalMoveIsOpponent(ucis, subjectColor)) {
    return {
      source: RY_V2_X_SOURCE,
      ucis,
      line: golden.line,
      lengthPlies,
      abstentionReason: "does-not-end-on-opponent-move",
    };
  }

  return {
    source: RY_V2_X_SOURCE,
    ucis,
    line: golden.line,
    lengthPlies,
    abstentionReason: null,
    baselineScorePct: golden.baselineScorePct,
    branchGames: golden.branchGames,
    branchShare: golden.branchShare,
    lastSeen: golden.lastSeen,
  };
}

// ── Grounded X inventory ───────────────────────────────────────────────────

function ourTurnPrefixesAlongNewestGame(newestGame, subjectColor, protocol = null) {
  const grounded = protocol?.xSelection?.groundedInventory || {};
  const maxPlies = grounded.maxPlies ?? LOCKED.grounded.maxPlies;
  const maxOurPoints = grounded.maxOurDecisionPoints ?? LOCKED.grounded.maxOurDecisionPoints;
  const ucis = newestGame?.ucis || [];
  const prefixes = [];
  let ourPoints = 0;
  for (let len = 1; len <= Math.min(ucis.length, maxPlies); len += 1) {
    const prefix = ucis.slice(0, len);
    if (!terminalMoveIsOpponent(prefix, subjectColor)) continue;
    ourPoints += 1;
    prefixes.push(prefix);
    if (ourPoints >= maxOurPoints) break;
  }
  return prefixes;
}

export function inventoryGroundedX(trainGames, subjectColor, protocol = null) {
  const filtered = sortGamesChronologically(normalizeColorGames(trainGames, subjectColor));
  if (!filtered.length) {
    return {
      arm: "grounded-x-robust-y",
      ucis: null,
      line: null,
      lengthPlies: null,
      distinctGames: 0,
      distinctDates: 0,
      repeatSupported: false,
      phase0S1Eligible: false,
      singletonDiagnostic: false,
      abstentionReason: "no-train-games",
      newestTrainGameId: null,
    };
  }

  const newest = filtered[filtered.length - 1];
  const candidatePrefixes = ourTurnPrefixesAlongNewestGame(newest, subjectColor, protocol);
  const minGames = protocol?.xSelection?.groundedInventory?.productClaimMinDistinctGames
    ?? LOCKED.grounded.minDistinctGames;
  const minDates = protocol?.xSelection?.groundedInventory?.productClaimMinDistinctDates
    ?? LOCKED.grounded.minDistinctDates;

  let best = null;
  let bestSupport = null;
  const diagnostics = [];

  for (const prefix of candidatePrefixes) {
    const support = computePrefixSupport(filtered, prefix);
    const row = {
      ucis: prefix,
      line: branchPathKey(prefix),
      lengthPlies: prefix.length,
      distinctGames: support.distinctGames,
      distinctDates: support.distinctDates,
      qualifies: support.distinctGames >= minGames && support.distinctDates >= minDates,
    };
    diagnostics.push(row);
    if (!support.dataQualityOk) {
      diagnostics.push({ ...row, qualifies: false, dataQualityOk: false });
      continue;
    }
    if (!row.qualifies) continue;
    if (!best || prefix.length > best.length
      || (prefix.length === best.length && branchPathKey(prefix).localeCompare(branchPathKey(best)) < 0)) {
      best = prefix;
      bestSupport = support;
    }
  }

  if (!best) {
    const deepest = candidatePrefixes[candidatePrefixes.length - 1] || null;
    const deepestSupport = deepest ? computePrefixSupport(filtered, deepest) : { distinctGames: 0, distinctDates: 0 };
    const singleton = deepestSupport.distinctGames === 1;
    return {
      arm: "grounded-x-robust-y",
      ucis: deepest,
      line: deepest ? branchPathKey(deepest) : null,
      lengthPlies: deepest?.length ?? null,
      distinctGames: deepestSupport.distinctGames,
      distinctDates: deepestSupport.distinctDates,
      repeatSupported: false,
      phase0S1Eligible: false,
      singletonDiagnostic: singleton,
      abstentionReason: deepest ? "insufficient-repeat-support" : "no-our-turn-prefixes",
      newestTrainGameId: gameIdOf(newest),
      candidateDiagnostics: diagnostics,
    };
  }

  return {
    arm: "grounded-x-robust-y",
    ucis: best,
    line: branchPathKey(best),
    lengthPlies: best.length,
    distinctGames: bestSupport.distinctGames,
    distinctDates: bestSupport.distinctDates,
    repeatSupported: true,
    phase0S1Eligible: true,
    singletonDiagnostic: false,
    abstentionReason: null,
    newestTrainGameId: gameIdOf(newest),
    candidateDiagnostics: diagnostics,
  };
}

// ── Unit evaluation ────────────────────────────────────────────────────────

export function evaluatePhase0Unit({
  playerId,
  subjectColor,
  window,
  protocol = null,
}) {
  const {
    trainGames,
    futureGames,
    cutoff,
    trainFutureOverlap,
    leakageFree,
    dataQualityOk = true,
    dataQualityIssues = [],
  } = window;
  const v2 = selectV2TrainOnlyX(trainGames, subjectColor);
  const grounded = inventoryGroundedX(trainGames, subjectColor, protocol);

  const v2Min = protocol?.xSelection?.v2Pipeline?.usableLengthPlies?.[0]
    ?? LOCKED.v2Pipeline.usableLengthPlies[0];
  const v2Max = protocol?.xSelection?.v2Pipeline?.usableLengthPlies?.[1]
    ?? LOCKED.v2Pipeline.usableLengthPlies[1];

  const v2Support = v2.ucis ? computePrefixSupport(trainGames, v2.ucis) : {
    distinctGames: 0,
    distinctDates: 0,
    gameIds: [],
    dataQualityOk: true,
    dataQualityIssues: [],
  };
  const v2Future = v2.ucis
    ? computeFuturePrefixReentry(futureGames, v2.ucis)
    : {
      futurePrefixEntryCount: 0,
      futurePrefixEntryRate: 0,
      futurePrefixEntryBinary: 0,
    };

  const groundedFuture = grounded.ucis
    ? computeFuturePrefixReentry(futureGames, grounded.ucis)
    : {
      futurePrefixEntryCount: 0,
      futurePrefixEntryRate: 0,
      futurePrefixEntryBinary: 0,
    };

  const supportDataQualityOk = v2Support.dataQualityOk !== false;
  const unitDataQualityOk = Boolean(dataQualityOk && supportDataQualityOk);

  const v2XUsable = Boolean(
    unitDataQualityOk
    && v2.ucis
    && v2.abstentionReason == null
    && isLegalParsablePrefix(v2.ucis)
    && terminalMoveIsOpponent(v2.ucis, subjectColor)
    && v2.lengthPlies >= v2Min
    && v2.lengthPlies <= v2Max
    && (futureGames?.length || 0) > 0
    && leakageFree,
  );

  const repeatSupportedV2X = Boolean(
    v2XUsable
    && v2Support.distinctGames >= 2
    && v2Support.distinctDates >= 2,
  );

  const groundedFutureSupport = grounded.ucis
    ? computePrefixSupport(trainGames, grounded.ucis)
    : { distinctGames: 0, distinctDates: 0 };

  const v2GroundedAgreement = Boolean(
    v2.ucis && grounded.ucis && prefixKey(v2.ucis) === prefixKey(grounded.ucis),
  );

  return {
    unitId: `${playerId}|${subjectColor}|${cutoff}`,
    playerId,
    subjectColor,
    cutoff,
    trainGameCount: trainGames.length,
    futureGameCount: futureGames.length,
    leakageFree,
    dataQualityOk: unitDataQualityOk,
    dataQualityIssues: [
      ...(dataQualityIssues || []),
      ...(v2Support.dataQualityIssues || []),
    ],
    trainFutureOverlapCount: trainFutureOverlap?.length ?? 0,
    v2X: {
      source: v2.source,
      ucis: v2.ucis,
      line: v2.line,
      lengthPlies: v2.lengthPlies,
      depthBin: v2.lengthPlies != null ? depthBinForLength(v2.lengthPlies) : null,
      abstentionReason: v2.abstentionReason,
      trainPrefixSupport: v2Support.distinctGames,
      trainDistinctDates: v2Support.distinctDates,
      ...v2Future,
      v2XUsable,
      repeatSupportedV2X,
    },
    groundedX: {
      ...grounded,
      depthBin: grounded.lengthPlies != null ? depthBinForLength(grounded.lengthPlies) : null,
      trainPrefixSupport: groundedFutureSupport.distinctGames,
      trainDistinctDates: groundedFutureSupport.distinctDates,
      ...groundedFuture,
    },
    v2GroundedAgreement,
    futureP1Note: "robust-Y vs v2-Y distinctness required in Phase1a; not assessed in Phase0",
  };
}

export function canonicalizePhase0Units(units) {
  return [...(units || [])].sort((a, b) => {
    const p = String(a.playerId).localeCompare(String(b.playerId));
    if (p !== 0) return p;
    if (a.subjectColor === "white" && b.subjectColor === "black") return -1;
    if (a.subjectColor === "black" && b.subjectColor === "white") return 1;
    return (a.cutoff || 0) - (b.cutoff || 0);
  });
}

function depthBinRecurrenceSlice(usableUnits) {
  const out = {};
  for (const bin of RY_DEPTH_BINS) {
    out[bin.name] = {
      unitCount: 0,
      futureEntryBinaryRate: null,
      meanFuturePrefixEntryCount: null,
      meanFuturePrefixEntryRate: null,
    };
  }
  for (const u of usableUnits) {
    const b = u.v2X?.depthBin;
    if (!b || !out[b]) continue;
    out[b].unitCount += 1;
  }
  for (const bin of RY_DEPTH_BINS) {
    const rows = usableUnits.filter((u) => u.v2X?.depthBin === bin.name);
    if (!rows.length) continue;
    const binaries = rows.map((u) => u.v2X?.futurePrefixEntryBinary ?? 0);
    const counts = rows.map((u) => u.v2X?.futurePrefixEntryCount ?? 0);
    const rates = rows.map((u) => u.v2X?.futurePrefixEntryRate ?? 0);
    out[bin.name].futureEntryBinaryRate = rate(rows, (u) => u.v2X?.futurePrefixEntryBinary);
    out[bin.name].meanFuturePrefixEntryCount = counts.reduce((s, v) => s + v, 0) / counts.length;
    out[bin.name].meanFuturePrefixEntryRate = rates.reduce((s, v) => s + v, 0) / rates.length;
    out[bin.name].allZeroFutureEntryBinary = binaries.every((v) => v === 0);
    out[bin.name].allOneFutureEntryBinary = binaries.every((v) => v === 1);
  }
  return out;
}

function aggregatePhase0Panel(units, protocol = null) {
  const gates = protocol?.phase0Gates || LOCKED.gates;
  const dataQualityFailures = units.filter((u) => u.dataQualityOk === false);
  const usable = units.filter((u) => u.v2X?.v2XUsable);
  const repeatSupported = units.filter((u) => u.v2X?.repeatSupportedV2X);
  const playersUsable = new Set(usable.map((u) => u.playerId));
  const playersRepeat = new Set(repeatSupported.map((u) => u.playerId));

  const futureCounts = units.map((u) => u.futureGameCount).filter(Number.isFinite);
  const medianFutureGames = futureCounts.length ? median(futureCounts) : 0;

  const entryBinaries = usable.map((u) => u.v2X?.futurePrefixEntryBinary ?? 0);
  const entryCounts = usable.map((u) => u.v2X?.futurePrefixEntryCount ?? 0);
  const entryRates = usable.map((u) => u.v2X?.futurePrefixEntryRate ?? 0);
  const entryRate = entryBinaries.length
    ? entryBinaries.reduce((s, v) => s + v, 0) / entryBinaries.length
    : null;
  const meanFuturePrefixEntryCount = entryCounts.length
    ? entryCounts.reduce((s, v) => s + v, 0) / entryCounts.length
    : null;
  const meanFuturePrefixEntryRate = entryRates.length
    ? entryRates.reduce((s, v) => s + v, 0) / entryRates.length
    : null;

  const leakageViolations = units.filter((u) => !u.leakageFree || (u.trainFutureOverlapCount || 0) > 0);

  const byColor = { white: colorSlice(units, "white"), black: colorSlice(units, "black") };
  const byDepthBin = depthBinSlice(usable);
  const byDepthBinRecurrence = depthBinRecurrenceSlice(usable);
  const agreement = {
    agreeCount: units.filter((u) => u.v2GroundedAgreement).length,
    usableAgreeCount: usable.filter((u) => u.v2GroundedAgreement).length,
    singletonGroundedCount: units.filter((u) => u.groundedX?.singletonDiagnostic).length,
    repeatSupportedGroundedCount: units.filter((u) => u.groundedX?.phase0S1Eligible).length,
  };
  const abstentionReasons = tallyField(units, (u) => u.v2X?.abstentionReason);

  const gateResults = {
    noDataQualityFailures: dataQualityFailures.length === 0,
    minTotalUsableUnits: usable.length >= gates.minTotalUsableUnits,
    minPlayersWithUsableUnit: playersUsable.size >= gates.minPlayersWithUsableUnit,
    minRepeatSupportedUnits: repeatSupported.length >= gates.minRepeatSupportedUnits,
    minPlayersWithRepeatSupportedUnit: playersRepeat.size >= gates.minPlayersWithRepeatSupportedUnit,
    v2FutureEntryBinaryRateInBand: entryRate != null
      && entryRate >= gates.v2FutureEntryBinaryRateMin
      && entryRate <= gates.v2FutureEntryBinaryRateMax,
    medianFutureGamesExact: medianFutureGames === gates.medianFutureGamesExact,
    noTrainFutureLeakage: leakageViolations.length === 0,
  };

  const inventoryGatesPass = Object.values(gateResults).every(Boolean);
  let verdict = inventoryGatesPass
    ? RY_VERDICTS.PHASE0_RUNNABLE
    : RY_VERDICTS.PHASE0_INSUFFICIENT_INVENTORY;
  if (dataQualityFailures.length > 0) verdict = RY_VERDICTS.INVALID;

  return {
    unitCount: units.length,
    usableUnitCount: usable.length,
    repeatSupportedUnitCount: repeatSupported.length,
    playersWithUsableUnit: playersUsable.size,
    playersWithRepeatSupportedUnit: playersRepeat.size,
    v2FutureEntryBinaryRate: entryRate,
    meanFuturePrefixEntryCount,
    meanFuturePrefixEntryRate,
    allZeroFutureEntryBinary: entryBinaries.length > 0 && entryBinaries.every((v) => v === 0),
    allOneFutureEntryBinary: entryBinaries.length > 0 && entryBinaries.every((v) => v === 1),
    medianFutureGames,
    dataQualityFailureCount: dataQualityFailures.length,
    leakageViolationCount: leakageViolations.length,
    correlatedCutoffsPerPlayerColor: LOCKED.windows.maxCutoffsPerPlayerColor,
    cutoffCorrelationNote: protocol?.futureP1?.cutoffCorrelationNote
      || LOCKED.futureP1.bootstrapNote,
    futureRecurrenceBandNote: protocol?.futureP1?.conditionalExploratoryNote
      || "Visible-data exploratory feasibility gate only; cannot estimate unconditional/generalizable P1 effect.",
    byColor,
    byDepthBin,
    byDepthBinRecurrence,
    agreement,
    abstentionReasons,
    gateResults,
    verdict,
  };
}

function colorSlice(units, color) {
  const rows = units.filter((u) => u.subjectColor === color);
  return {
    unitCount: rows.length,
    usableUnitCount: rows.filter((u) => u.v2X?.v2XUsable).length,
    repeatSupportedUnitCount: rows.filter((u) => u.v2X?.repeatSupportedV2X).length,
    futureEntryBinaryRate: rate(rows.filter((u) => u.v2X?.v2XUsable), (u) => u.v2X?.futurePrefixEntryBinary),
  };
}

function depthBinSlice(usableUnits) {
  const out = {};
  for (const bin of RY_DEPTH_BINS) out[bin.name] = 0;
  for (const u of usableUnits) {
    const b = u.v2X?.depthBin;
    if (b && out[b] != null) out[b] += 1;
  }
  return out;
}

function tallyField(rows, pick) {
  const counts = {};
  for (const row of rows) {
    const key = pick(row);
    const label = key == null ? "null" : String(key);
    counts[label] = (counts[label] || 0) + 1;
  }
  return counts;
}

function rate(rows, pick) {
  if (!rows.length) return null;
  const sum = rows.reduce((s, r) => s + (pick(r) ? 1 : 0), 0);
  return sum / rows.length;
}

function median(values) {
  const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ── Manifest / report ──────────────────────────────────────────────────────

/** Deterministic pretty-printed manifest bytes for lifecycle manifestSha256 pins. */
export function manifestBytesForHash(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function computeManifestSha256(manifest) {
  return sha256Buffer(Buffer.from(manifestBytesForHash(manifest), "utf8"));
}

export function canonicalJsonForHash(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJsonForHash(item)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJsonForHash(value[k])}`).join(",")}}`;
}

export function computeUnitContentHash(unit) {
  return sha256Hex(`${canonicalJsonForHash(unit)}\n`);
}

export function buildRobustYManifest({
  protocolId = RY_PROTOCOL_ID,
  protocolSha256 = null,
  players = [],
  createdAt = null,
  protocol = null,
  cohortRoot = null,
  enforcePlayerCount = false,
} = {}) {
  const playerRows = players.map((p) => ({
    playerId: p.playerId,
    gamesPath: p.gamesPath,
    gamesSha256: p.gamesSha256,
    dumpPath: p.dumpPath,
    dumpSha256: p.dumpSha256,
    gameCount: p.gameCount,
  }));
  const expectedCount = protocol?.inputs?.expectedPlayerCount ?? LOCKED.expectedPlayerCount;
  if (enforcePlayerCount && playerRows.length !== expectedCount) {
    throw new Error(
      `manifest playerCount ${playerRows.length} !== protocol.inputs.expectedPlayerCount ${expectedCount}`,
    );
  }
  const normalizedCohortRoot = cohortRoot || protocol?.inputs?.cohortRoot || LOCKED.cohortRoot;
  return {
    kind: RY_MANIFEST_KIND,
    version: 1,
    protocolId,
    protocolSha256,
    cohortRoot: normalizedCohortRoot,
    immutable: true,
    createdAt: createdAt || new Date().toISOString(),
    playerCount: playerRows.length,
    playersSha256: computePlayersSha256(playerRows),
    players: playerRows,
    phase0UsesGameJsonOnly: true,
  };
}

function stripReportForScientificHash(report) {
  const clone = JSON.parse(JSON.stringify(report || {}));
  delete clone.reportSha256;
  delete clone.createdAt;
  return clone;
}

export function computeScientificPayloadSha256(report) {
  return sha256Hex(`${JSON.stringify(stripReportForScientificHash(report), null, 2)}\n`);
}

export function computeRobustYReportSha256(report) {
  const body = { ...(report || {}) };
  delete body.reportSha256;
  return sha256Hex(`${JSON.stringify(body, null, 2)}\n`);
}

export function runPhase0Inventory({
  protocol,
  protocolSha256 = null,
  manifest = null,
  manifestSha256 = null,
  playerGames = [],
}) {
  const validation = validateRobustYProtocol(protocol);
  if (!validation.ok) {
    return {
      verdict: RY_VERDICTS.INVALID,
      invalidReason: validation.errors.join("; "),
      productAuthorization: false,
      cannotAuthorizeCards: true,
      cannotAuthorizeHumanStudy: true,
      productVerdict: PRODUCT_VERDICT,
      preserveV2Regardless: true,
      noFutureMoveProof: true,
      units: [],
      panel: null,
    };
  }

  const units = [];
  const gamesByPlayer = new Map((playerGames || []).map((row) => [row.playerId, row.games]));
  const playerIds = orderedPlayerIds([...gamesByPlayer.keys()]);

  for (const playerId of playerIds) {
    const games = gamesByPlayer.get(playerId) || [];
    for (const subjectColor of ["white", "black"]) {
      const windows = buildDecisionWindowsForPlayerColor(games, subjectColor, protocol);
      for (const window of windows) {
        units.push(evaluatePhase0Unit({
          playerId,
          subjectColor,
          window,
          protocol,
        }));
      }
    }
  }

  const canonicalUnits = canonicalizePhase0Units(units);
  const panel = aggregatePhase0Panel(canonicalUnits, protocol);

  const report = {
    kind: RY_REPORT_KIND,
    version: RY_REPORT_VERSION,
    protocolId: RY_PROTOCOL_ID,
    protocolSha256: protocolSha256 || null,
    manifestSha256: manifestSha256 ?? (manifest ? computeManifestSha256(manifest) : null),
    phase: "phase0-zero-engine-inventory",
    role: protocol.role,
    productAuthorization: false,
    cannotAuthorizeCards: true,
    cannotAuthorizeHumanStudy: true,
    productVerdict: PRODUCT_VERDICT,
    preserveV2Regardless: true,
    noFutureMoveProof: true,
    cannotAuthorizeEnginePhase: true,
    verdict: panel.verdict,
    panel,
    units: canonicalUnits,
    futureP1DocumentedOnly: true,
    futureP1ConditionalExploratoryOnly: true,
    futureP1: protocol.futureP1 || null,
    cohortRoot: protocol?.inputs?.cohortRoot || LOCKED.cohortRoot,
  };

  report.reportSha256 = computeRobustYReportSha256(report);
  return report;
}

export function buildRobustYSummary(report) {
  const p = report?.panel || {};
  const g = p.gateResults || {};
  const lines = [
    "# Robust-Y Phase-0 inventory",
    "",
    `Verdict: **${report?.verdict || "n/a"}**`,
    "",
    "## Claim boundary",
    "- Exploratory zero-network analysis lock only.",
    "- Cannot authorize product, cards, human study, or engine phase.",
    "- Factual prefix re-entry is diagnostic, not next-move prediction.",
    "- Future recurrence band [0.10, 0.90] is a visible-data exploratory feasibility gate for conditional P1 only.",
    "- P1 cannot estimate an unconditional/generalizable effect or confirm anything; it does not tune Y.",
    "",
    "## Panel",
    `- Units: ${p.unitCount ?? 0}`,
    `- Usable v2-X units: ${p.usableUnitCount ?? 0}`,
    `- Repeat-supported v2-X units: ${p.repeatSupportedUnitCount ?? 0}`,
    `- Players with usable unit: ${p.playersWithUsableUnit ?? 0}`,
    `- Players with repeat-supported unit: ${p.playersWithRepeatSupportedUnit ?? 0}`,
    `- v2 future-entry binary rate (usable): ${fmtRate(p.v2FutureEntryBinaryRate)}`,
    `- Mean future prefix entry count (usable): ${fmtRate(p.meanFuturePrefixEntryCount)}`,
    `- Mean future prefix entry rate (usable): ${fmtRate(p.meanFuturePrefixEntryRate)}`,
    `- Median future games: ${p.medianFutureGames ?? "n/a"}`,
    `- Data-quality failures: ${p.dataQualityFailureCount ?? 0}`,
    "",
    "## Cutoff correlation (honest)",
    `- Up to ${p.correlatedCutoffsPerPlayerColor ?? 4} nested-train cutoffs per player-color are correlated.`,
    `- ${p.cutoffCorrelationNote || LOCKED.futureP1.bootstrapNote}`,
    "",
    "## Gates",
    ...Object.entries(g).map(([k, v]) => `- ${k}: ${v ? "pass" : "fail"}`),
    "",
    "## Future P1 (documented only; conditional exploratory)",
    "- Hold v2 X fixed; compare same-v2-x-robust-y vs same-v2-x-v2-y.",
    "- d8 selection, d18 audit; W = futurePrefixEntryBinary * V; player-cluster bootstrap required.",
    "",
    `Product verdict: ${report?.productVerdict || PRODUCT_VERDICT} (authorization false).`,
  ];
  return `${lines.join("\n")}\n`;
}

function fmtRate(v) {
  return v == null || !Number.isFinite(v) ? "n/a" : Number(v).toFixed(4);
}

export function checkRobustYArtifactPresence({
  state,
  hasProtocolSnapshot = false,
  hasManifest = false,
  hasReport = false,
  hasSummary = false,
  hasPhase0Started = false,
  unitArtifacts = null,
  expectedUnitCount = null,
} = {}) {
  const issues = [];
  if (state === RY_STATES.FROZEN
    || state === RY_STATES.PHASE0_COMPLETE
    || state === RY_STATES.VERIFIED) {
    if (!hasProtocolSnapshot) issues.push({ kind: "missing-protocol-snapshot" });
    if (!hasManifest) issues.push({ kind: "missing-manifest" });
  }
  if (state === RY_STATES.PHASE0_COMPLETE || state === RY_STATES.VERIFIED) {
    if (!hasPhase0Started) issues.push({ kind: "missing-phase0-started-marker" });
    if (!hasReport) issues.push({ kind: "missing-report" });
    if (!hasSummary) issues.push({ kind: "missing-summary" });
    if (expectedUnitCount != null && Array.isArray(unitArtifacts)) {
      if (unitArtifacts.length !== expectedUnitCount) {
        issues.push({
          kind: "per-unit-artifact-count-mismatch",
          actual: unitArtifacts.length,
          expected: expectedUnitCount,
        });
      }
    }
  }
  return { ok: issues.length === 0, issues };
}

function validateRyEventSequence(events, state) {
  const issues = [];
  const freezeEvents = (events || []).filter((e) => e.type === "freeze");
  const phase0Events = (events || []).filter((e) => e.type === "phase0");
  const verifyEvents = (events || []).filter((e) => e.type === "verify");

  if (freezeEvents.length !== 1) {
    issues.push({ kind: "freeze-count-not-one", count: freezeEvents.length });
  }
  if (state === RY_STATES.PHASE0_COMPLETE && phase0Events.length !== 1) {
    issues.push({ kind: "phase0-count-not-one", count: phase0Events.length });
  }
  if (state === RY_STATES.VERIFIED) {
    if (phase0Events.length !== 1) issues.push({ kind: "phase0-count-not-one", count: phase0Events.length });
    if (verifyEvents.length !== 1) issues.push({ kind: "verify-count-not-one", count: verifyEvents.length });
  }
  if (phase0Events.length > 1) issues.push({ kind: "duplicate-phase0", count: phase0Events.length });
  if (verifyEvents.length > 1) issues.push({ kind: "duplicate-verify", count: verifyEvents.length });

  const seqs = (events || []).map((e) => e.seq).filter((s) => Number.isFinite(s));
  for (let i = 1; i < seqs.length; i += 1) {
    if (seqs[i] <= seqs[i - 1]) issues.push({ kind: "event-seq-not-increasing", index: i });
  }
  if (new Set(seqs).size !== seqs.length) issues.push({ kind: "event-seq-not-unique" });

  const freezeEvent = freezeEvents[0];
  const phase0Event = phase0Events[0];
  const verifyEvent = verifyEvents[0];
  if (phase0Event && freezeEvent && phase0Event.seq <= freezeEvent.seq) {
    issues.push({ kind: "phase0-not-after-freeze" });
  }
  if (verifyEvent && phase0Event && verifyEvent.seq <= phase0Event.seq) {
    issues.push({ kind: "verify-not-after-phase0" });
  }
  if (phase0Event?.productAuthorization !== false && phase0Event) {
    issues.push({ kind: "phase0-event-product-authorization-not-false" });
  }

  return { issues, freezeEvent, phase0Event, verifyEvent };
}

function pushManifestShaMismatch(issues, kind, expected, actual) {
  if (expected != null && actual != null && expected !== actual) {
    issues.push({ kind, expected, actual });
  } else if (expected != null && actual == null) {
    issues.push({ kind, expected, actual: null });
  }
}

export function verifyRobustYStudy({
  state,
  protocol,
  protocolSha256,
  snapshotProtocolSha256,
  manifest,
  rawManifestSha256 = null,
  phase0StartedRecord = null,
  report = null,
  events = [],
  unitArtifacts = null,
  stateRecord = null,
  artifactPresence = null,
  recomputedReport = null,
} = {}) {
  const issues = [];
  const lockedState = state === RY_STATES.FROZEN
    || state === RY_STATES.PHASE0_COMPLETE
    || state === RY_STATES.VERIFIED;
  const phase0State = state === RY_STATES.PHASE0_COMPLETE || state === RY_STATES.VERIFIED;

  const { issues: eventIssues, freezeEvent, phase0Event, verifyEvent } = validateRyEventSequence(events, state);
  issues.push(...eventIssues);

  if (lockedState) {
    if (snapshotProtocolSha256 == null || snapshotProtocolSha256 === "") {
      issues.push({ kind: "missing-protocol-snapshot-sha" });
    }
    if (stateRecord?.protocolSha256 && snapshotProtocolSha256
      && stateRecord.protocolSha256 !== snapshotProtocolSha256) {
      issues.push({ kind: "state-snapshot-protocol-sha-mismatch" });
    }
    if (freezeEvent?.protocolSha256 && snapshotProtocolSha256
      && freezeEvent.protocolSha256 !== snapshotProtocolSha256) {
      issues.push({ kind: "freeze-event-snapshot-protocol-sha-mismatch" });
    }
    if (protocolSha256 && stateRecord?.protocolSha256
      && stateRecord.protocolSha256 !== protocolSha256) {
      issues.push({ kind: "state-parsed-protocol-sha-mismatch" });
    }
    if (protocolSha256 && freezeEvent?.protocolSha256
      && freezeEvent.protocolSha256 !== protocolSha256) {
      issues.push({ kind: "freeze-event-parsed-protocol-sha-mismatch" });
    }
    if (!manifest) issues.push({ kind: "missing-manifest" });
    else if (manifest.immutable !== true) issues.push({ kind: "manifest-not-immutable" });
  }

  if (Array.isArray(artifactPresence) && artifactPresence.length) {
    for (const issue of artifactPresence) issues.push(issue);
  }

  const role = validateRobustYProtocol(protocol);
  if (!role.ok) issues.push(...role.errors.map((e) => ({ kind: "protocol-invalid", message: e })));

  if (manifest) {
    if (manifest.kind !== RY_MANIFEST_KIND) issues.push({ kind: "manifest-kind-mismatch" });
    if (manifest.protocolSha256 !== protocolSha256) {
      issues.push({ kind: "manifest-protocol-sha-mismatch" });
    }
    if (manifest.cohortRoot !== (protocol?.inputs?.cohortRoot || LOCKED.cohortRoot)) {
      issues.push({ kind: "manifest-cohort-root-mismatch" });
    }
    if (stateRecord?.cohortRoot && manifest.cohortRoot !== stateRecord.cohortRoot) {
      issues.push({ kind: "state-manifest-cohort-root-mismatch" });
    }
    const expectedPlayersSha = computePlayersSha256(manifest.players || []);
    if (manifest.playersSha256 !== expectedPlayersSha) {
      issues.push({ kind: "manifest-players-sha-mismatch" });
    }
    if (freezeEvent?.playersSha256 && manifest.playersSha256 !== freezeEvent.playersSha256) {
      issues.push({ kind: "freeze-event-players-sha-mismatch" });
    }
    if (stateRecord?.playersSha256 && manifest.playersSha256 !== stateRecord.playersSha256) {
      issues.push({ kind: "state-players-sha-mismatch" });
    }
    const prettyManifestSha = computeManifestSha256(manifest);
    if (rawManifestSha256 && rawManifestSha256 !== prettyManifestSha) {
      issues.push({
        kind: "raw-manifest-sha-mismatch-vs-pretty-object",
        expected: prettyManifestSha,
        actual: rawManifestSha256,
      });
    }
    const manifestPin = rawManifestSha256 || prettyManifestSha;
    pushManifestShaMismatch(issues, "state-manifest-sha-mismatch", manifestPin, stateRecord?.manifestSha256);
    pushManifestShaMismatch(issues, "freeze-event-manifest-sha-mismatch", manifestPin, freezeEvent?.manifestSha256);
    if (phase0State) {
      pushManifestShaMismatch(issues, "phase0-started-manifest-sha-mismatch", manifestPin, phase0StartedRecord?.manifestSha256);
      pushManifestShaMismatch(issues, "phase0-event-manifest-sha-mismatch", manifestPin, phase0Event?.manifestSha256);
    }
    const ordered = orderedPlayerIds((manifest.players || []).map((p) => p.playerId));
    if (!arraysEqual((manifest.players || []).map((p) => p.playerId), ordered)) {
      issues.push({ kind: "manifest-player-order-mismatch" });
    }
  }

  if (phase0State && !report) issues.push({ kind: "missing-report-in-phase0-state" });

  let recomputedVerdict = null;
  if (report) {
    if (report.productAuthorization !== false) {
      issues.push({ kind: "product-authorization-not-false" });
    }
    if (report.cannotAuthorizeCards !== true) {
      issues.push({ kind: "cannot-authorize-cards-not-true" });
    }
    if (report.cannotAuthorizeHumanStudy !== true) {
      issues.push({ kind: "cannot-authorize-human-study-not-true" });
    }
    if (report.preserveV2Regardless !== true) {
      issues.push({ kind: "preserve-v2-regardless-not-true" });
    }
    if (report.cannotAuthorizeEnginePhase !== true) {
      issues.push({ kind: "cannot-authorize-engine-phase-not-true" });
    }
    if (report.noFutureMoveProof !== true) {
      issues.push({ kind: "no-future-move-proof-not-true" });
    }
    if (report.productVerdict !== PRODUCT_VERDICT) {
      issues.push({ kind: "product-verdict-not-preserve-v2" });
    }
    if (report.protocolSha256 !== protocolSha256) {
      issues.push({ kind: "report-protocol-sha-mismatch" });
    }
    if (manifest) {
      const expectedManifestSha = rawManifestSha256 || computeManifestSha256(manifest);
      if (report.manifestSha256 !== expectedManifestSha) {
        issues.push({ kind: "report-manifest-sha-mismatch", expected: expectedManifestSha, actual: report.manifestSha256 });
      }
    }
    const expectedReportSha = computeRobustYReportSha256(report);
    if (!report.reportSha256) issues.push({ kind: "missing-report-sha256" });
    else if (report.reportSha256 !== expectedReportSha) {
      issues.push({ kind: "report-sha256-mismatch", expected: expectedReportSha, actual: report.reportSha256 });
    }
    if (stateRecord?.reportSha256 && report.reportSha256 !== stateRecord.reportSha256) {
      issues.push({ kind: "state-report-sha-mismatch" });
    }
    if (phase0Event?.reportSha256 && report.reportSha256 !== phase0Event.reportSha256) {
      issues.push({ kind: "phase0-event-report-sha-mismatch" });
    }
    if (phase0Event) {
      const expectedScientific = computeScientificPayloadSha256(report);
      if (phase0Event.scientificPayloadSha256 !== expectedScientific) {
        issues.push({ kind: "phase0-event-scientific-payload-sha-mismatch" });
      }
    }
    if (stateRecord?.scientificPayloadSha256) {
      const expectedScientific = computeScientificPayloadSha256(report);
      if (stateRecord.scientificPayloadSha256 !== expectedScientific) {
        issues.push({ kind: "state-scientific-payload-sha-mismatch" });
      }
    }
    if (stateRecord?.verdict && report.verdict !== stateRecord.verdict) {
      issues.push({ kind: "state-verdict-mismatch" });
    }
    recomputedVerdict = report.verdict;
  }

  if (recomputedReport && report) {
    const expectedScientific = computeScientificPayloadSha256(report);
    const actualScientific = computeScientificPayloadSha256(recomputedReport);
    if (expectedScientific !== actualScientific) {
      issues.push({
        kind: "scientific-payload-sha-mismatch",
        expected: expectedScientific,
        actual: actualScientific,
      });
    }
    if (recomputedReport.verdict !== report.verdict) {
      issues.push({ kind: "recomputed-verdict-mismatch", expected: report.verdict, actual: recomputedReport.verdict });
    }
    const manifestPin = rawManifestSha256
      || (manifest ? computeManifestSha256(manifest) : null)
      || report.manifestSha256;
    if (manifestPin && recomputedReport.manifestSha256 !== manifestPin) {
      issues.push({
        kind: "recomputed-manifest-sha-mismatch",
        expected: manifestPin,
        actual: recomputedReport.manifestSha256,
      });
    }
    recomputedVerdict = recomputedReport.verdict;
  }

  if (phase0State && report?.units?.length) {
    const reportUnits = report.units;
    const artifacts = unitArtifacts || [];
    if (artifacts.length !== reportUnits.length) {
      issues.push({
        kind: "per-unit-artifact-count-mismatch",
        actual: artifacts.length,
        expected: reportUnits.length,
      });
    }

    const reportById = new Map(reportUnits.map((u) => [u.unitId, u]));
    const artifactById = new Map();
    for (const artifact of artifacts) {
      if (artifactById.has(artifact.unitId)) {
        issues.push({ kind: "duplicate-unit-artifact", unitId: artifact.unitId });
      }
      artifactById.set(artifact.unitId, artifact);
    }

    for (const unit of reportUnits) {
      const artifact = artifactById.get(unit.unitId);
      if (!artifact) {
        issues.push({ kind: "missing-unit-artifact", unitId: unit.unitId });
        continue;
      }
      const ah = computeUnitContentHash(artifact);
      const rh = computeUnitContentHash(unit);
      if (ah !== rh) issues.push({ kind: "unit-artifact-report-hash-mismatch", unitId: unit.unitId });
      if (recomputedReport?.units) {
        const recomputedUnit = recomputedReport.units.find((u) => u.unitId === unit.unitId);
        if (!recomputedUnit) {
          issues.push({ kind: "recomputed-unit-missing", unitId: unit.unitId });
        } else {
          const recomputedHash = computeUnitContentHash(recomputedUnit);
          if (recomputedHash !== rh) {
            issues.push({ kind: "recomputed-unit-hash-mismatch", unitId: unit.unitId });
          }
        }
      }
    }
    for (const artifact of artifacts) {
      if (!reportById.has(artifact.unitId)) {
        issues.push({ kind: "unexpected-unit-artifact", unitId: artifact.unitId });
      }
    }
  }

  if (state === RY_STATES.VERIFIED && !verifyEvent) {
    issues.push({ kind: "verified-without-verify-event" });
  }

  return {
    ok: issues.length === 0,
    issues,
    recomputedVerdict,
  };
}