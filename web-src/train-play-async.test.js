import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { localBoardAfterMove, localBoardInfo } from "./chess-local.js";
import { pickOpponentReply, playPositionAfterReply, replyReasonNote } from "./train-opponent.js";

const source = readFileSync(new URL("./app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
function compile(marker, deps) {
  const start = source.indexOf(marker);
  const end = source.indexOf("\n}\n", start) + 2;
  return new Function(...Object.keys(deps), `return (${source.slice(start, end)});`)(...Object.values(deps));
}
function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}
const FEN = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
const STATS = { totalGames: 100, moves: [{ uci: "e7e5", total: 100, share: 1 }] };
function harness() {
  const play = { active: true, book: "explorer", fen: FEN, ply: 0, history: [] };
  const appState = { play };
  const board = { fen: FEN, setPosition(next) { Object.assign(this, next); } };
  const banner = { title: "Opponent thinking…" };
  const explorer = deferred();
  const deps = {
    appState, boards: { train: board }, boardInfo: async (fen) => localBoardInfo(fen),
    boardAfterMove: async (fen, uci) => localBoardAfterMove(fen, uci),
    fetchPlayExplorer: vi.fn(() => explorer.promise), fetchPlayMaia: vi.fn(async () => []),
    pickOpponentReply, playPositionAfterReply, replyReasonNote,
    playRepertoireReplies: () => [], playChildren: () => [], playBookLabel: () => "Explorer",
    playAdvanceNode: () => ({}), playCursorSnapshot: () => ({}),
    recordPlayPly: (ply) => appState.play.history.push(ply),
    setTrainBanner: (state, title) => { banner.title = title; },
    paintPlayPosition: (next) => { board.setPosition(next); banner.title = next.banner; },
    updateTrainTurnBadge: vi.fn(), syncTrainSessionControls: vi.fn(),
  };
  const reply = compile("async function playOpponentReply(", deps);
  return { play, appState, board, banner, explorer, deps, reply };
}

describe("Play opponent response ownership", () => {
  it("only applies the latest of overlapping replies for the same position", async () => {
    const h = harness();
    const newerExplorer = deferred();
    h.deps.fetchPlayExplorer.mockImplementationOnce(() => h.explorer.promise)
      .mockImplementationOnce(() => newerExplorer.promise);
    const first = h.reply();
    await vi.waitFor(() => expect(h.deps.fetchPlayExplorer).toHaveBeenCalledTimes(1));
    const second = h.reply();
    await vi.waitFor(() => expect(h.deps.fetchPlayExplorer).toHaveBeenCalledTimes(2));
    h.explorer.resolve(STATS);
    await first;
    expect(h.play.history).toEqual([]);
    expect(h.board.fen).toBe(FEN);
    newerExplorer.resolve(STATS);
    await second;
    expect(h.play.history).toHaveLength(1);
    expect(h.play.ply).toBe(1);
    expect(h.board.fen).toBe(localBoardAfterMove(FEN, "e7e5").board.fen);
  });

  it.each(["restart", "resign", "takeback"])("drops an Explorer reply after %s", async (action) => {
    const h = harness();
    const pending = h.reply();
    await vi.waitFor(() => expect(h.deps.fetchPlayExplorer).toHaveBeenCalled());
    if (action === "restart") h.appState.play = { ...h.play, history: [] };
    else if (action === "resign") h.play.active = false;
    else h.play.fen = localBoardAfterMove(FEN, "d7d5").board.fen;
    h.board.fen = "Current board";
    h.banner.title = "Current banner";
    h.explorer.resolve(STATS);
    await pending;
    expect(h.board.fen).toBe("Current board");
    expect(h.banner.title).toBe("Current banner");
    expect(h.appState.play.history).toEqual([]);
    expect(h.play.ply).toBe(0);
  });

  it("drops a Maia reply when the session ends during inference", async () => {
    const h = harness();
    const maia = deferred();
    h.deps.fetchPlayMaia.mockImplementation(() => maia.promise);
    const pending = h.reply();
    h.explorer.resolve({ totalGames: 0, moves: [] });
    await vi.waitFor(() => expect(h.deps.fetchPlayMaia).toHaveBeenCalled());
    h.play.active = false;
    h.banner.title = "Resigned";
    maia.resolve([{ move_uci: "e7e5", probability: 1 }]);
    await pending;
    expect(h.banner.title).toBe("Resigned");
    expect(h.board.fen).toBe(FEN);
    expect(h.play.history).toEqual([]);
  });
});
