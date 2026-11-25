import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDocument, setup } from "./controllers/train-home.fixture.js";
import { openTrain, syncTrainScreen } from "./controllers/train-home.js";
import { appState } from "./core/state.js";
import { appSource } from "./test-app-source.js";

vi.mock("./core/api.js", async (orig) => ({ ...await orig(), api: vi.fn(), localDateString: vi.fn() }));
vi.mock("./train-play.js", async (orig) => ({ ...await orig(), confirmAbandonGame: vi.fn() }));
vi.mock("./controllers/train-session.js", () => import("./controllers/train-session.fixture.js"));

const source = appSource();
function compileCancel() {
  const start = source.indexOf("function cancelStaleTrainStart(");
  const body = source.slice(start, source.indexOf("\n", start) + 1);
  return new Function("appState", "setTrainBanner", "syncTrainSessionControls", `${body}; return cancelStaleTrainStart;`)(appState, vi.fn(), syncTrainScreen);
}

describe("canceled Train starts", () => {
  let doc;
  beforeEach(() => {
    doc = fakeDocument();
    vi.stubGlobal("document", doc);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("returns the screen to a usable Home and can start training again", async () => {
    const { deps } = setup({ currentView: "train", trainMode: "smart" });
    const token = {};
    appState.trainStarting = true;
    appState.trainStartToken = token;
    syncTrainScreen();
    expect(doc.getElementById("view-train").dataset.trainScreen).toBe("session");

    compileCancel()({ entryToken: token });

    expect(appState.trainStarting).toBe(false);
    expect(appState.trainStartToken).toBeNull();
    expect(doc.getElementById("view-train").dataset.trainScreen).toBe("home");
    await vi.waitFor(() => expect(doc.getElementById("start-train").attributes.inert).toBeUndefined());
    expect(doc.getElementById("start-train").disabled).toBe(false);

    await openTrain({ mode: "smart", repertoireId: "r1" });
    expect(deps.startTraining).toHaveBeenCalledWith("smart", expect.objectContaining({ repertoireId: "r1" }));
    expect(deps.startTraining.mock.calls[0][1].entryToken).toBe(appState.trainStartToken);
    expect(appState.trainStarting).toBe(true);
    expect(doc.getElementById("view-train").dataset.trainScreen).toBe("session");
  });

  it("starts a scoped queue only when leaving the live game is accepted", async () => {
    const { deps } = setup({ currentView: "train", trainMode: "play", play: { active: true, history: ["e2e4"] } });
    deps.confirmAbandonGame.mockResolvedValueOnce(false);
    await expect(openTrain({ mode: "smart", repertoireId: "r1" })).resolves.toBe(false);
    expect(deps.startTraining).not.toHaveBeenCalled();
    expect(appState.play.active).toBe(true);
    deps.confirmAbandonGame.mockResolvedValueOnce(true);
    await expect(openTrain({ mode: "smart", repertoireId: "r1" })).resolves.toBe(true);
    expect(deps.startTraining).toHaveBeenCalledWith("smart", expect.objectContaining({ repertoireId: "r1" }));
    expect(appState.play).toBeNull();
  });

  it("does not clear the replacement start's session state", () => {
    setup({ currentView: "train", trainMode: "smart" });
    const oldToken = {}, replacementToken = {};
    appState.trainStarting = true;
    appState.trainStartToken = replacementToken;
    syncTrainScreen();
    expect(doc.getElementById("view-train").dataset.trainScreen).toBe("session");

    compileCancel()({ entryToken: oldToken });

    expect(appState.trainStarting).toBe(true);
    expect(appState.trainStartToken).toBe(replacementToken);
    expect(doc.getElementById("view-train").dataset.trainScreen).toBe("session");
  });
});
