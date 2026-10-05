// Scout v13 — extension tree builder (pure async, injected providers).
// No DOM, no engine workers, no network — wiring happens in step 4.

import { AUDIT_MIN_SUBJECT_CHOSE } from "./scout-route-audit.js";

export const EXT_TARGET_PLY = 14;
export const EXT_TARGET_PLY_FORCING = 16;
export const EXT_SOUND_GAP_CP = 30;
export const EXT_SOUND_GAP_SHARP_CP = 20;
export const EXT_ENDPOINT_MIN_CP = -20;
export const EXT_FORK_MAX_REPLIES = 2;
export const EXT_MAX_LEAVES = 6;
export const EXT_COHORT_COVERAGE = 0.7;
export const EXT_COHORT_MIN_GAMES = 50;
/** Harness-calibratable: swing vs best cohort reply that forces inclusion (design §9 codex). */
export const EXT_TACTICAL_SWING_CP = 60;

/**
 * @typedef {import("./scout-v13-package.js").EvidenceEdge} EvidenceEdge
 */

/**
 * @typedef {object} BuildExtensionInput
 * @property {string[]} anchorUcis
 * @property {"white"|"black"} subjectColor
 * @property {"solid"|"sharp"|"rare"|"forcing"|null} [style]
 */

/**
 * @typedef {object} SfMove
 * @property {string} uci
 * @property {string} [san]
 * @property {number} evalCpOur
 * @property {number} gapToBestCp
 */

/**
 * @typedef {object} ExplorerReply
 * @property {string} uci
 * @property {string} [san]
 * @property {number} games
 * @property {number} sharePct
 */

/**
 * @typedef {object} ExplorerResult
 * @property {number} totalGames
 * @property {string} ratingBand
 * @property {string} speed
 * @property {ExplorerReply[]} moves
 */

/**
 * @typedef {object} PersonalReply
 * @property {string} uci
 * @property {string} [san]
 * @property {number} games
 * @property {number} wins
 * @property {number} draws
 * @property {number} losses
 */

/**
 * @typedef {object} ExtensionProviders
 * @property {(ucis: string[]) => Promise<SfMove[]>} sfTopMoves
 * @property {(ucis: string[]) => Promise<ExplorerResult|null>} explorerReplies
 * @property {(ucis: string[]) => Promise<PersonalReply[]>} personalReplies
 */

/**
 * @typedef {object} ExtensionBranch
 * @property {number} forkPlyIndex
 * @property {EvidenceEdge[]} edges
 */

/**
 * @typedef {object} BuildExtensionResult
 * @property {boolean} ok
 * @property {string} [reason]
 * @property {EvidenceEdge[]} mainline
 * @property {ExtensionBranch[]} branches
 * @property {number} leafCount
 * @property {number|null} endpointEvalCp
 */

/**
 * @typedef {object} HisCandidate
 * @property {"personal"|"cohort"|"engine"} kind
 * @property {string} uci
 * @property {string} [san]
 * @property {PersonalReply} [personal]
 * @property {ExplorerReply} [cohortMove]
 * @property {ExplorerResult} [explorer]
 * @property {SfMove} [engineMove]
 */

function resolveTargetPly(style) {
  return style === "forcing" ? EXT_TARGET_PLY_FORCING : EXT_TARGET_PLY;
}

function resolveGapThreshold(style) {
  return style === "sharp" || style === "forcing"
    ? EXT_SOUND_GAP_SHARP_CP
    : EXT_SOUND_GAP_CP;
}

/** True when the prep side (not subject) is to move after `pathLen` plies played. */
function isOurTurn(pathLen, subjectColor) {
  return subjectColor === "black" ? pathLen % 2 === 0 : pathLen % 2 === 1;
}

function evalFromSfMoves(sfMoves, uci) {
  const hit = sfMoves.find((m) => m.uci === uci);
  return hit ? hit.evalCpOur : null;
}

/**
 * Explorer replies that satisfy the cohort factual rule (§2).
 * @param {ExplorerResult|null} explorer
 * @returns {ExplorerReply[]}
 */
export function selectFactualCohortReplies(explorer) {
  if (!explorer?.moves?.length) return [];
  let cumShare = 0;
  const byCoverage = [];
  for (const move of explorer.moves) {
    byCoverage.push(move);
    cumShare += move.sharePct / 100;
    if (cumShare >= EXT_COHORT_COVERAGE) return byCoverage;
  }
  return explorer.moves.filter((m) => m.games >= EXT_COHORT_MIN_GAMES);
}

/**
 * @param {PersonalReply[]} replies
 * @returns {PersonalReply|null}
 */
