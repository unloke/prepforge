import { describe, expect, it, vi } from "vitest";
import { createPlayMoveHandler } from "./train-play-input.js";
import { localBoardAfterMove } from "./chess-local.js";
import { START_FEN } from "./train-play.js";

function harness(fen = START_FEN, userColor = "white") {
  const play = { fen, active: true, userColor, history: [], ply: 0 };
  const board = { setPremove: vi.fn(), setPosition: vi.fn() };
  const deps = {
    appState: { play }, boards: { train: board }, advanceNode: () => ({}),
    recordPly: (ply) => play.history.push(ply), cursorSnapshot: () => ({}),
    endGame: vi.fn(), opponentReply: vi.fn(async () => {}),
  };
  return { play, board, deps, submit: createPlayMoveHandler(deps) };
}

describe("Practice input ownership", () => {
  it("lands a legal move immediately, before the opponent returns", async () => {
    const h = harness();
    const pending = h.submit("e2e4");
    expect(h.play.history.map((ply) => ply.uci)).toEqual(["e2e4"]);
    expect(h.board.setPosition).toHaveBeenCalledWith(expect.objectContaining({ lastMove: "e2e4" }));
    await pending;
  });
  it("queues the player's next move without moving the opponent's pieces", async () => {
    const fen = localBoardAfterMove(START_FEN, "e2e4").board.fen;
    const h = harness(fen);
    await h.submit("e7e5");
    expect(h.board.setPremove).not.toHaveBeenCalled();
    await h.submit("g1f3");
    expect(h.play.premove).toBe("g1f3");
    expect(h.play.fen).toBe(fen);
    expect(h.play.history).toEqual([]);
    expect(h.deps.opponentReply).not.toHaveBeenCalled();
  });
  it("silently ignores illegal moves and ended games", async () => {
    const h = harness();
    await h.submit("e2e5");
    h.play.active = false;
    await h.submit("e2e4");
    expect(h.play.history).toEqual([]);
    expect(h.board.setPosition).not.toHaveBeenCalled();
  });
  it("preserves underpromotion in the game history", async () => {
    const h = harness("8/P6k/8/8/8/8/6K1/8 w - - 0 1");
    await h.submit("a7a8n");
    expect(h.play.history[0]).toMatchObject({ uci: "a7a8n", san: "a8=N" });
  });
});
