// The app shell's own entry points, for the controllers app.js lazy-loads.
//
// Shared state and services live in their own modules (core/state.js,
// core/api.js, board/ui.js, ...) and controllers import them from there. What
// is left are the functions app.js itself owns — switching views, the sign-in
// gate, URL sync, the lazy-session wrappers. app.js registers them once at
// boot with provideApp(); a controller imports the names it calls. Each export
// forwards to the registered function at call time, so nothing is copied into
// module state, and a test registers its fakes the same way.

const app = {};

export function provideApp(entries) {
  Object.assign(app, entries);
}

const forward = (name) => (...args) => app[name](...args);

export const accountService = forward("accountService");
export const captureBuildContext = forward("captureBuildContext");
export const flushTrainSync = forward("flushTrainSync");
export const hardFlushBuild = forward("hardFlushBuild");
export const hideAnalysisHandoff = forward("hideAnalysisHandoff");
export const hydrateBuild = forward("hydrateBuild");
export const lichessAccounts = forward("lichessAccounts");
export const loadPgnIntoAnalyze = forward("loadPgnIntoAnalyze");
export const markTrainPositionDirty = forward("markTrainPositionDirty");
export const openAuthModal = forward("openAuthModal");
export const orientAnalysisFromPgn = forward("orientAnalysisFromPgn");
export const queueTrainAttempt = forward("queueTrainAttempt");
export const refreshAuthStatus = forward("refreshAuthStatus");
export const refreshDashboardRepertoires = forward("refreshDashboardRepertoires");
export const refreshRepertoireHead = forward("refreshRepertoireHead");
export const requireSignIn = forward("requireSignIn");
export const resetAnalysisVariations = forward("resetAnalysisVariations");
export const revealAnalysisResults = forward("revealAnalysisResults");
export const runAnalysis = forward("runAnalysis");
export const setTrainBanner = forward("setTrainBanner");
export const showAnalysisPly = forward("showAnalysisPly");
export const startLichessOAuth = forward("startLichessOAuth");
export const switchView = forward("switchView");
export const syncViewHeads = forward("syncViewHeads");
export const syncWorkspaceUrl = forward("syncWorkspaceUrl");
export const updateTrainTurnBadge = forward("updateTrainTurnBadge");
