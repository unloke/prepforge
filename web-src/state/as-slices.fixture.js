// Test helper for code that now takes the shell state and its feature slices as
// separate injected objects: one plain test object stands in for all of them, so
// a test that sets or reads a field sees it wherever the code under test looks.
export const SLICE_NAMES = ["analysisState", "buildState", "replayState", "settingsState", "teamsState", "trainState"];

export function asSlices(state) {
  const out = { appState: state };
  for (const name of SLICE_NAMES) out[name] = state;
  return out;
}
