const pending = new Set();
let passiveInflight = null;

function closeRequest(request) {
  if (request.closed) return false;
  request.closed = true;
  pending.delete(request);
  if (passiveInflight === request) passiveInflight = null;
  return true;
}

function startRepertoireRequest(api, key) {
  const request = { key, closed: false, promise: null, resolve: null, reject: null };
  request.promise = new Promise((resolve, reject) => {
    request.resolve = resolve;
    request.reject = reject;
  });
  pending.add(request);
  (async () => api("/api/repertoires"))().then(
    (payload) => { if (closeRequest(request)) request.resolve(payload); },
    (error) => { if (closeRequest(request)) request.reject(error); },
  );
  return request;
}

function listingKey(owner, generation) {
  return `${owner || "guest"}:${generation || 0}`;
}

export function fetchRepertoireListing(api, owner, generation) {
  const key = listingKey(owner, generation);
  if (passiveInflight?.key === key) return passiveInflight.promise;
  const request = startRepertoireRequest(api, key);
  passiveInflight = request;
  return request.promise;
}

export function refreshRepertoireListing(api, owner, generation) {
  const key = listingKey(owner, generation);
  const refresh = startRepertoireRequest(api, key);
  for (const request of [...pending]) {
    if (request === refresh || request.key !== key) continue;
    if (closeRequest(request)) request.resolve(refresh.promise);
  }
  return refresh.promise;
}
