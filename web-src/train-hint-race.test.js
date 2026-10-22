import { describe, expect, it, vi } from "vitest";
import { appSource } from "./test-app-source.js";

// Line rehearsal's hint reads /api/train/hint once per position. Clicks made
// while that read was in flight each started their own read and reset the level,
// so three quick clicks showed "Hint 1" instead of the answer.
const source = appSource();
function compile(deps) {
  const start = source.indexOf("async function trainHint(");
  const end = source.indexOf("\n}\n", start) + 2;
  return new Function(...Object.keys(deps), `return (${source.slice(start, end)});`)(...Object.values(deps));
}

describe("Line rehearsal hint", () => {
  it("reveals one level per click while the hint read is in flight", async () => {
    let resolve;
    const postJson = vi.fn(() => new Promise((yes) => { resolve = yes; }));
    const banners = [];
    const appState = { smart: null, training: { prompt: { fen_before: "F", session_id: "s" } }, trainHintInfo: null, trainHintLevel: 0 };
    const trainHint = compile({
      appState, postJson, smartHint: () => {}, setStatus: () => {}, setStatusError: () => {},
      currentTrainingPrompt: () => appState.training.prompt,
      boards: { train: { setEngineArrow: vi.fn() } },
      setTrainBanner: (_state, title) => banners.push(title),
    });
    const clicks = [trainHint(), trainHint(), trainHint()];
    resolve({ strategy: "Centre", piece: "Pawn", expected_san: "e4", expected_uci: "e2e4" });
    await Promise.all(clicks);
    expect(postJson).toHaveBeenCalledTimes(1);
    expect(banners).toEqual(["Hint 1 · Idea", "Hint 2 · Piece", "Hint 3 · Answer"]);
  });
});
