// The Lichess opening Explorer client Build's panel and Train's practice
// opponent share: one client (its cache, request dedup and 429 cooldown live in
// explorer.js), imported on first use so the module stays out of the boot bundle.
export let explorerModule = null;
export let explorerClient = null;
let explorerLoading = null;

export function ensureExplorerClient() {
  explorerLoading ||= import("./explorer.js").then((mod) => {
    explorerModule = mod;
    explorerClient = mod.createExplorerClient({});
    return explorerClient;
  }).catch((error) => {
    explorerLoading = null;
    throw error;
  });
  return explorerLoading;
}
