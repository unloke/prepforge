/** Bound the entire request, including CSRF bootstrap and response body reads. */
export async function withRequestDeadline(run, { signal, timeoutMs = 30_000, method = "GET" } = {}) {
  if (signal?.aborted) throw signal.reason;
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal.reason);
  if (signal?.aborted) forwardAbort();
  else signal?.addEventListener("abort", forwardAbort, { once: true });
  const timer = setTimeout(() => {
    const error = new Error(method === "GET" ? "Request timed out — try again" : "Save timed out; result unconfirmed — keep your unsaved work");
    error.name = "RequestTimeoutError";
    error.resultUnconfirmed = method !== "GET";
    controller.abort(error);
  }, timeoutMs);
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(controller.signal.reason);
    if (controller.signal.aborted) onAbort();
    else controller.signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    controller.signal.throwIfAborted();
    return await Promise.race([run(controller.signal), aborted]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", forwardAbort);
    controller.signal.removeEventListener("abort", onAbort);
  }
}
