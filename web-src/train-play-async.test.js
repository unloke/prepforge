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
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
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
    playThinkingSub: () => "Explorer → Maia",
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
  it("routes the palette practice action through the New game confirmation button", async () => {
    const click = vi.fn();
    const directStart = vi.fn();
    const run = compile("async function runPaletteItem(", {
      closePalette: vi.fn(), switchView: vi.fn(),
      document: { querySelector: () => ({ click: vi.fn() }), getElementById: () => ({ click }) },
      startPlaySessionTracked: directStart,
    });
    await run({ action: "play-human" });
    expect(click).toHaveBeenCalledTimes(1);
    expect(directStart).not.toHaveBeenCalled();
  });
  function startHarness() {
    const info = deferred();
    const appState = { trainMode: "play" };
    const paint = vi.fn();
    const deps = {
      appState, START_FEN: FEN, playBook: () => "maia", playPickerColor: () => "white",
      resolvePlayColor: () => "white", boardInfo: () => info.promise,
      document: { getElementById: () => ({ hidden: false }) }, boards: { train: { setOrientation: vi.fn() } },
      paintPlayPosition: paint, playBookLabel: () => "Maia", isStartFen: () => true,
      sideToMoveFromFen: () => "white", setStatus: vi.fn(), setStatusError: vi.fn(),
      syncTrainPickerVisibility: vi.fn(), syncTrainSessionControls: vi.fn(), syncWorkspaceUrl: vi.fn(),
      updateTrainTurnBadge: vi.fn(), playOpponentReply: vi.fn(), renderPlayTrail: vi.fn(),
    };
    return { appState, info, paint, deps, start: compile("async function startPlaySession(", deps) };
  }

  it("does not install a practice session after switching modes during Start", async () => {
    const h = startHarness();
    const pending = h.start();
    h.appState.trainMode = "smart";
    h.info.resolve(localBoardInfo(FEN));
    await pending;
    expect(h.appState.play).toBeUndefined();
    expect(h.paint).not.toHaveBeenCalled();
  });

  it("only installs the latest overlapping practice Start", async () => {
    const h = startHarness();
    const first = h.start();
    const second = h.start();
    h.info.resolve(localBoardInfo(FEN));
    await Promise.all([first, second]);
    expect(h.paint).toHaveBeenCalledTimes(1);
  });
  it("does not report a stale Start failure over the newly selected mode", async () => {
    const h = startHarness();
    const pending = h.start();
    h.appState.trainMode = "smart";
    h.info.reject(new Error("old board load failed"));
    await pending;
    expect(h.deps.setStatusError).not.toHaveBeenCalled();
  });
  it("ignores a delayed start confirmation after leaving Practice game", async () => {
    const h = startHarness();
    const smart = { cardIndex: 2 };
    h.appState.trainMode = "smart";
    h.appState.smart = smart;
    expect(await h.start()).toBe(false);
    expect(h.appState.smart).toBe(smart);
    expect(h.paint).not.toHaveBeenCalled();
  });
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
