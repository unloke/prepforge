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

// What an accepted Start says in the notice stack, "" when it says nothing.
// The setup brief already named the queue's size and the card head already
// reads "Card 2 / 5", so a fresh start repeats nothing; a resume says the one
// thing neither of those shows.
export function startNotice(resumed) {
  return resumed ? "Picked up your last queue where you left off" : "";
}

// The repertoire a new queue is built for. "New session" means another queue
// like this one: a queue drilled for one repertoire (a Train link, the
// repertoire's own Train action) must not silently widen to every active
// repertoire, and a mixed queue stays mixed. An explicit request always wins.
//
// `current` is the LIVE queue; `previous` is the scope a FINISHED queue left in
// state (finishSmartSession releases appState.smart before its summary paints, so
// the summary's restart has nothing live to read). `state` fences that scope: see
// finishedQueueScopeFor.
export function queueRepertoireForStart({ requested = null, current = null, previous = null, state = null, fresh = false } = {}) {
  if (requested) return requested;
  if (!fresh) return null;
  const scope = current || (state ? finishedQueueScopeFor(previous, state) : previous);
  if (scope && !scope.mixed && (scope.repertoireId || scope.repertoire_id)) {
    return scope.repertoireId || scope.repertoire_id;
  }
  return null;
}

// The scope a finished queue leaves for the next Start: which repertoires it
// drilled, for whom, and under which owner generation.
export function rememberFinishedQueueScope(state, smart) {
  if (!smart) return null;
  return {
    ownerId: state.accountUserId || null,
    generation: state.ownerGeneration,
    mixed: !!smart.mixed,
    repertoireId: smart.repertoireId || null,
  };
}

// That remembered scope, fenced to the state it was remembered in: another
// account, a reloaded generation, or a repertoire deleted/disabled since all
// answer null, so the next Start falls back to the mode's own default instead of
// inheriting a stranger's or a dead repertoire.
export function finishedQueueScopeFor(scope, state = {}) {
  if (!scope || !scope.ownerId || scope.ownerId !== (state.accountUserId || null)) return null;
  if (scope.generation !== state.ownerGeneration) return null;
  if (scope.mixed || !scope.repertoireId) return scope;
  // An empty listing means "not loaded yet", not "gone": the server still owns
  // the real answer. A loaded listing that no longer carries the repertoire as
  // active (deleted, disabled, or waiting on its delete) does answer.
  const listing = Array.isArray(state.repertoireList) ? state.repertoireList : [];
  if (listing.length) {
    const pending = state.pendingRepDeletes || new Set();
    const trainable = listing.some(
      (rep) => String(rep.id) === String(scope.repertoireId)
        && rep.is_active !== false && !pending.has(String(rep.id)),
    );
    if (!trainable) return null;
  }
  return scope;
}
