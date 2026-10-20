import { notices } from "../core/state.js";
import { effectiveMaiaRating, maiaAnalysisEnabled } from "../core/prefs.js";
import { getSharedMaia3Provider } from "../engine/maia3-provider.js";
import { watchMaiaInit } from "../maia-init-notice.js";

// The coach chunk (commentary/reasons/voice) and the phase-coach module are big
// and lazy; both are loaded once and shared by Analyze and Train.
export let _coachReady = null;
export function preloadCoach() {
  if (!_coachReady) {
    _coachReady = import("./bundle.js").catch((err) => {
      _coachReady = null;
      throw err;
    });
  }
  return _coachReady;
}

let _phaseCoachMod = null;
export function loadPhaseCoach() {
  if (!_phaseCoachMod) _phaseCoachMod = import("./phase-coach.js");
  return _phaseCoachMod;
}

export async function maiaPhaseCoach({ fen, expectedUci, expectedSan, playedUci }) {
  const m = await loadPhaseCoach();
  let predictions = [];
  // Analysis-layer gate: with Maia analysis OFF the tip stays phase-generic
  // (no provider init, no inference).
  if (maiaAnalysisEnabled()) {
    try {
      const provider = getSharedMaia3Provider();
      const maiaNotice = watchMaiaInit(provider, {
        notices,
        onRetry: () => void maiaPhaseCoach({ fen, expectedUci, expectedSan, playedUci }),
      });
      try {
        predictions = await provider.predictions({ fen, rating: effectiveMaiaRating() });
        maiaNotice.succeed();
      } catch (error) {
        maiaNotice.fail(error);
      }
    } catch (_) {
      /* engine off → still return a phase-generic tip */
    }
  }
  return m.buildPhaseCoach({
    fen,
    predictions,
    expectedUci,
    expectedSan,
    playedUci,
    rating: effectiveMaiaRating(),
  });
}