export function selectPersonalReply(replies) {
  const qualifying = (replies || []).filter((r) => r.games >= AUDIT_MIN_SUBJECT_CHOSE);
  if (!qualifying.length) return null;
  return qualifying.reduce((best, r) => (r.games > best.games ? r : best));
}

/**
 * @param {HisCandidate} candidate
 * @returns {EvidenceEdge}
 */
function hisCandidateToEdge(candidate) {
  if (candidate.kind === "personal" && candidate.personal) {
    const p = candidate.personal;
    return {
      uci: candidate.uci,
      san: candidate.san,
      evidenceSource: "personal",
      receipts: {
        games: p.games,
        wins: p.wins,
        draws: p.draws,
        losses: p.losses,
      },
    };
  }
  if (candidate.kind === "cohort" && candidate.cohortMove && candidate.explorer) {
    const m = candidate.cohortMove;
    const ex = candidate.explorer;
    return {
      uci: candidate.uci,
      san: candidate.san,
      evidenceSource: "cohort",
      receipts: {
        explorerGames: m.games,
        sharePct: m.sharePct,
        ratingBand: ex.ratingBand,
        speed: ex.speed,
      },
    };
  }
  const eng = candidate.engineMove;
  return {
    uci: candidate.uci,
    san: candidate.san,
    evidenceSource: "engine",
    receipts: { evalCp: eng?.evalCpOur ?? 0 },
  };
}

/**
 * @param {SfMove} move
 * @returns {EvidenceEdge}
 */
function ourMoveToEdge(move) {
  return {
    uci: move.uci,
    san: move.san,
    evidenceSource: "engine",
    receipts: {
      evalCp: move.evalCpOur,
      gapToBestCp: move.gapToBestCp,
    },
  };
}

/**
 * Assemble his-ply fork candidates (max EXT_FORK_MAX_REPLIES).
 * @param {string[]} ucis
 * @param {ExtensionProviders} providers
 * @returns {Promise<{ candidates: HisCandidate[], factual: boolean }>}
 */
export async function assembleHisForkCandidates(ucis, providers) {
  const [personalList, explorer, sfMoves] = await Promise.all([
    providers.personalReplies(ucis),
    providers.explorerReplies(ucis),
    providers.sfTopMoves(ucis),
  ]);

  const personal = selectPersonalReply(personalList);
  const cohortReplies = selectFactualCohortReplies(explorer);
  const factual = Boolean(personal) || cohortReplies.length > 0;

  if (!factual) {
    return { candidates: [], factual: false };
  }

  /** @type {HisCandidate[]} */
  const primary = [];
  if (personal) {
    primary.push({
      kind: "personal",
      uci: personal.uci,
      san: personal.san,
      personal,
    });
  } else {
    for (const move of cohortReplies.slice(0, EXT_FORK_MAX_REPLIES)) {
      primary.push({
        kind: "cohort",
        uci: move.uci,
        san: move.san,
        cohortMove: move,
        explorer,
      });
    }
  }

  const bestCohortEval = cohortReplies.length
    ? evalFromSfMoves(sfMoves, cohortReplies[0].uci)
    : null;

  /** @type {HisCandidate|null} */
  let tactical = null;
  if (bestCohortEval !== null) {
    for (const sf of sfMoves) {
      const already = primary.some((c) => c.uci === sf.uci);
      if (already) continue;
      const swing = Math.abs(sf.evalCpOur - bestCohortEval);
      if (swing >= EXT_TACTICAL_SWING_CP) {
        tactical = {
          kind: "engine",
          uci: sf.uci,
          san: sf.san,
          engineMove: sf,
        };
        break;
      }
    }
  }

  /** @type {HisCandidate[]} */
  const out = [];
  if (primary.length) out.push(primary[0]);

  if (out.length < EXT_FORK_MAX_REPLIES) {
    if (tactical) {
      out.push(tactical);
    } else if (!personal && primary.length > 1) {
      out.push(primary[1]);
    }
  } else if (tactical && !personal && primary.length > 1) {
    out[1] = tactical;
  }

  return { candidates: out.slice(0, EXT_FORK_MAX_REPLIES), factual: true };
}

/**
 * @param {string[]} path
 * @param {ExtensionProviders} providers
 * @param {object} ctx
 * @param {number} ctx.targetPly
 * @param {number} ctx.gapThreshold
 * @param {"white"|"black"} ctx.subjectColor
 * @param {{ used: number, max: number }} ctx.leafSlots
 * @param {boolean} [ctx.isMainline]
 * @returns {Promise<
 *   | { ok: true, edges: EvidenceEdge[], branches: ExtensionBranch[], endpointEvalCp: number|null }
 *   | { ok: false, reason: string }
 * >}
 */
