export function cancellationError() {
  const error = new Error("cancelled");
  error.cancelled = true;
  return error;
}

export function isCancellation(error) {
  return !!error?.cancelled || error?.name === "AbortError";
}

export function throwIfCancelled(signal) {
  if (signal?.aborted) throw cancellationError();
}
