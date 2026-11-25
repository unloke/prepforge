const pending = new Set();
const adoptedOrders = new Map();
let passiveInflight = null;
let nextOrder = 1;
const REQUEST = Symbol("repertoireListingRequest");

function closeRequest(request) {
  if (request.closed) return false;
  request.closed = true;
  pending.delete(request);
  if (passiveInflight === request) passiveInflight = null;
  return true;
}

function sourceOf(request) {
  let source = request;
  while (source.forward) source = source.forward;
  return source;
}

function startRepertoireRequest(api, key) {
  const request = { key, order: nextOrder++, closed: false, forward: null, promise: null, resolve: null, reject: null };
  request.promise = new Promise((resolve, reject) => {
    request.resolve = resolve;
    request.reject = reject;
  });
  Object.defineProperty(request.promise, REQUEST, { value: request });
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

function requestFor(listing) {
  return listing ? listing[REQUEST] : null;
}

function isStale(request, key) {
  const source = sourceOf(request);
  return source.key !== key || (adoptedOrders.get(key) || 0) > source.order;
}

export function acceptRepertoireListing(listing, owner, generation) {
  const request = requestFor(listing);
  const key = listingKey(owner, generation);
  if (!request || isStale(request, key)) return false;
  const source = sourceOf(request);
  adoptedOrders.set(key, source.order);
  for (const older of [...pending]) {
    if (older.key !== key || sourceOf(older).order >= source.order) continue;
    if (closeRequest(older)) older.resolve(null);
  }
  return true;
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
    if (closeRequest(request)) {
      request.forward = refresh;
      request.resolve(refresh.promise);
    }
  }
  return refresh.promise;
}
