// Hidden Stockfish pre-filter for Scout: shallow eval on all opening-line candidates,
// rank by objective prep value, and pick the top pool for Maia3 WDL enrichment.
// Results never surface in the Scout UI — only the Maia-ranked game plan is shown.

import { analyzeGamePositions } from "./engine/game-analyzer.js";
import { createEngineProvider } from "./engine/stockfish-provider.js";
import {
  SCOUT_BRANCH_SCORE_CAP,
  SCOUT_MAIA_LIMIT,
  SCOUT_SCORING_VERSION,
  SCOUT_STOCKFISH_DEPTH,
  fenBeforeLastMove,
  hashGameIdsForScope,
  isNestedLine,
  isOpponentComfortZone,
  normalizeToOpponentTerminal,
  terminalMoveIsOpponent,
  triePathKey,
} from "./scout.js";

export const SCOUT_PREFILTER_DEPTH = SCOUT_STOCKFISH_DEPTH;
export const SCOUT_PREFILTER_LIMIT = SCOUT_BRANCH_SCORE_CAP;
/** Maia backup pool depth — decoupled from the branch cap. Stockfish access is bounded by
 * the time budget, not this; this only caps how many ranked entries the Maia chase may dip
 * into for backups. Maia still resolves SCOUT_MAIA_LIMIT (12) unique lines. */
export const SCOUT_PREFILTER_POOL_SIZE = 64;
export const SCOUT_MAIA_PREFILTER_LIMIT = SCOUT_MAIA_LIMIT;
export const SCOUT_PREFILTER_CONCURRENCY = 3;
export const SCOUT_PREFILTER_TIME_BUDGET_MS = 45_000;
export const SCOUT_PREFILTER_ENGINE_VERSION = "stockfish-18-lite";
export const SCOUT_MIN_ANCESTOR_FREQUENCY = 0.01;
export const SCOUT_MIN_STOCKFISH_ADVANTAGE = 20;
/** OR-gate thresholds — a line survives on objective edge, empirical struggle, a rare
 * off-book reply, or a strong engine-free exploitability prior. (The old cp-loss gate is
 * gone: it required a second Stockfish eval of the pre-move position only to confirm "was
 * the last move bad", which the leaf advantage already captures.) */
export const SCOUT_PREFILTER_STRUGGLE_GATE = 0.15;
export const SCOUT_PREFILTER_OFFMODAL_GATE = 2;
export const SCOUT_PREFILTER_OFFMODAL_MIN_ADV = 8;
/** Prior-rescue floor: a line with a real exploitability prior (≈ struggle 0.1, off-modal,
 * a small recurring family) survives even when the depth-8 leaf edge is modest. Derived from
 * (0.1+0.08)·2^0.7·(log1p(3)+0.1) ≈ 0.43; set slightly conservative. */
export const SCOUT_PREFILTER_PRIOR_FLOOR = 0.4;

export const PREFILTER_IDLE = "idle";
export const PREFILTER_LOADING = "loading";
export const PREFILTER_READY = "ready";
export const PREFILTER_FAILED = "failed";

/** Scope key — username, speed, game-id set, and scoring version (not raw count). */
export function computePrefilterScopeKey({
  username,
  activeSpeed,
  games,
  gameCount,
} = {}) {
  const idsHash = games?.length ? hashGameIdsForScope(games) : String(gameCount || 0);
  return `${String(username || "").toLowerCase()}|${activeSpeed || "all"}|${idsHash}|${SCOUT_SCORING_VERSION}`;
}

function moverFromFen(fen) {
  const parts = String(fen || "").split(" ");
  return parts[1] === "b" ? "black" : "white";
}

export function prefilterCacheKey(fen, depth = SCOUT_PREFILTER_DEPTH) {
  return `${SCOUT_PREFILTER_ENGINE_VERSION}|d${depth}|${fen}`;
}

/**
 * Collect the distinct LEAF FENs needed to score opening-line candidates. Leaf-only: the
 * line's value is the position the opponent's move reaches (`userLeafAdvantage`), so we no
 * longer evaluate the pre-move position. Dropping that second eval ~halves the Stockfish
 * workload, which is what lets the prefilter run uncapped within the same time budget. The
 * candidates arrive exploitability-prior-sorted and `analyzeGamePositions` drains its queue
 * front-to-back, so the highest-prior leaves are confirmed first when the budget runs out.
 */
