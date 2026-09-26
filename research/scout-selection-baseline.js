// Frozen 7f79e9d final ranking for reproducible comparison; never imported by runtime.
import { GAME_PLAN_MIN_GAMES, SCOUT_GAME_PLAN_LIMIT, SCOUT_MIN_ROUTE_REACH, enrichPrepTarget, normalizeToOpponentTerminal, branchPathKey, triePathKey, isNestedLine } from "../web-src/scout.js";
export function opponentStruggleFactor(opponentScorePct, baselineScorePct = 50) {
  if (opponentScorePct == null) return 1;
  const baseline = Math.max(baselineScorePct, 1);
  const ratio = Math.min(1, opponentScorePct / baseline);
  return 1 - ratio;
}

/** Prep value after reachability has been checked separately. */
export function openingWeaknessScore(entry, baselineScorePct = 50) {
  const stockfishAdvantage = Math.max(0, entry?.prefilterScore ?? 0);
  const empiricalScore = entry?.ancestorScorePct ?? entry?.scorePct ?? null;
  const struggle = opponentStruggleFactor(empiricalScore, baselineScorePct);
  return stockfishAdvantage * struggle;
}


export function rankGamePlan(
  lines,
  baselineScorePct,
  {
    minGames = GAME_PLAN_MIN_GAMES,
    oppColor = null,
    limit = SCOUT_GAME_PLAN_LIMIT,
    games = null,
    speedFilter = "all",
    lineLastSeen = null,
  } = {},
) {
  const eligible = lines
    .filter((g) => g.games >= minGames)
    .map((g) => {
      if (!oppColor) return enrichPrepTarget(g, baselineScorePct);
      const normalized = normalizeToOpponentTerminal(g.ucis, g.sans, oppColor);
      if (!normalized) return null;
      const enriched = enrichPrepTarget(
        {
          ...g,
          ucis: normalized.ucis,
          sans: normalized.sans,
          line: branchPathKey(normalized.ucis),
          maiaWdl: g.maiaWdl,
          prefilterScore: g.prefilterScore,
        },
        baselineScorePct,
        { maiaScorePct: g.maiaScorePct ?? null },
      );
      enriched.routeReach = g.routeReach;
      enriched.routePlausibility = g.routePlausibility;
      // Carried for the next-stage parent/child selection research — NOT used in
      // this stage's ordering or collapse decisions.
      enriched.routeSupportGames = g.routeSupportGames ?? null;
      if (!enriched.lastSeen && games && lineLastSeen) {
        enriched.lastSeen = lineLastSeen(games, enriched.ucis, { color: oppColor, speedFilter });
      }
      return enriched;
    })
    .filter((line) => line && (line.routeReach == null || line.routeReach >= SCOUT_MIN_ROUTE_REACH))
    .sort((a, b) => {
      const aHasMaia = a.maiaScorePct != null;
      const bHasMaia = b.maiaScorePct != null;
      if (aHasMaia && bHasMaia && a.maiaScorePct !== b.maiaScorePct) {
        return a.maiaScorePct - b.maiaScorePct;
      }
      if (aHasMaia !== bHasMaia) return aHasMaia ? -1 : 1;
      const weaknessA = openingWeaknessScore(a, baselineScorePct);
      const weaknessB = openingWeaknessScore(b, baselineScorePct);
      if (weaknessA !== weaknessB) {
        return weaknessB - weaknessA;
      }
      const aStamp = a.lastSeen?.lastDatestamp ?? 0;
      const bStamp = b.lastSeen?.lastDatestamp ?? 0;
      const aKey = a.line || triePathKey(a.ucis || []);
      const bKey = b.line || triePathKey(b.ucis || []);
      return (
        bStamp - aStamp ||
        (b.branchScore || 0) - (a.branchScore || 0) ||
        b.share - a.share ||
        b.games - a.games ||
        aKey.localeCompare(bKey)
      );
    });

  const chosen = [];
  for (const g of eligible) {
    const gPath = g.line || triePathKey(g.ucis || []);
    const nestedIdx = chosen.findIndex((c) => isNestedLine(c, g));
    if (nestedIdx >= 0) {
      const existing = chosen[nestedIdx];
      // A deeper route must be at least as personally supported as its parent.
      // routeReach measures opponent decisions, not full-route game support.
      const supportDelta = (g.games ?? 0) - (existing.games ?? 0);
      const scoreDelta = (g.prefilterScore ?? 0) - (existing.prefilterScore ?? 0);
      const cPath = existing.line || triePathKey(existing.ucis || []);
      if (supportDelta > 0 || (supportDelta === 0 &&
        (scoreDelta > 0 || (scoreDelta === 0 && gPath.startsWith(`${cPath}>`))))) {
        chosen[nestedIdx] = g;
      }
      continue;
    }
    chosen.push(g);
  }
  return limit > 0 ? chosen.slice(0, limit) : chosen;
}
