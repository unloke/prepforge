// Owner-scoped team names shared by Library and Teams. Empty is a loaded result.
export function loadTeamDirectory(appState, teamsState, api, { refresh = false } = {}) {
  const owner = appState.accountUserId;
  const generation = appState.ownerGeneration;
  const cache = teamsState.teamsCache;
  if (!refresh && cache && cache.owner === owner && cache.generation === generation) {
    if (cache.pending) return cache.pending;
    if (cache.loaded) return Promise.resolve(teamsState.teams);
  }
  const seq = teamsState.teamsRequestSeq = (teamsState.teamsRequestSeq || 0) + 1;
  const entry = {owner, generation, loaded:false, pending:null};
  teamsState.teamsCache = entry;
  entry.pending = (async () => {
    try {
      const payload = await api('/api/teams');
      if (seq !== teamsState.teamsRequestSeq || owner !== appState.accountUserId || generation !== appState.ownerGeneration) return null;
      teamsState.teams = payload.teams || [];
      entry.loaded = true;
      return teamsState.teams;
    } finally { entry.pending = null; }
  })();
  return entry.pending;
}