export function collectPrefilterFens(lines, { fenAfterLine, oppColor }) {
  const fens = [];
  const seen = new Set();
  for (const line of lines || []) {
    const normalized = normalizeToOpponentTerminal(line.ucis, line.sans, oppColor);
    if (!normalized) continue;
    const ucis = normalized.ucis;
    if (!terminalMoveIsOpponent(ucis, oppColor)) continue;
    const leaf = fenAfterLine(ucis);
    if (!leaf || seen.has(leaf)) continue;
    seen.add(leaf);
    fens.push(leaf);
  }
  return fens;
}

/**
 * Score one line from shallow Stockfish reads. Higher prefilterScore = more objectively
 * worth preparing. Returns null when the line should be excluded.
 */
export function scorePrefilterLine(line, evalMap, { fenAfterLine, oppColor, ancestorFreq, funnel }) {
  const drop = (key) => {
    if (funnel?.scoreDrops) {
      funnel.scoreDrops[key] = (funnel.scoreDrops[key] || 0) + 1;
    }
  };

  const normalized = normalizeToOpponentTerminal(line.ucis, line.sans, oppColor);
  if (!normalized) {
    drop("notOppTerminal");
    return null;
  }
  const ucis = normalized.ucis;
  if (!terminalMoveIsOpponent(ucis, oppColor)) {
    drop("notOppTerminal");
    return null;
  }

  // fenBefore is still derived (chess.js, not an engine read) for the mover check and the
  // ancestor-frequency lookup; only its Stockfish eval is gone.
  const fenBefore = fenBeforeLastMove(ucis);
  const fenLeaf = fenAfterLine(ucis);
  const leafEval = fenLeaf ? evalMap.get(fenLeaf) : null;
  if (!leafEval) {
    drop("noEval");
    return null;
  }

  const mover = moverFromFen(fenBefore);
  if (mover !== oppColor) {
    drop("moverMismatch");
    return null;
  }

  const afterCp = leafEval.score_cp ?? 0;
  const userLeafAdvantage = oppColor === 'white' ? -afterCp : afterCp;
  // Mate counts only when it favours the USER (the side preparing). `mate_in` is White-POV,
  // so flip its sign for a black-user (oppColor white). Opponent-mate leaves get mateIn 0.
  const rawMate = leafEval.mate_in ?? 0;
  const userMate = oppColor === 'white' ? -rawMate : rawMate;
  const mateIn = userMate > 0 ? userMate : 0;
  const hasUserReply = !!leafEval.best_move_uci || mateIn > 0;

  if (!hasUserReply) {
    drop("noUserReply");
    return null;
  }

  const ancestorInfo = ancestorFreq?.get(fenBefore) || { frequency: 0.001 };

  if (funnel) funnel.scored = (funnel.scored || 0) + 1;

  return {
    userLeafAdvantage,
    mateIn,
    hasUserReply,
    prefilterScore: userLeafAdvantage,
    ancestorFrequency: ancestorInfo.frequency,
    ancestorScorePct: ancestorInfo.scorePct,
    ancestorGames: ancestorInfo.games,
    scorePct: line.scorePct,
    games: line.games,
    // Prefix-resolved exploitability signals, annotated upstream by rankedOpeningBranches.
    struggle: line.exploitabilityStruggle ?? 0,
    offModal: line.offModal ?? 0,
    prefixGames: line.prefixGames ?? 0,
    exploitabilityPrior: line.exploitabilityPrior ?? 0,
  };
}

/**
 * Final exploitability rank = engine-free PRIOR × engine CONFIRMATION × empirical amplifier.
 *   prior   — the upstream exploitability prior (struggle × off-modal rarity × family
 *             reproducibility); already carries "is this a recurring weakness worth prepping".
 *             1 is substituted when no prior exists (no-trie fallback) so the edge still orders.
 *   edge    — the depth-8 leaf advantage above an 8cp noise floor, log-compressed so a +40cp
 *             confirm beats a +12cp one without scaling linearly; a user-favourable mate
 *             saturates it. This is CONFIRMATION, not the ranking driver — it gates noise, the
 *             prior decides priority. (cp-loss is intentionally absent: it only told us whether
 *             the last move was bad, which the leaf advantage already reflects.)
 *   struggle — empirical amplifier on top, once the engine agrees there is an edge.
 */
