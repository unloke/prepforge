// Scout v12 — route audit pure helpers (Step 5 verification pass).
// No Node builtins, no engine I/O.

import { Chess } from "chess.js";

import {
  FEATURE_IDS,
  buildDecisionContext,
  featureVector,
} from "./scout-bias-features.js";
import { ourEntryKey, sfScoreToOurCp } from "./scout-bias-routes.js";
import { epdOf } from "./scout-graph.js";

export const PRODUCT_COPY_RULES = [
  "no weakness/exploit/punish wording",
  "no model probabilities in copy",
  "tendency stated as historical pattern, not node prediction unless nodeGames>=5",
];

/** v12 annotate mode — tier vocabulary and banned product copy (viewer enforces). */
export const PRODUCT_COPY_RULES_V12 = [
  ...PRODUCT_COPY_RULES,
  "tier advantage: tendency-aligned comfort wording + d18 numbers only",
  "tier safe: 不虧、可走 — never claim measurable edge",
  "tier info: 他常走進來的路徑情報 — path intelligence only",
  "banned vocabulary: weakness, exploit, punish, 弱點, 不擅長, 吃虧, 打擊, 必殺",
  "policyResponses labelled 模型排序的主要回應之一 — never 他最可能走",
];

export const CLAIM_LEVEL = "tendency-aligned prep route";

export const ROBUSTNESS_MIN_CP = -20;
export const TIER_ADVANTAGE_MIN_NODE_CP = 25;
export const TIER_ADVANTAGE_MIN_REPLY_CP = 20;
export const TIER_SAFE_MIN_NODE_CP = ROBUSTNESS_MIN_CP;
export const FRAGILITY_GAP_MAX_CP = 80;
export const AUDIT_PATH_TOLERANCE_CP = 30;
export const AUDIT_MEDIUM_EVAL_CP = 15;
export const AUDIT_MIN_REACH_PASSED = 2;
export const AUDIT_MIN_SUBJECT_CHOSE = 5;
export const FRAGILITY_PLIES = 4;

/** Load games JSON (same convention as scout-bias-routes harness). */
export function loadGames(raw) {
  return Array.isArray(raw) ? raw : [...(raw.white || []), ...(raw.black || [])];
}

/** Cohort label for a feature row. */
export function cohortLabelFromRow(row) {
  if (!row) return "cohort-common";
  if (row.insufficient) return "insufficient";
  if (row.bhPass) return "unusual";
  return "cohort-common";
}

/** Map featureId → cohort label from a cohort-z report. */
export function buildCohortLabelMap(cohortReport) {
  const map = new Map();
  for (const f of cohortReport?.features || []) {
    map.set(f.id, cohortLabelFromRow(f));
  }
  return map;
}

export function isHisPly(ply, subjectColor) {
  const mover = ply % 2 === 0 ? "white" : "black";
  return mover === subjectColor;
}

export function ourMovesFromPath(pathUcis, subjectColor) {
  const out = [];
  for (let i = 0; i < pathUcis.length; i += 1) {
    if (!isHisPly(i, subjectColor)) out.push(pathUcis[i]);
  }
  return out;
}

/**
 * Last HIS move UCI on the route path — the decision-maker at the end node is the
 * subject, so his Maia context needs his own previous move (matches routes v2).
 */
export function prevHisMoveUciOnPath(pathUcis, subjectColor) {
  for (let p = pathUcis.length - 1; p >= 0; p -= 1) {
    if (isHisPly(p, subjectColor)) return pathUcis[p];
  }
  return null;
}

export function fenFromUcis(ucis) {
  const chess = new Chess();
  for (const uci of ucis) {
    chess.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci[4] || undefined,
    });
  }
  return chess.fen();
}

export function epdFromUcis(ucis) {
  return epdOf(fenFromUcis(ucis));
}

function featureVaries(cands, fIdx) {
  if (!cands?.length || fIdx < 0) return false;
  const v0 = cands[0].f[fIdx];
  for (let i = 1; i < cands.length; i += 1) {
    if (cands[i].f[fIdx] !== v0) return true;
  }
  return false;
}

function gameUcis(game) {
  return game.openingUcis?.length ? game.openingUcis : game.ucis || [];
}

