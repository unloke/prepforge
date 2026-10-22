import { appState, boards, notices } from "./core/state.js";
import { BROWSER_ENGINE_UNAVAILABLE, currentOwnerId, postJson, setStatusError } from "./core/api.js";
import { effectiveMaiaRating, effectiveStockfishDepth } from "./core/prefs.js";
import { showConfirmModal } from "./core/modals.js";
import { isBuildReadOnly } from "./build-entry.js";
import { isBrowserEngineAvailable } from "./engine/stockfish-provider.js";
import { getSharedMaia3Provider } from "./engine/maia3-provider.js";
import { classifySyncError } from "./sync-errors.js";

// Coverage, the Build inspector's second tool: the lazy controller, the scan
// button, and the reply preview run that fills the gaps. The shell wires the
// header controls; this module owns what they drive.

let selectBuildNode, hardFlushBuild, captureBuildContext, hydrateBuild, trainRepertoire,
  preloadBuildGen;

export function createCoverage(deps) {
  ({ selectBuildNode, hardFlushBuild, captureBuildContext, hydrateBuild, trainRepertoire,
    preloadBuildGen } = deps);
  return { ensureCoverageView, runCoverageScanUI, previewCoverageReplies,
    get coverageView() { return coverageView; } };
}

// ----- Coverage workbench (Build inspector) ------------------------------------
export let coverageView = null;
let coverageViewReady = null;

export function ensureCoverageView() {
  if (!coverageViewReady) {
    coverageViewReady = import("./controllers/coverage.js").then(({ createCoverageController }) => {
      coverageView = createCoverageController({
        getContext: () => ({ build: appState.build, ownerId: currentOwnerId(),
          ownerGeneration: appState.ownerGeneration, rating: effectiveMaiaRating(),
          selectedNodeId: appState.buildCurrentNodeId, readOnly: isBuildReadOnly() }),
        getProvider: () => getSharedMaia3Provider(), selectNode: selectBuildNode, getBoard: () => boards.build,
        previewReplies: previewCoverageReplies, getJob: () => notices,
        onError: (error) => setStatusError(error.message),
      });
      return coverageView;
    }).catch((error) => { coverageViewReady = null; throw error; });
  }
  return coverageViewReady;
}

export async function runCoverageScanUI() {
  try { await (await ensureCoverageView()).scan(); }
  catch (error) { setStatusError(error.message); }
}

export async function previewCoverageReplies(gaps, options) {
  const owner = currentOwnerId(), generation = appState.ownerGeneration;
  const mod = await import("./controllers/coverage-replies.js");
  if (owner !== currentOwnerId() || generation !== appState.ownerGeneration || !options.isValid()) return;
  return mod.previewCoverageReplies(gaps, options, {
    isBuildReadOnly, isBrowserEngineAvailable, unavailableMessage: BROWSER_ENGINE_UNAVAILABLE,
    notices, hardFlushBuild, captureBuildContext, getBuild: () => appState.build,
    effectiveMaiaRating, effectiveStockfishDepth, getGenerator: () => preloadBuildGen(),
    getProvider: getSharedMaia3Provider, showConfirmModal, postJson, classifySyncError,
    hydrateBuild, trainRepertoire,
  });
}

