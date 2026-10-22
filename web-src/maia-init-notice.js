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

// What a Maia failure means to the user, and the action that clears it. The raw
// worker message (status codes, URLs, hashes) stays for tooltips and logs.
export function maiaErrorText(error) {
  const message = String(error?.message || "");
  const status = /weight fetch (\d{3})/.exec(message)?.[1];
  if (status === "404") return "The Maia model is missing from the model server.";
  if (status) return `The Maia download failed (HTTP ${status}). Retry.`;
  if (/timed out/i.test(message)) return "Maia did not answer in time. Retry.";
  if (/stalled/i.test(message)) return "The Maia download stopped part-way. Retry.";
  if (/sha256 mismatch|size mismatch|truncated|exceeds manifest/i.test(message)) {
    return "The Maia download was incomplete or corrupted. Retry.";
  }
  if (/network|fetch|offline|Failed to/i.test(message)) {
    return "The Maia download failed. Check your connection and retry.";
  }
  return message || "Maia could not start. Retry.";
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
    notices?.show(maiaErrorText(error), {
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
