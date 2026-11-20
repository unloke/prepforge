export function createAnalysisStudySaver({ save, onError, delay = 400 }) {
  const entries = new Map();
  function write(entry) {
    clearTimeout(entry.timer);
    entry.timer = null;
    entry.running = entry.running.catch(() => {}).then(async () => {
      const pgn = entry.pending;
      if (pgn == null) return;
      await save(entry.gameId, pgn, entry.ownerId);
      if (entry.pending === pgn) entry.pending = null;
    });
    return entry.running;
  }
  return {
    queue(gameId, pgn, ownerId) {
      const key = JSON.stringify([ownerId, gameId]);
      let entry = entries.get(key);
      if (!entry) {
        entry = { gameId, ownerId, running: Promise.resolve() };
        entries.set(key, entry);
      }
      entry.pending = pgn;
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => { void write(entry).catch(onError); }, delay);
    },
    async flush(ownerId) {
      await Promise.all([...entries.values()].filter(entry => entry.ownerId === ownerId).map(write));
    },
  };
}
