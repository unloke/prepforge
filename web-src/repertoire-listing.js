let inflight = null;

export function fetchRepertoireListing(api, owner, generation, shared = false) {
  if (!shared) return api("/api/repertoires");
  const key = `${owner || "guest"}:${generation || 0}`;
  if (inflight?.key === key) return inflight.promise;
  const request = { key, promise: null };
  request.promise = (async () => api("/api/repertoires"))().finally(() => {
    if (inflight === request) inflight = null;
  });
  inflight = request;
  return request.promise;
}
