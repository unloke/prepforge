import { expect, it, vi } from "vitest";
import { playRehearsalRunIn } from "./train-rehearsal.js";

const START = "start", AFTER_E4 = "e4", AFTER_E5 = "e5", AFTER_NF3 = "nf3", AFTER_NC6 = "nc6";
const run = (...steps) => steps.map(([uci, fen]) => ({ uci, san: uci, fen_after: fen }));

function harness(prompt, fen = START) {
  const positions = [];
  const board = { fen, setPosition: (p) => { positions.push(p); board.fen = p.fen; } };
  const training = { prompt };
  const state = { training, smart: null, trainBusy: false };
  return { board, state, positions, deps: { sleep: async () => {}, setTrainBanner: vi.fn() } };
}

it("plays a new line's known moves before asking, then not again after a miss", async () => {
  // Line 2 of a run: 1.e4 was asked on line 1, so it plays itself here.
  const prompt = { target_index: 0, start_fen: START, fen_before: AFTER_NC6,
    run_in: run(["e2e4", AFTER_E4], ["e7e5", AFTER_E5], ["g1f3", AFTER_NF3], ["b8c6", AFTER_NC6]) };
  const h = harness(prompt, "somewhere-else");
  expect(await playRehearsalRunIn(h.board, h.state, prompt, h.deps)).toBe(true);
  expect(h.positions.map((p) => p.fen)).toEqual([START, AFTER_E4, AFTER_E5, AFTER_NF3, AFTER_NC6]);
  expect(h.state.trainBusy).toBe(false);
  h.board.fen = "after-a-wrong-move";
  h.positions.length = 0;
  await playRehearsalRunIn(h.board, h.state, prompt, h.deps);
  expect(h.positions).toEqual([]);
});

it("stops when the session moves on mid-animation", async () => {
  const prompt = { target_index: 0, start_fen: START, fen_before: AFTER_E5, run_in: run(["e2e4", AFTER_E4], ["e7e5", AFTER_E5]) };
  const h = harness(prompt, "elsewhere");
  h.deps.sleep = async () => { h.state.training = null; };
  expect(await playRehearsalRunIn(h.board, h.state, prompt, h.deps)).toBe(false);
});
