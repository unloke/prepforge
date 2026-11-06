import { appState } from "./core/state.js";

// The account's repertoire cap, checked before a create or an import opens
// anything: the server's 402 used to arrive after an empty builder was already
// on screen. Returns the message to show, or null when there is room.
export function repertoireLimitMessage(state = appState) {
  const limit = state.account?.repertoireLimit;
  if (limit == null) return null;
  const list = state.repertoireList || [];
  const deletes = state.pendingRepDeletes || new Set();
  const own = list.length || state.account?.repertoireCount == null
    ? list.filter((rep) => !deletes.has(String(rep.id))).length
    : Math.max(0, state.account.repertoireCount - deletes.size);
  return own >= limit ? `${own} / ${limit} repertoires — delete one to add another.` : null;
}
