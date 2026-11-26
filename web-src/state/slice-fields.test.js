import { expect, it } from "vitest";
import { appState, analysisState, buildState, replayState, settingsState, teamsState, trainState } from "../core/state.js";
import { SLICE_FIELDS, ownerName } from "./slice-fields.fixture.js";
import { asSlices } from "./as-slices.fixture.js";

const SLICES = { analysisState, buildState, replayState, settingsState, teamsState, trainState };

it("lists every field each slice starts with under that slice, and none under the shell", () => {
  for (const [name, slice] of Object.entries(SLICES)) {
    for (const field of Object.keys(slice)) expect([field, ownerName(field)]).toEqual([field, name]);
  }
  for (const field of Object.keys(appState)) expect([field, ownerName(field)]).toEqual([field, "appState"]);
  expect(Object.keys(SLICE_FIELDS).sort()).toEqual(Object.keys(SLICES).sort());
});

it("asSlices gives each slice only its own fields, so the wrong slice fails loudly", () => {
  const state = { signedIn: true, replaySection: "games", trainMode: "smart" };
  const slices = asSlices(state);
  expect({ ...slices.appState }).toEqual({ signedIn: true });
  expect({ ...slices.replayState }).toEqual({ replaySection: "games" });
  expect(slices.appState.replaySection).toBeUndefined();
  expect(() => { slices.appState.replaySection = "scout"; }).toThrow(/belongs to replayState/);
  slices.replayState.replaySection = "scout";
  expect(state.replaySection).toBe("scout");
});
