// Production Module B selector contract.
//
// Research candidates live under research/ and are not imported here.
// A future method may be added beside scout-v2; production remains this module
// until an authorized replacement is wired through PRODUCTION_MODULE_B.id.

import {
  SCOUT_GAME_PLAN_LIMIT,
  SCOUT_SCORING_VERSION,
  rankGamePlan,
} from "./scout.js";

/** Official production Module B identity. */
export const PRODUCTION_MODULE_B_ID = "scout-v2";
export const PRODUCTION_MODULE_B_SCORING_VERSION = SCOUT_SCORING_VERSION;
export const PRODUCTION_ROUTE_BUDGET = SCOUT_GAME_PLAN_LIMIT;

export const PRODUCTION_MODULE_B = Object.freeze({
  id: PRODUCTION_MODULE_B_ID,
  label: "Scout v2",
  scoringVersion: PRODUCTION_MODULE_B_SCORING_VERSION,
  routeBudget: PRODUCTION_ROUTE_BUDGET,
  researchOnly: false,
});

/**
 * Production Module B entrypoint. Same ranking as rankGamePlan; the named
 * export is the replaceable selector boundary.
 */
export function selectProductionRoutes(lines, baselineScorePct, options = {}) {
  return rankGamePlan(lines, baselineScorePct, {
    ...options,
    limit: options.limit ?? PRODUCTION_ROUTE_BUDGET,
  });
}

export function getProductionModuleB() {
  return {
    ...PRODUCTION_MODULE_B,
    select: selectProductionRoutes,
  };
}
