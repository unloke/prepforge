// Test helper: one object that reads and writes the shell state and every feature
// slice by field, for tests that set up or inspect state across features at once.
import { appState, analysisState, buildState, replayState, settingsState, teamsState, trainState } from "../core/state.js";
import { ownerName } from "./slice-fields.fixture.js";

const SLICES = { analysisState, buildState, replayState, settingsState, teamsState, trainState };
const ownerOf = (key) => SLICES[ownerName(key)] || appState;

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
