import { afterEach, describe, expect, it } from "vitest";
import { appState } from "./state.js";
import { effectiveMaiaRating } from "./prefs.js";

describe("a guest's rating from the welcome", () => {
  afterEach(() => { appState.prefs = null; appState.signedIn = false; appState.maiaRatingPinned = null; appState.maiaAutoRating = null; });

  it("stays on this device for a guest and gives way to an account's pin", () => {
    appState.prefs = { maiaRating: 1200 };
    appState.maiaAutoRating = 1800;
    expect(effectiveMaiaRating()).toBe(1200);
    appState.signedIn = true;
    expect(effectiveMaiaRating()).toBe(1800);
    appState.maiaRatingPinned = 2000;
    expect(effectiveMaiaRating()).toBe(2000);
  });
});