function makeMove(chess, uci) {
  return chess.move({
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    promotion: uci[4] || undefined,
  });
}

/**
 * Empirical reach: fraction of subject-color games whose move sequence reaches target EPD.
 * Transposition-aware (EPD match only).
 */
export function countActualReach(games, targetEpd, subjectColor, { maxPlies = 30 } = {}) {
  const colorGames = games.filter((g) => g.color === subjectColor);
  const total = colorGames.length;
  let passed = 0;

  for (const game of colorGames) {
    const ucis = gameUcis(game);
    const chess = new Chess();
    let reached = false;

    for (let ply = 0; ply < ucis.length && ply < maxPlies; ply += 1) {
      if (epdOf(chess.fen()) === targetEpd) {
        reached = true;
        break;
      }
      makeMove(chess, ucis[ply]);
    }
    if (!reached && epdOf(chess.fen()) === targetEpd) reached = true;
    if (reached) passed += 1;
  }

  return {
    fraction: total > 0 ? passed / total : 0,
    passed,
    total,
  };
}

/**
 * Subject decision samples where featureId fires as an available option vs chosen.
 */
export function countSubjectSamples(games, featureId, subjectColor, { maxPlies = 60 } = {}) {
  const fIdx = FEATURE_IDS.indexOf(featureId);
  let firing = 0;
  let chose = 0;

  if (fIdx < 0) return { firing, chose };

  for (const game of games) {
    if (game.color !== subjectColor) continue;
    const ucis = gameUcis(game);
    const chess = new Chess();
    let prevOwnMoveUci = null;

    for (let ply = 0; ply < ucis.length && ply < maxPlies; ply += 1) {
      const mover = ply % 2 === 0 ? "white" : "black";
      if (mover === subjectColor) {
        const ctx = buildDecisionContext(chess.fen(), { prevOwnMoveUci });
        const legal = chess.moves({ verbose: true });
        const cands = legal.map((m) => {
          const uci = m.from + m.to + (m.promotion || "");
          return { uci, f: [...featureVector(ctx, uci)] };
        });
        if (featureVaries(cands, fIdx)) firing += 1;
        const playedVec = featureVector(ctx, ucis[ply]);
        if (playedVec[fIdx] > 0) chose += 1;
      }
      makeMove(chess, ucis[ply]);
      if (mover !== subjectColor) prevOwnMoveUci = ucis[ply];
    }
  }

  return { firing, chose };
}

/** Wrap derivation attribution for audit output (probabilities internal-only). */
export function wrapModelAttribution(attribution, topLeakMove) {
  return {
    internal: {
      attribution,
      topLeakMove: topLeakMove
        ? {
            san: topLeakMove.san,
            uci: topLeakMove.uci,
            piTilt: topLeakMove.piTilt,
            piRaw: topLeakMove.piRaw,
            deltaCp: topLeakMove.deltaCp,
          }
        : null,
      note: "internal ranking only — MUST NOT appear in product copy",
    },
  };
}

/**
 * Per-move eval loss vs SF best along OUR path.
 * @param {Array<{ uci: string, san?: string, evalCp: number, bestCp: number }>} moves
 */
export function buildOurLineSoundReport(moves, { tolerance = AUDIT_PATH_TOLERANCE_CP } = {}) {
  const ourMoveLosses = (moves || []).map((m) => {
    const lossCp = Math.max(0, (m.bestCp ?? 0) - (m.evalCp ?? 0));
    return {
      uci: m.uci,
      san: m.san ?? m.uci,
      lossCp,
    };
  });
  const ourLineSound = ourMoveLosses.every((m) => m.lossCp <= tolerance);
  return { ourLineSound, ourMoveLosses };
}

/**
 * Robustness pass: all top replies keep our eval ≥ threshold.
 * @param {Array<{ san: string, piTilt: number, evalAfterCp: number }>} replies
 */
export function assessRobustness(replies, { minCp = ROBUSTNESS_MIN_CP } = {}) {
  const list = replies || [];
  const pass = list.length > 0 && list.every((r) => (r.evalAfterCp ?? -Infinity) >= minCp);
  return { pass, replies: list };
}

/**
 * Fragility: narrow path when any OUR-decision gap between SF 1st/2nd exceeds threshold.
 * @param {Array<{ ply: number, gapCp: number, bestCp?: number, secondCp?: number }>} ourGaps
 */