async function extendPath(path, providers, ctx) {
  /** @type {EvidenceEdge[]} */
  const edges = [];
  /** @type {ExtensionBranch[]} */
  const branches = [];
  let endpointEvalCp = null;

  if (ctx.isMainline && ctx.leafSlots.used === 0) {
    ctx.leafSlots.used = 1;
  } else if (!ctx.isMainline && ctx.leafSlots.used < ctx.leafSlots.max) {
    ctx.leafSlots.used += 1;
  }

  while (path.length < ctx.targetPly) {
    const ourTurn = isOurTurn(path.length, ctx.subjectColor);

    if (ourTurn) {
      const sfMoves = await providers.sfTopMoves(path);
      const pick = sfMoves.find((m) => m.gapToBestCp <= ctx.gapThreshold);
      if (!pick) {
        return { ok: false, reason: "soundnessFail" };
      }
      const edge = ourMoveToEdge(pick);
      edges.push(edge);
      path.push(pick.uci);
      endpointEvalCp = pick.evalCpOur;
      continue;
    }

    const { candidates, factual } = await assembleHisForkCandidates(path, providers);
    if (!factual || !candidates.length) {
      break;
    }

    const mainCandidate = candidates[0];
    const mainEdge = hisCandidateToEdge(mainCandidate);
    edges.push(mainEdge);
    path.push(mainCandidate.uci);

    if (mainCandidate.kind === "engine" && mainCandidate.engineMove) {
      endpointEvalCp = mainCandidate.engineMove.evalCpOur;
    }

    const alternates = candidates.slice(1);
    for (const alt of alternates) {
      if (ctx.leafSlots.used >= ctx.leafSlots.max) break;
      const branchPath = path.slice(0, -1).concat(alt.uci);
      const branchResult = await extendPath(branchPath, providers, {
        ...ctx,
        isMainline: false,
      });
      if (!branchResult.ok) {
        if (branchResult.reason === "soundnessFail" && ctx.isMainline) {
          return branchResult;
        }
        continue;
      }
      branches.push({
        forkPlyIndex: edges.length - 1,
        edges: [hisCandidateToEdge(alt), ...branchResult.edges],
      });
      branches.push(...branchResult.branches);
    }
  }

  return { ok: true, edges, branches, endpointEvalCp };
}

/**
 * Build an honest extension tree from the personal anchor (design §2).
 * @param {BuildExtensionInput} input
 * @param {ExtensionProviders} providers
 * @param {object} [opts]
 * @param {number} [opts.targetPly]
 * @param {number} [opts.gapThreshold]
 * @param {number} [opts.endpointMinCp]
 * @param {number} [opts.leafBudget]
 * @returns {Promise<BuildExtensionResult>}
 */
export async function buildExtension(input, providers, opts = {}) {
  const style = input.style ?? null;
  const targetPly = opts.targetPly ?? resolveTargetPly(style);
  const gapThreshold = opts.gapThreshold ?? resolveGapThreshold(style);
  const endpointMinCp = opts.endpointMinCp ?? EXT_ENDPOINT_MIN_CP;
  const leafBudget = opts.leafBudget ?? EXT_MAX_LEAVES;

  const anchorLen = input.anchorUcis.length;
  if (targetPly - anchorLen < 2) {
    return {
      ok: false,
      reason: "tooShort",
      mainline: [],
      branches: [],
      leafCount: 0,
      endpointEvalCp: null,
    };
  }

  const path = [...input.anchorUcis];
  const leafSlots = { used: 0, max: leafBudget };
  const ctx = {
    targetPly,
    gapThreshold,
    subjectColor: input.subjectColor,
    leafSlots,
    isMainline: true,
  };

  const result = await extendPath(path, providers, ctx);
  if (!result.ok) {
    return {
      ok: false,
      reason: result.reason,
      mainline: [],
      branches: [],
      leafCount: 0,
      endpointEvalCp: null,
    };
  }

  const { edges, branches, endpointEvalCp } = result;
  const leafCount = leafSlots.used;

  if (edges.length < 2) {
    return {
      ok: false,
      reason: "tooShort",
      mainline: edges,
      branches,
      leafCount,
      endpointEvalCp,
    };
  }

  // §2: the extension endpoint must hold eval ≥ endpointMinCp even when the line
  // was cut early (noFactualReplies) — an honest cut into a bad position still fails.
  if (endpointEvalCp !== null && endpointEvalCp < endpointMinCp) {
    return {
      ok: false,
      reason: "endpointEval",
      mainline: edges,
      branches,
      leafCount,
      endpointEvalCp,
    };
  }

  return {
    ok: true,
    mainline: edges,
    branches,
    leafCount,
    endpointEvalCp,
  };
}