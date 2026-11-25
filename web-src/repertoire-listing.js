let latest = null;
let inflight = null;

export function fetchRepertoireListing(api, owner, generation, joinInFlight = false) {
  const key = `${owner || "guest"}:${generation || 0}`;
  if (joinInFlight && inflight?.key === key) return inflight.promise;
  const request = { key, promise: null };
  latest = request;
  inflight = request;
  request.promise = (async () => {
    const payload = await api("/api/repertoires");
    if (latest === request) return payload;
    if (latest?.key === key) return latest.promise;
    return null;
  })().finally(() => {
    if (inflight === request) inflight = null;
  });
  return request.promise;
}
