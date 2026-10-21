// Recovering a line-rehearsal answer whose result the network lost.
//
// POST /api/train/move grades the move AND advances the session in one
// transaction, before the response is written. A dropped response therefore
// leaves the server on the NEXT own move while the client still shows the old
// card; replaying that old answer would grade the new card wrong (and record a
// false miss). An unconfirmed result is reconciled against the server's current
// prompt — a read-only, owner-gated session read — instead of being repainted.

// Only an explicit 4xx proves the request was rejected before it committed
// (auth/CSRF/validation/ownership). No answer at all, or a 5xx, may mean the
// grade is already saved.
export function trainMoveResultUnconfirmed(error) {
  const status = Number(error?.status);
  return !(status >= 400 && status < 500);
}

// A late reconciliation may paint only onto the exact rehearsal it started
// from: same live session, account, owner generation, mode and prompt. A newer
// card, another account, or a mode switch wins.
export function trainRecoveryIsCurrent(
  { training, owner, generation, mode, prompt },
  { appState, currentOwnerId },
) {
  return appState.training === training
    && !appState.smart
    && appState.training?.prompt === prompt
    && (appState.trainMode || "smart") === mode
    && currentOwnerId() === owner
    && appState.ownerGeneration === generation;
}

export function createTrainRecovery(deps) {
  const {
    api, appState, boards, currentOwnerId, notices, setStatus, setStatusError,
    setTrainBanner, syncTrainSessionControls, renderTraining, finishTrainingSession,
  } = deps;

  function stillCurrent(ctx) {
    return !ctx.superseded() && trainRecoveryIsCurrent(ctx, { appState, currentOwnerId });
  }

  // A reconciliation that a newer card (or another account) superseded owns
  // nothing any more — including the lock it took. Releasing only our own lock
  // keeps a live session's card answerable instead of stranding "Checking your
  // answer" over a card the player can no longer play.
  function release(ctx) {
    if (ctx.locked) appState.trainBusy = false;
  }

  async function sync(ctx) {
    let state;
    try {
      state = await api(`/api/train/session/${encodeURIComponent(ctx.prompt.session_id)}`);
    } catch (error) {
      if (!stillCurrent(ctx)) return release(ctx);
      // Still unknown (offline, server down): keep the board locked and offer
      // the retry that resolves it rather than a stale card pretending to wait.
      // One actionable card, not a second status line saying the same thing.
      setTrainBanner("done", "Couldn't confirm that answer", "Retry sync to catch up with the server.");
      ctx.card = notices.show(error.message || "Couldn't reach the server.", {
        tone: "error",
        key: `train-sync:${ctx.prompt.session_id}`,
        actions: [{
          label: "Retry sync",
          primary: true,
          closeOnClick: false,
          onClick: () => { if (stillCurrent(ctx)) void sync(ctx); },
        }],
      });
      return;
    }
    if (!stillCurrent(ctx)) return release(ctx);
    ctx.card?.dismiss();
    appState.trainBusy = false;
    setStatus("Caught up with the server.");
    if (state.prompt) await renderTraining(state.prompt);
    else finishTrainingSession();
  }

  // One place for a failed rehearsal answer. A rejection the server answered is
  // provably unapplied, so the same card comes back; anything else may already
  // be saved, so the server's current prompt wins before the board reopens.
  async function recoverAnswer(error, prompt, superseded) {
    // A newer card already won: never paint this answer's lock over it.
    if (superseded()) return;
    if (trainMoveResultUnconfirmed(error)) {
      // Lock the board while the authority is unknown: no "Your move" over a
      // card the server may already have advanced past, and no second answer.
      appState.trainBusy = true;
      boards.train.setEngineArrow(null);
      setTrainBanner("move", "Checking your answer", "");
      syncTrainSessionControls();
      await sync({
        prompt,
        training: appState.training,
        owner: currentOwnerId(),
        generation: appState.ownerGeneration,
        mode: appState.trainMode,
        superseded,
        locked: true,
      });
      return;
    }
    // The answer was not graded, so the card is still the same one: put the
    // board back on the position it asks about and let the player answer again.
    // Without this the optimistic move stayed on a locked board (legalMoves: [])
    // under a "Your move" banner — a rehearsal the player could not continue.
    boards.train.setPosition({
      fen: prompt.fen_before,
      legalMoves: prompt.legal_moves || [],
      lastMove: null,
    });
    setTrainBanner("move", "Your move", "That answer didn't save. Play it again.");
    setStatusError(error.message);
    syncTrainSessionControls();
  }

  return { recoverAnswer };
}
