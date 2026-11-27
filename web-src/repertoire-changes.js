// A repertoire changed. Whoever changed it announces it here; whoever keeps a copy
// of repertoire data subscribes, so the writer never needs to know the readers.
//   { repertoireId, tree }  a fresh /api/build/load payload for that repertoire
//   { repertoireId }        the repertoire changed in a way no payload describes
//                           (enabled, disabled or deleted)
const listeners = new Set();

export function onRepertoireChanged(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function announceRepertoireChanged(change) {
  for (const listener of listeners) listener(change);
}