export function exploitabilityRank(entry) {
  const edge = entry?.mateIn ? 1e6 : Math.max(0, (entry?.prefilterScore ?? 0) - 8);
  const prior = entry?.exploitabilityPrior ?? 0;
  const struggle = Math.max(0, entry?.struggle ?? 0);
  return (prior > 0 ? prior : 1) * Math.log1p(1 + edge / 12) * (1 + 2 * struggle);
}

function tiebreakRecencyShare(a, b) {
  const aStamp = a.lastSeen?.lastDatestamp ?? a.lastDatestamp ?? 0;
  const bStamp = b.lastSeen?.lastDatestamp ?? b.lastDatestamp ?? 0;
  return bStamp - aStamp || (b.share || 0) - (a.share || 0) || (b.count || 0) - (a.count || 0);
}

/** Collapse nested prefix lines — keep the deeper representative only when score is not worse. */
export function collapseNestedPrefilterLines(sorted) {
  const chosen = [];
  for (const entry of sorted) {
    const nestedIdx = chosen.findIndex((c) => isNestedLine(c.line, entry.line));
    if (nestedIdx >= 0) {
      const existing = chosen[nestedIdx];
      const cPath = existing.line.line || triePathKey(existing.line.ucis || []);
      const gPath = entry.line.line || triePathKey(entry.line.ucis || []);
      if (gPath.startsWith(`${cPath}>`)) {
        if (entry.prefilterScore >= existing.prefilterScore) {
          chosen[nestedIdx] = entry;
        }
      } else if (entry.prefilterScore > existing.prefilterScore) {
        chosen[nestedIdx] = entry;
      }
      continue;
    }
    chosen.push(entry);
  }
  return chosen;
}

/**
 * Rank all opening-line candidates by objective Stockfish signals. Returns scored
 * entries sorted best-first; count/recency are tiebreakers only.
 */
export function rankPrefilterCandidates(
  lines,
  evalMap,
  { fenAfterLine, oppColor, ancestorFreq, baselineScorePct = 50, funnelOut },
) {
  const funnel = {
    totalLines: (lines || []).length,
    scoreDrops: {
      notOppTerminal: 0,
      noEval: 0,
      incompleteEval: 0,
      moverMismatch: 0,
      noUserReply: 0,
    },
    scored: 0,
    gateDrops: { comfortZone: 0, failedOrGate: 0 },
    survived: 0,
    afterCollapse: 0,
  };

  const scored = [];
  for (const line of lines || []) {
    const metrics = scorePrefilterLine(line, evalMap, {
      fenAfterLine,
      oppColor,
      ancestorFreq,
      funnel,
    });
    if (!metrics) continue;
    scored.push({
      line,
      ...metrics,
    });
  }
  // OR-gate: a line is worth prepping if the opponent is NOT in a comfort zone there, and
  // ANY of — the user has a forced mate, Stockfish finds a clear edge, the line family
  // empirically underperforms, it's a rare off-book reply with a non-trivial edge, or it
  // carries a strong engine-free prior with some edge. This replaces the old AND-style
  // "+20cp AND frequent" wall that zeroed every main line (and the cp-loss branch, which
  // needed a second eval to confirm a now-redundant signal).
  const gated = scored.filter((entry) => {
    if (isOpponentComfortZone(entry, baselineScorePct)) {
      funnel.gateDrops.comfortZone++;
      return false;
    }
    if (entry.mateIn > 0) return true;
    const adv = entry.prefilterScore ?? 0;
    const struggle = entry.struggle ?? 0;
    const offModal = entry.offModal ?? 0;
    const prior = entry.exploitabilityPrior ?? 0;
    if (adv >= SCOUT_MIN_STOCKFISH_ADVANTAGE) return true;
    if (struggle >= SCOUT_PREFILTER_STRUGGLE_GATE && adv > 0) return true;
    if (offModal >= SCOUT_PREFILTER_OFFMODAL_GATE && adv >= SCOUT_PREFILTER_OFFMODAL_MIN_ADV) {
      return true;
    }
    // Prior-rescue (replaces the old cp-loss branch): a rare sideline with a real recurring
    // exploitability prior survives even when depth-8 undercounts its modest leaf edge.
    if (prior > SCOUT_PREFILTER_PRIOR_FLOOR && adv > 0) return true;
    funnel.gateDrops.failedOrGate++;
    return false;
  });
  funnel.survived = gated.length;
  gated.sort(
    (a, b) =>
      exploitabilityRank(b) - exploitabilityRank(a) ||
      Number(b.hasUserReply) - Number(a.hasUserReply) ||
      (b.ancestorFrequency ?? 0) - (a.ancestorFrequency ?? 0) ||
      tiebreakRecencyShare(a.line, b.line),
  );
  const collapsed = collapseNestedPrefilterLines(gated);
  funnel.afterCollapse = collapsed.length;
  if (funnelOut) Object.assign(funnelOut, funnel);
  return collapsed;
}