export function assessFragility(ourGaps, { gapMax = FRAGILITY_GAP_MAX_CP } = {}) {
  let narrowPath = false;
  let narrowPly = null;
  for (const g of ourGaps || []) {
    if ((g.gapCp ?? 0) > gapMax) {
      narrowPath = true;
      narrowPly = g.ply;
      break;
    }
  }
  return {
    narrowPath,
    ply: narrowPly,
    gaps: ourGaps || [],
  };
}

/** Gap between best and second-best eval (our POV) from multipv scores. */
export function multipvGapCp(bestScore, secondScore, sideToMove, ourColor) {
  const bestCp = sfScoreToOurCp(bestScore, sideToMove, ourColor);
  const secondCp = sfScoreToOurCp(secondScore, sideToMove, ourColor);
  return { bestCp, secondCp, gapCp: bestCp - secondCp };
}

/** Distinct entry keys across routes (routes v2 first-6-ply OUR-choice rule). */
export function countEntryDiversity(routes, subjectColor, { entryPlyLimit = 6 } = {}) {
  const keys = new Set();
  for (const route of routes || []) {
    const ourMoves = ourMovesFromPath(route.ucis || [], subjectColor);
    keys.add(ourEntryKey(ourMoves, entryPlyLimit));
  }
  return keys.size;
}

/**
 * Risk level — high conditions take priority over medium.
 */
export function deriveRiskLevel({
  ourLineSound,
  robustnessPass,
  actualReachPassed,
  narrowPath,
  nodeEvalCp18,
  subjectSamplesChose,
}) {
  if (
    ourLineSound === false
    || robustnessPass === false
    || (actualReachPassed ?? 0) < AUDIT_MIN_REACH_PASSED
  ) {
    return "high";
  }
  if (
    narrowPath === true
    || (nodeEvalCp18 ?? 0) < AUDIT_MEDIUM_EVAL_CP
    || (subjectSamplesChose ?? 0) < AUDIT_MIN_SUBJECT_CHOSE
  ) {
    return "medium";
  }
  return "low";
}

/** Audit verdict with human-readable fail reasons. */
export function deriveVerdict({
  riskLevel,
  ourLineSound,
  robustnessPass,
  actualReachPassed,
  narrowPath,
  nodeEvalCp18,
  subjectSamplesChose,
}) {
  const reasons = [];
  if (ourLineSound === false) reasons.push("our line unsound at d18");
  if (robustnessPass === false) reasons.push("robustness failed vs top-3 tilted replies");
  if ((actualReachPassed ?? 0) < AUDIT_MIN_REACH_PASSED) {
    reasons.push(`actual reach < ${AUDIT_MIN_REACH_PASSED} games`);
  }
  if (riskLevel === "high") reasons.push("risk level high");

  const pass =
    (riskLevel === "low" || riskLevel === "medium")
    && ourLineSound !== false
    && robustnessPass !== false;

  if (pass) return { verdict: "pass", reasons: [] };

  if (reasons.length === 0) {
    if (narrowPath) reasons.push("narrow continuation path");
    if ((nodeEvalCp18 ?? 0) < AUDIT_MEDIUM_EVAL_CP) {
      reasons.push(`node eval ${nodeEvalCp18}cp below ${AUDIT_MEDIUM_EVAL_CP}cp`);
    }
    if ((subjectSamplesChose ?? 0) < AUDIT_MIN_SUBJECT_CHOSE) {
      reasons.push(`subject chose feature < ${AUDIT_MIN_SUBJECT_CHOSE} times`);
    }
    if (!reasons.length) reasons.push("audit checks failed");
  }

  return { verdict: "fail", reasons };
}

/** Count routes with verdict pass. */
export function countSurvivors(auditedRoutes) {
  return (auditedRoutes || []).filter((r) => r.verdict === "pass").length;
}

function policyRepliesFromRoute(route) {
  if (route?.policyResponses?.length) return route.policyResponses;
  return route?.robustness?.replies || [];
}

/** Move piTilt under internal; viewer must never surface internal fields. */
export function normalizePolicyResponses(replies) {
  return (replies || []).map((r) => ({
    san: r.san,
    evalAfterCp: r.evalAfterCp,
    internal: { piTilt: r.internal?.piTilt ?? r.piTilt },
  }));
}

