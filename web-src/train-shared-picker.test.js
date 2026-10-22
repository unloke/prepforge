// One picker for every Train row lists the user's own active repertoires, then
// the ones shared with them, so a shared repertoire is drilled on the user's
// own progress like theirs. A repertoire with nothing to train is listed but
// cannot be picked.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { trainRepertoireItems } from "./train-picker.js";
import { fakeDocument, setup } from "./controllers/train-home.fixture.js";
import { createTrainHome, loadTrainRepertoireOptions } from "./controllers/train-home.js";

const state = {
  pendingRepDeletes: new Set(["gone"]),
  repertoireList: [
    { id: "mine-1", name: "KP", color: "white", is_active: true, health: { trainable: 5 } },
    { id: "empty", name: "New repertoire", color: "white", is_active: true, health: { trainable: 0 } },
    { id: "off", name: "Shelved", color: "black", is_active: false },
    { id: "gone", name: "Deleting", color: "white", is_active: true },
  ],
  sharedRepertoireList: [{ id: "shared-1", name: "Coach's Sicilian", color: "black", role: "view" }],
};

describe("the Train repertoire picker", () => {
  it("lists own active repertoires first, then the shared ones in their own group", () => {
    const items = trainRepertoireItems(state);
    expect(items.map((item) => [item.id, item.group])).toEqual([
      ["mine-1", ""], ["empty", ""], ["shared-1", "Shared with you"],
    ]);
    expect(items[2]).toMatchObject({ label: "Coach's Sicilian", color: "black", disabled: false });
  });

  it("shows an empty repertoire as unpickable instead of hiding it", () => {
    expect(trainRepertoireItems(state).find((item) => item.id === "empty")).toMatchObject({ disabled: true, sub: "0 to train" });
  });

  it("the practice opponent picks from the user's own repertoires only", () => {
    expect(trainRepertoireItems(state, { shared: false }).map((item) => item.id)).toEqual(["mine-1", "empty"]);
  });
});

describe("loading Train's repertoires", () => {
  let doc;
  beforeEach(() => { doc = fakeDocument(); vi.stubGlobal("document", doc); });
  afterEach(() => vi.unstubAllGlobals());

  it("keeps a rehearsal picked from a share and names it on Home", async () => {
    const { appState, deps } = setup({ repertoireList: [], sharedRepertoireList: [], trainingRepertoireId: "shared-1", currentView: "train" });
    deps.api.mockImplementation(async (url) => url === "/api/repertoires"
      ? { repertoires: [{ id: "mine-1", name: "KP", color: "white", is_active: true }], shared: [{ id: "shared-1", name: "Coach's Sicilian", color: "black" }] }
      : { next_session: { cards: 1, new: 1 } });
    createTrainHome(deps);
    await loadTrainRepertoireOptions();
    expect(appState.sharedRepertoireList).toHaveLength(1);
    await vi.waitFor(() => expect(doc.getElementById("train-rehearse-scope").child.textContent).toBe("Coach's Sicilian"));
    expect(appState.trainingRepertoireId).toBe("shared-1");
  });

  it("drops a Due scope whose repertoire is no longer there", async () => {
    const { appState, deps } = setup({ trainScope: { repertoireId: "lost", label: "Lost" }, currentView: "train" });
    deps.api.mockImplementation(async (url) => url === "/api/repertoires"
      ? { repertoires: [{ id: "mine-1", name: "KP", is_active: true }], shared: [] } : {});
    createTrainHome(deps);
    await loadTrainRepertoireOptions();
    expect(appState.trainScope).toEqual({ repertoireId: null, label: "All repertoires" });
  });
});
