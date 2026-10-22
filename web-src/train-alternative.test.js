// Another repertoire move at the drilled position (1.d4 d5 when the card drills
// 1...Nf6) is prep, not a miss: Due and Rehearse both play it, slide it back and
// reopen the same prompt with nothing graded.
import { describe, expect, it, vi } from "vitest";
import { appSource } from "./test-app-source.js";

const source = appSource();
function compile(marker, deps) {
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`not found: ${marker}`);
  const end = source.indexOf("\n}\n", start) + 2;
  return new Function(...Object.keys(deps), `return (${source.slice(start, end)});`)(...Object.values(deps));
}

const FEN = "rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1";

function shared() {
  const board = { setPosition: vi.fn(), setEngineArrow: vi.fn() };
  const deps = {
    appState: { trainHintLevel: 0 },
    boards: { train: board },
    boardAfterMove: vi.fn(async () => ({ board: { fen: "after" } })),
    setTrainBanner: vi.fn(),
    sleep: async () => {},
  };
  deps.answerAlternative = compile("async function answerAlternative(", deps);
  return { deps, board };
}

describe("another repertoire move", () => {
  it("in the Due queue is not graded and the same card stays", async () => {
    const { deps, board } = shared();
    const prompt = {
      kind: "due", fen_before: FEN, expected_uci: "g8f6", expected_san: "Nf6", expected_node_id: "nf6", legal_moves: ["d7d5", "g8f6"],
      target: { alternatives: [{ uci: "d7d5", san: "d5" }] },
    };
    const smart = { prompt, attempt: 1, queue: [], cardIndex: 0 };
    deps.appState.smart = smart;
    const queueTrainAttempt = vi.fn();
    const submit = compile("async function submitSmartMove(", {
      ...deps, clearBlitzTimer: vi.fn(), optimisticBoardMove: vi.fn(async () => {}), startBlitzTimer: vi.fn(), queueTrainAttempt,
    });
    await submit("d7d5");
    expect(queueTrainAttempt).not.toHaveBeenCalled();
    expect(deps.setTrainBanner).toHaveBeenCalledWith("review", "Also in your repertoire", expect.stringContaining("d5"));
    expect(smart.attempt).toBe(1);
    expect(smart.prompt).toBe(prompt);
    expect(board.setPosition).toHaveBeenLastCalledWith(expect.objectContaining({ fen: FEN, legalMoves: prompt.legal_moves }));
    expect(deps.appState.trainBusy).toBe(false);
  });

  it("in Rehearse reopens the prompt the server kept, without counting a miss", async () => {
    const { deps } = shared();
    const prompt = { session_id: "s", fen_before: FEN, expected_move_uci: "g8f6" };
    deps.appState.training = { prompt };
    deps.appState.trainMode = "all_lines";
    deps.appState.trainStats = { mistakes: 0, correct: 0, streak: 3, history: [] };
    const renderTraining = vi.fn(async () => {});
    const submit = compile("async function submitTrainingMove(", {
      ...deps, currentOwnerId: () => "u", optimisticBoardMove: vi.fn(async () => {}), localDateString: () => "2026-10-22",
      trainRecovery: {}, renderTraining, currentTrainingPrompt: () => prompt,
      api: vi.fn(async () => ({ alternative: true, correct: false, played_san: "d5", prompt })),
    });
    await submit("d7d5");
    expect(renderTraining).toHaveBeenCalledWith(prompt, { keepBanner: true });
    expect(deps.appState.trainStats).toEqual({ mistakes: 0, correct: 0, streak: 3, history: [] });
    expect(deps.setTrainBanner).toHaveBeenCalledWith("review", "Also in your repertoire", expect.stringContaining("d5"));
  });
});