/**
 * Three-tier route grading for v12 experimental viewer.
 * @returns {"advantage"|"safe"|"info"|null}
 */
export function classifyRouteTier(route) {
  if (route?.verdict !== "pass") return null;

  const nodeEval = route.sfVerify?.nodeEvalCp18 ?? -Infinity;
  const replies = policyRepliesFromRoute(route);
  const riskLevel = route.riskLevel;
  const narrowPath = route.fragility?.narrowPath === true;
  const nodeGames = route.nodeGames ?? 0;

  const allRepliesStrong =
    replies.length > 0
    && replies.every((r) => (r.evalAfterCp ?? -Infinity) >= TIER_ADVANTAGE_MIN_REPLY_CP);

  let tier;
  if (
    nodeEval >= TIER_ADVANTAGE_MIN_NODE_CP
    && allRepliesStrong
    && riskLevel === "low"
    && !narrowPath
  ) {
    tier = "advantage";
  } else if (nodeEval >= TIER_SAFE_MIN_NODE_CP) {
    tier = "safe";
  } else {
    tier = "info";
  }

  if (nodeGames === 0) {
    if (tier === "advantage") tier = "safe";
    else if (tier === "safe") tier = "info";
  }

  return tier;
}

/**
 * Subject's actual replies at the route end node (exact UCI prefix match).
 * @returns {{ responses: Array<{san,uci,count,wins,draws,losses}>, note?: string }}
 */
export function extractActualPlayerResponses(games, route, subjectColor) {
  const routeUcis = route?.ucis || [];
  const routeLen = routeUcis.length;

  if (routeLen === 0 || !isHisPly(routeLen, subjectColor)) {
    return { responses: [], note: "no actual games reach this node" };
  }

  const colorGames = (games || []).filter((g) => g.color === subjectColor);
  const agg = new Map();

  for (const game of colorGames) {
    const ucis = gameUcis(game);
    if (ucis.length <= routeLen) continue;

    let prefixMatch = true;
    for (let i = 0; i < routeLen; i += 1) {
      if (ucis[i] !== routeUcis[i]) {
        prefixMatch = false;
        break;
      }
    }
    if (!prefixMatch) continue;

    const replyUci = ucis[routeLen];
    const chess = new Chess();
    for (let i = 0; i < routeLen; i += 1) makeMove(chess, ucis[i]);
    const m = makeMove(chess, replyUci);
    const san = m?.san ?? replyUci;

    if (!agg.has(replyUci)) {
      agg.set(replyUci, { san, uci: replyUci, count: 0, wins: 0, draws: 0, losses: 0 });
    }
    const entry = agg.get(replyUci);
    entry.count += 1;
    const score = Number(game.score);
    if (score === 1) entry.wins += 1;
    else if (score === 0.5) entry.draws += 1;
    else entry.losses += 1;
  }

  const responses = [...agg.values()].sort((a, b) => b.count - a.count);
  if (!responses.length) {
    return { responses: [], note: "no actual games reach this node" };
  }
  return { responses };
}

/** Annotate one audited route: tier, policyResponses, actualPlayerResponses. */
export function annotateRoute(route, games, subjectColor) {
  const policyResponses = normalizePolicyResponses(policyRepliesFromRoute(route));
  const actualPlayerResponses = extractActualPlayerResponses(games, route, subjectColor);
  const tier = classifyRouteTier({ ...route, policyResponses });
  return {
    ...route,
    tier,
    policyResponses,
    actualPlayerResponses,
    robustness: route.robustness
      ? { pass: route.robustness.pass, replies: undefined }
      : route.robustness,
  };
}

/** Annotate a full audit JSON (no engine I/O). */
export function annotateAuditReport(auditJson, games) {
  const subjectColor = auditJson?.meta?.subjectColor;
  const tendencies = (auditJson?.tendencies || []).map((t) => ({
    ...t,
    routes: (t.routes || []).map((r) => annotateRoute(r, games, subjectColor)),
  }));

  return {
    ...auditJson,
    meta: {
      ...auditJson.meta,
      annotatedAt: new Date().toISOString(),
    },
    productCopyRules: PRODUCT_COPY_RULES_V12,
    tendencies,
  };
}