export function prefilterPoolLines(ranked, poolSize = SCOUT_PREFILTER_POOL_SIZE) {
  return (ranked || []).slice(0, poolSize).map((entry) => entry.line);
}

export function prefilterMaiaLines(ranked, limit = SCOUT_MAIA_PREFILTER_LIMIT) {
  const seen = new Set();
  const out = [];
  for (const entry of ranked || []) {
    const key = entry.line?.line || triePathKey(entry.line?.ucis || []);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry.line);
    if (out.length >= limit) break;
  }
  return out;
}

/** Ranked-opening fallback when Stockfish prefilter cannot run. */
export function buildFallbackPrefilterData(
  lines,
  { poolSize = SCOUT_PREFILTER_POOL_SIZE, limit = SCOUT_PREFILTER_LIMIT } = {},
) {
  const pool = (lines || []).slice(0, poolSize);
  const ranked = pool.map((line) => ({
    line,
    prefilterScore: 0,
    hasUserReply: true,
    mateIn: 0,
    exploitabilityPrior: 0,
  }));
  const maiaLines = prefilterMaiaLines(ranked, limit);
  return { ranked, pool, maiaLines };
}

/**
 * Merge per-colour Stockfish-ranked entries into one global pool for Maia3.
 * Each colour list is already nested-collapsed in rankPrefilterCandidates — do
 * not collapse again here, because isNestedLine compares UCI paths only and
 * would incorrectly drop unrelated lines from the other opponent-colour section.
 */
export function mergeGlobalPrefilterRanked(
  rankedByColor,
  { poolSize = SCOUT_PREFILTER_POOL_SIZE, baselineByColor = {} } = {},
) {
  const entries = [];
  for (const oppColor of ["white", "black"]) {
    for (const entry of rankedByColor?.[oppColor] || []) {
      entries.push({ ...entry, oppColor });
    }
  }
  entries.sort(
    (a, b) =>
      exploitabilityRank(b) - exploitabilityRank(a) ||
      Number(b.hasUserReply) - Number(a.hasUserReply) ||
      (b.ancestorFrequency ?? 0) - (a.ancestorFrequency ?? 0) ||
      tiebreakRecencyShare(a.line, b.line) ||
      a.oppColor.localeCompare(b.oppColor),
  );
  return entries.slice(0, poolSize);
}

/** Read cached evals from an in-memory Map keyed by prefilterCacheKey. */
export function evalMapFromCache(fens, cache, depth = SCOUT_PREFILTER_DEPTH) {
  const map = new Map();
  for (const fen of fens || []) {
    const hit = cache?.get(prefilterCacheKey(fen, depth));
    if (hit) map.set(fen, hit);
  }
  return map;
}

/** Store eval results into the session cache. */
export function rememberPrefilterEvals(cache, evalMap, depth = SCOUT_PREFILTER_DEPTH) {
  if (!cache || !evalMap) return;
  for (const [fen, evalResult] of evalMap) {
    cache.set(prefilterCacheKey(fen, depth), evalResult);
  }
}

/**
 * Shallow Stockfish pass over all candidate lines. Returns ranked entries and the
 * top pool for Maia (limit + backup headroom). Never writes UI-facing data.
 */
function wrapEvalComplete(evalResult, complete = true) {
  if (!evalResult) return { complete: false };
  return { ...evalResult, complete };
}

