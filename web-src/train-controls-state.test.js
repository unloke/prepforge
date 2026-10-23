// Train's controls exist only where they work: the board bar carries Hint and
// Skip during a drill, Takeback and Resign during a game, and nothing on Home.
// Nothing is ever left on screen disabled for "wrong mode". A guest's rows say
// what unlocks them instead of going dead.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDocument, setup } from "./controllers/train-home.fixture.js";
import { createTrainHome } from "./controllers/train-home.js";

let doc;
beforeEach(() => {
  doc = fakeDocument();
  vi.stubGlobal("document", doc);
});
afterEach(() => vi.unstubAllGlobals());

const shown = (id) => !doc.getElementById(id).hidden;
const bar = () => ({
  hint: shown("train-hint"), skip: shown("train-skip"),
  takeback: shown("play-takeback"), resign: shown("play-resign"), analyze: shown("play-analyze"),
});

function screen(state) {
  const { deps } = setup({ currentView: "train", ...state });
  createTrainHome(deps).syncTrainScreen();
  return doc.getElementById("view-train").dataset.trainScreen;
}

describe("the board bar's action slot", () => {
  it("is empty on Home", () => {
    expect(screen({ trainMode: "smart" })).toBe("home");
    expect(bar()).toEqual({ hint: false, skip: false, takeback: false, resign: false, analyze: false });
  });

  it("holds Hint and Skip during a drill", () => {
    expect(screen({ trainMode: "smart", smart: { prompt: {} } })).toBe("session");
    expect(bar()).toEqual({ hint: true, skip: true, takeback: false, resign: false, analyze: false });
    expect(screen({ trainMode: "all_lines", training: { prompt: {} } })).toBe("session");
    expect(bar()).toEqual({ hint: true, skip: true, takeback: false, resign: false, analyze: false });
  });

  it("holds Takeback and Resign during a game", () => {
    expect(screen({ trainMode: "play", play: { active: true, history: [] } })).toBe("session");
    expect(bar()).toEqual({ hint: false, skip: false, takeback: true, resign: true, analyze: false });
  });

  it("offers Analyze game only on a finished game that has moves", () => {
    expect(screen({ trainMode: "play", play: { active: false, history: [{ uci: "e2e4" }] } })).toBe("result");
    expect(bar().analyze).toBe(true);
    screen({ trainMode: "play", play: { active: false, history: [] } });
    expect(bar().analyze).toBe(false);
    screen({ trainMode: "smart", trainResult: { mode: "smart" } });
    expect(bar().analyze).toBe(false);
  });

  it("shows exactly one of Home, the session card and the result card", () => {
    for (const [state, visible] of [
      [{ trainMode: "smart" }, "train-home"],
      [{ trainMode: "smart", trainStarting: true }, "train-progress-panel"],
      [{ trainMode: "smart", trainResult: { mode: "smart" } }, "train-summary"],
    ]) {
      screen(state);
      expect(["train-home", "train-progress-panel", "train-summary"].filter(shown)).toEqual([visible]);
    }
  });
});

describe("Home rows", () => {
  it("a guest's drill rows lead to sign-in and stay pressable; Practice still plays", async () => {
    const { deps } = setup({ signedIn: false, repertoireList: [], sharedRepertoireList: [] });
    await createTrainHome(deps).paintTrainHome();
    for (const id of ["start-train", "start-rehearse"]) {
      expect(doc.getElementById(id).textContent).toBe("Sign in to train");
      expect(doc.getElementById(id).dataset.action).toBe("signin");
      expect(doc.getElementById(id).disabled).toBe(false);
    }
    expect(doc.getElementById("start-play").disabled).toBe(false);
  });

  it("an account with no repertoire is sent to Library rather than shown a dead Start", async () => {
    const { deps } = setup({ repertoireList: [], sharedRepertoireList: [] });
    await createTrainHome(deps).paintTrainHome();
    expect(doc.getElementById("start-train").dataset.action).toBe("library");
    expect(doc.getElementById("start-rehearse").dataset.action).toBe("library");
    expect(doc.getElementById("train-outlook").hidden).toBe(true);
  });

  it("the Due row reads the preview for its own scope and paints Resume from it", async () => {
    const { deps } = setup({ trainScope: { repertoireId: "r1", label: "Italian" } });
    deps.api.mockResolvedValue({ next_session: { cards: 4, resumed: true, left: 2, due: 2 }, outlook: { now: 2, today: 2, week: 3 } });
    await createTrainHome(deps).paintTrainHome();
    expect(deps.api).toHaveBeenCalledWith(expect.stringContaining("summary?repertoire_id=r1&preview=true"));
    expect(doc.getElementById("start-train").textContent).toBe("Resume");
    expect(doc.getElementById("train-due-meta").textContent).toBe("2 cards left");
  });

  it("the Due row lists its next cards, and each narrows the queue to its repertoire", async () => {
    const { deps } = setup({ signedIn: true });
    deps.api.mockResolvedValue({
      next_session: {
        cards: 2, resumed: 0, left: 2, due: 1,
        upcoming: [{ kind: "due", repertoire_id: "r1", repertoire_name: "Italian", color: "white", san: "Nf3", line: "1.e4 e5 2.Nf3" }],
      },
      outlook: { now: 1, today: 1, week: 2 },
    });
    await createTrainHome(deps).paintTrainHome();
    const list = doc.getElementById("train-due-next");
    expect(list.hidden).toBe(false);
    expect(String(list.innerHTML)).toContain("Italian");
    expect(String(list.innerHTML)).toContain('data-repertoire-id="r1"');
    expect(String(list.innerHTML)).toContain("Nf3");
  });

  it("Home says where finished runs will be listed before there is one", async () => {
    const { deps } = setup({ signedIn: true });
    await createTrainHome(deps).paintTrainHome();
    expect(doc.getElementById("train-recent-home").hidden).toBe(false);
    expect(String(doc.getElementById("train-recent-home").innerHTML)).toContain("No finished runs yet");
  });

  it("a repertoire opponent with nothing picked cannot start a game", async () => {
    const { deps } = setup({ playBook: "repertoire", playRepertoireIds: [] });
    await createTrainHome(deps).paintTrainHome();
    expect(doc.getElementById("start-play").disabled).toBe(true);
    expect(doc.getElementById("train-play-reps").hidden).toBe(false);
  });
});
