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

// Why the smart queue's Start cannot build a queue right now, "" when it can.
// Reads the same /smart/summary?preview=true payload that labels the button, so
// a Start with nothing behind it is dead instead of failing server-side. A
// missing payload (fetch failed, cache cleared) blocks nothing: the server
// still owns the real answer, and Start must not guess.
export function trainStartBlockReason(nextSession, { hasActiveRepertoire }) {
  if (!nextSession || Number(nextSession.cards) > 0) return "";
  return hasActiveRepertoire
    ? "Nothing due. Add lines in Repertoire."
    : "No active repertoire. Create one in Library.";
}

// Why line rehearsal's Start cannot open a session right now, "" when it can.
// Rehearsal walks the selected repertoire's own moves, and the listing's health
// counts exactly those (live, not the cached blob), so zero means no line to
// walk. A repertoire whose health was never computed answers nothing: Start
// stays live and the click itself reports.
export function rehearsalStartBlockReason(repertoire) {
  if (!repertoire || !repertoire.health) return "";
  if (Number(repertoire.health.trainable) > 0) return "";
  return "No moves to train. Add lines in Repertoire.";
}

// A Start 400 that only means the server has nothing to serve. Start's disabled
// reason already owns that state, so callers must not paint it as a fault.
// Covers the smart single- and mixed-repertoire messages and line rehearsal.
export function isNothingToTrainError(error) {
  return error?.status === 400 && /no (active repertoires|trainable (moves|lines))/i.test(error.message || "");
}

// The repertoire a new queue is built for. "New session" means another queue
// like this one: a queue drilled for one repertoire (a Train link, the
// repertoire's own Train action) must not silently widen to every active
// repertoire, and a mixed queue stays mixed. An explicit request always wins.
export function queueRepertoireForStart({ requested = null, current = null, fresh = false } = {}) {
  if (requested) return requested;
  if (!fresh) return null;
  if (current && !current.mixed && current.repertoireId) return current.repertoireId;
  return null;
}