export async function runStockfishPrefilter(
  lines,
  {
    fenAfterLine,
    oppColor,
    ancestorFreq = null,
    baselineScorePct = 50,
    depth = SCOUT_PREFILTER_DEPTH,
    poolSize = SCOUT_PREFILTER_POOL_SIZE,
    concurrency = SCOUT_PREFILTER_CONCURRENCY,
    timeBudgetMs = SCOUT_PREFILTER_TIME_BUDGET_MS,
    cache = new Map(),
    shouldCancel = () => false,
    createProvider = createEngineProvider,
    onProgress = null,
    now = () => Date.now(),
  } = {},
) {
  if (!lines?.length || !fenAfterLine || !oppColor) {
    return {
      ranked: [],
      pool: [],
      maiaLines: [],
      incompleteLines: [],
      funnel: { totalLines: 0 },
    };
  }

  const allFens = collectPrefilterFens(lines, { fenAfterLine, oppColor });
  const missing = allFens.filter((fen) => {
    const hit = cache.get(prefilterCacheKey(fen, depth));
    return !hit || hit.complete !== true;
  });

  const startedAt = now();
  const budgetExpired = () => now() - startedAt >= timeBudgetMs;
  const cancelled = () => shouldCancel() || budgetExpired();

  // Positions already cached from a prior pass still count toward the bar so it doesn't
  // jump backwards when transpositions or a re-run shrink the missing set.
  const cachedCount = allFens.length - missing.length;
  if (typeof onProgress === "function") {
    onProgress({ done: cachedCount, total: allFens.length, phase: "stockfish" });
  }

  let freshEvals = new Map();
  if (missing.length && !cancelled()) {
    try {
      freshEvals = await analyzeGamePositions({
        positions: missing,
        depth,
        concurrency,
        shouldCancel: cancelled,
        onProgress: (done) => {
          if (typeof onProgress === "function") {
            onProgress({ done: cachedCount + done, total: allFens.length, phase: "stockfish" });
          }
        },
        createProvider: (opts) => createProvider({ ...opts, maxDepth: depth }),
      });
      for (const [fen, evalResult] of freshEvals) {
        cache.set(prefilterCacheKey(fen, depth), wrapEvalComplete(evalResult, !cancelled()));
      }
    } catch (err) {
      // Budget expiry throws AnalysisCancelled with partialResults; user cancellation should re-throw.
      const isBudgetStop = err.cancelled && budgetExpired() && !shouldCancel();
      if (!isBudgetStop) throw err;
      // Use partial evaluations from workers. Mark them as incomplete so the UI knows
      // some FENs didn't finish, but still rank what we have.
      if (err.partialResults) {
        freshEvals = err.partialResults;
        for (const [fen, evalResult] of freshEvals) {
          cache.set(prefilterCacheKey(fen, depth), wrapEvalComplete(evalResult, false));
        }
      }
    }
  }

  const superseded = shouldCancel();
  const hitTimeBudget = budgetExpired() && !superseded;
  for (const fen of missing) {
    const key = prefilterCacheKey(fen, depth);
    if (!cache.has(key)) {
      cache.set(key, wrapEvalComplete(null, false));
    }
  }

  const evalMap = evalMapFromCache(allFens, cache, depth);
  for (const [fen, evalResult] of freshEvals) {
    if (!evalMap.has(fen)) evalMap.set(fen, evalResult);
  }

  const funnel = {};
  const ranked = rankPrefilterCandidates(lines, evalMap, {
    fenAfterLine,
    oppColor,
    ancestorFreq,
    baselineScorePct,
    funnelOut: funnel,
  });
  const pool = prefilterPoolLines(ranked, poolSize);
  const maiaLines = prefilterMaiaLines(ranked, SCOUT_MAIA_PREFILTER_LIMIT);
  const incompleteLines = pool.filter((line) => {
    const metrics = scorePrefilterLine(line, evalMap, { fenAfterLine, oppColor, ancestorFreq });
    return !metrics;
  });

  funnel.poolSize = pool.length;
  funnel.maiaCandidates = maiaLines.length;

  return {
    ranked,
    pool,
    maiaLines,
    incompleteLines,
    funnel,
    cancelled: superseded || hitTimeBudget,
    budgetExpired: hitTimeBudget,
    superseded,
  };
}