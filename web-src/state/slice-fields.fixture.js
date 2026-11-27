// Test helper: which feature slice owns each state field. Mirrors web-src/state/
// (slice-fields.test.js checks every field a slice starts with is listed here);
// a field no slice lists belongs to the shell's appState.
export const SLICE_FIELDS = {
  analysisState: ["analysis", "analysisBoardFen", "analysisCurrentNodeId", "analysisFileSeq", "analysisJobId", "analysisMultiPgn", "analysisNodePath", "analysisPgnStale", "analysisPly", "analysisPolling", "analysisRecoverySeq", "analysisRetryCheckpoint", "analysisSaveInFlight", "analysisSourcePgn", "analysisTree", "analysisUnsavedCheckpoint", "analysisVarCounter", "analysisVarNodes", "evalChartPoints", "explainContext", "pendingAnalysisDeletes"],
  buildState: ["build", "buildAddedIds", "buildAnnotationSlots", "buildAnnotationsSaving", "buildBranchChoiceId", "buildCurrentNodeId", "buildFlushTimer", "buildFlushing", "buildGenerationPreview", "buildIdMap", "buildJustAddedId", "buildLoadRequest", "buildLoadTarget", "buildLoading", "buildMastery", "buildMutationSaving", "buildNodeById", "buildOpeningByFen", "buildPending", "buildPendingDeletes", "buildSyncRetry", "buildSyncState", "buildTmpCounter", "buildUndoCommitByMove", "buildUndoDeletes"],
  replayState: ["replayCheckToken", "replayFilter", "replayOpen", "replayResults", "replaySection"],
  settingsState: ["settings", "settingsReadSeq", "settingsRequestSeq", "settingsSaving"],
  teamsState: ["selectedTeamId", "teams", "teamsCache", "teamsRequestSeq"],
  trainState: ["blitzTimer", "lastLuckyFen", "luckyBusy", "luckyRun", "play", "playBook", "playRepertoireIds", "playRepertoirePreferenceKey", "playStartToken", "playStarting", "smart", "trainAttempt", "trainBusy", "trainEntering", "trainEntryVersion", "trainHintInfo", "trainHintLevel", "trainHomeReady", "trainMode", "trainPendingRoute", "trainRejected", "trainRepertoireOptionsError", "trainResult", "trainScope", "trainStartToken", "trainStarting", "trainStats", "trainSync", "trainSyncState", "training", "trainingRepertoireId"],
};

const OWNER = new Map(Object.entries(SLICE_FIELDS).flatMap(([slice, list]) => list.map((field) => [field, slice])));

// The name of the object that owns `field`: a slice name, or "appState".
export const ownerName = (field) => OWNER.get(field) || "appState";
