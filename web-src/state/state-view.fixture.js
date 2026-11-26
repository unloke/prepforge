// Test helper: one object that reads and writes the shell state and every feature
// slice by field, for tests that set up or inspect state across features at once.
// The field lists mirror the slices in web-src/state/.
import { appState, analysisState, buildState, replayState, settingsState, teamsState, trainState } from "../core/state.js";

const SLICE_FIELDS = {
  analysisState: ["analysis", "analysisBoardFen", "analysisCurrentNodeId", "analysisFileSeq", "analysisJobId", "analysisMultiPgn", "analysisNodePath", "analysisPgnStale", "analysisPly", "analysisPolling", "analysisRecoverySeq", "analysisRetryCheckpoint", "analysisSaveInFlight", "analysisSourcePgn", "analysisTree", "analysisUnsavedCheckpoint", "analysisVarCounter", "analysisVarNodes", "evalChartPoints", "explainContext", "pendingAnalysisDeletes"],
  buildState: ["build", "buildAddedIds", "buildAnnotationSlots", "buildAnnotationsSaving", "buildBranchChoiceId", "buildCurrentNodeId", "buildFlushTimer", "buildFlushing", "buildGenerationPreview", "buildIdMap", "buildJustAddedId", "buildLoadRequest", "buildLoadTarget", "buildLoading", "buildMutationSaving", "buildNodeById", "buildOpeningByFen", "buildPending", "buildPendingDeletes", "buildSyncRetry", "buildSyncState", "buildTmpCounter", "buildUndoCommitByMove", "buildUndoDeletes"],
  replayState: ["replayCheckToken", "replayFilter", "replayOpen", "replayResults", "replaySection"],
  settingsState: ["settings", "settingsReadSeq", "settingsRequestSeq", "settingsSaving"],
  teamsState: ["selectedTeamId", "teams", "teamsCache", "teamsRequestSeq"],
  trainState: ["blitzTimer", "lastLuckyFen", "luckyBusy", "luckyRun", "play", "playBook", "playRepertoireIds", "playRepertoirePreferenceKey", "playStartToken", "playStarting", "smart", "trainAttempt", "trainBusy", "trainEntering", "trainEntryVersion", "trainHintInfo", "trainHintLevel", "trainHomeReady", "trainMode", "trainPendingRoute", "trainRejected", "trainRepertoireOptionsError", "trainResult", "trainScope", "trainStartToken", "trainStarting", "trainStats", "trainSync", "trainSyncState", "training", "trainingRepertoireId"],
};
const SLICES = { analysisState, buildState, replayState, settingsState, teamsState, trainState };
const OWNER = new Map(Object.entries(SLICE_FIELDS).flatMap(([slice, fields]) => fields.map((f) => [f, SLICES[slice]])));
const ownerOf = (key) => OWNER.get(key) || appState;

export const stateView = new Proxy({}, {
  get: (_, key) => ownerOf(key)[key],
  set: (_, key, value) => { ownerOf(key)[key] = value; return true; },
  has: (_, key) => key in ownerOf(key),
  deleteProperty: (_, key) => delete ownerOf(key)[key],
});

// Empties the shell state and every slice, then sets `fields` on their owners.
export function resetState(fields = {}) {
  for (const target of [appState, ...Object.values(SLICES)]) {
    for (const key of Object.keys(target)) delete target[key];
  }
  for (const [key, value] of Object.entries(fields)) stateView[key] = value;
  return stateView;
}
