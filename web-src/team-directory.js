// Owner-scoped team names shared by Library and Teams. Empty is a loaded result.
export function loadTeamDirectory(appState, api, { refresh = false } = {}) {
  const owner = appState.accountUserId;
  const generation = appState.ownerGeneration;
  const cache = appState.teamsCache;
  if (!refresh && cache && cache.owner === owner && cache.generation === generation) {
    if (cache.pending) return cache.pending;
    if (cache.loaded) return Promise.resolve(appState.teams);
  }
  const seq = appState.teamsRequestSeq = (appState.teamsRequestSeq || 0) + 1;
  const entry = {owner, generation, loaded:false, pending:null};
  appState.teamsCache = entry;
  entry.pending = (async () => {
    try {
      const payload = await api('/api/teams');
      if (seq !== appState.teamsRequestSeq || owner !== appState.accountUserId || generation !== appState.ownerGeneration) return null;
      appState.teams = payload.teams || [];
      entry.loaded = true;
      return appState.teams;
    } finally { entry.pending = null; }
  })();
  return entry.pending;
}
