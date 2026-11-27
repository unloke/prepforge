// ‹ Train / Home saves drill progress first. When that save fails the drill
// stays open and says why, instead of the button silently doing nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDocument, setup } from "./train-home.fixture.js";
import { createTrainHome } from "./train-home.js";
import { provideApp } from "../core/app-context.js";
import { notices } from "../core/state.js";
vi.mock("../core/api.js", async (orig) => ({ ...await orig(), api: vi.fn(), localDateString: vi.fn() }));
vi.mock("../train-play.js", async (orig) => ({ ...await orig(), confirmAbandonGame: vi.fn() }));
vi.mock("./train-session.js", () => import("./train-session.fixture.js"));
vi.mock("../account-entry.js", async (orig) => ({ ...await orig(), requireSignIn: vi.fn() }));
vi.mock("../train-banner.js", () => ({ setTrainBanner: vi.fn(), updateTrainTurnBadge: vi.fn() }));

beforeEach(() => vi.stubGlobal("document", fakeDocument()));
afterEach(() => vi.unstubAllGlobals());

describe("‹ Train with unsaved progress", () => {
  it("stays on a drill whose progress did not save, and says why", async () => {
    const smart = { prompt: {} };
    const { appState, deps } = setup({ currentView: "train", trainMode: "smart", smart, trainEntryVersion: 4 });
    provideApp({ persistence: { flushTrainSync: vi.fn(async () => false) } });
    const status = vi.spyOn(notices, "status").mockImplementation(() => {});
    await createTrainHome(deps).leaveToHome();
    expect(appState.smart).toBe(smart);
    expect(appState.trainEntryVersion).toBe(4);
    expect(deps.resetTrainBoardIdle).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith("Couldn't save your progress yet. Try again in a moment.", { tone: "error" });
    status.mockRestore();
  });

});
