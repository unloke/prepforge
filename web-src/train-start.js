// Whether the Train panel's Start button is disabled.
//
// Line rehearsal needs a chosen repertoire, so a signed-in user without one
// waits on the picker. A guest has no repertoires at all: disabling Start for
// them left a dead button (UX walkthrough 2026-10-01 P0-1). Keeping it enabled
// lets the click reach startTraining(), which opens the sign-in gate.
export function trainStartDisabled({ mode, signedIn, hasRepertoire }) {
  if (mode === "smart" || mode === "play") return false;
  if (!signedIn) return false;
  return !hasRepertoire;
}
