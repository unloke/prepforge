import { appState } from "./core/state.js";

// The account's repertoire cap, checked before a create or an import opens
// anything: the server's 402 used to arrive after an empty builder was already
// on screen. Returns the message to show, or null when there is room.
export function repertoireLimitMessage(state = appState) {
  const limit = state.account?.repertoireLimit;
  if (limit == null) return null;
  const own = state.repertoireList.filter((rep) => !state.pendingRepDeletes.has(String(rep.id))).length;
  return own >= limit ? `You can keep up to ${limit} repertoires. Delete one to add another.` : null;
}
