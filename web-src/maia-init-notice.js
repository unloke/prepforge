// One progress/failure notice for every caller that can trigger Maia's
// ~46 MB cold init. Analyze/Build have job cards of their own; these callers
// do not, so this keeps the download visible and retryable in one place.
export const MAIA_INIT_NOTICE_KEY = "maia-init";

export function maiaInitMessage({ phase, loaded, total } = {}) {
  if (phase === "download") {
    const pct = total ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
    return `Downloading Maia model · ${pct}%`;
  }
  if (phase === "cache") return "Loading Maia model from cache";
  if (phase === "verify") return "Verifying Maia model";
  if (phase === "session") return "Starting Maia engine";
  return null;
}

export function watchMaiaInit(provider, { notices, onRetry } = {}) {
  if (!provider || typeof provider.subscribeInitProgress !== "function") return () => {};
  let failed = false;
  let card = null;
  const stop = provider.subscribeInitProgress((progress) => {
    const message = maiaInitMessage(progress);
    if (message) {
      card = notices?.show(message, {
        key: MAIA_INIT_NOTICE_KEY,
        tone: "info",
        duration: 0,
      });
    }
  });
  const fail = (error) => {
    failed = true;
    stop();
    notices?.show(error?.message || "Maia could not start.", {
      key: MAIA_INIT_NOTICE_KEY,
      tone: "error",
      actions: onRetry
        ? [{ label: "Retry", primary: true, onClick: onRetry }]
        : undefined,
    });
  };
  const succeed = () => {
    if (failed) return;
    stop();
    card?.dismiss();
  };
  return Object.assign(() => stop(), { fail, succeed });
}
