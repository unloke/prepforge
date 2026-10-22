import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { localBoardAfterMove, localBoardInfo } from "./chess-local.js";
import { pickOpponentReply, playPositionAfterReply, replyReasonNote } from "./train-opponent.js";
import { appSource } from "./test-app-source.js";
import { maiaErrorText } from "./maia-init-notice.js";

const source = appSource();
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
    setTrainBanner: (state, title, sub) => { banner.title = title; banner.sub = sub; },
    paintPlayPosition: (next) => { board.setPosition(next); banner.title = next.banner; },
    updateTrainTurnBadge: vi.fn(), syncTrainSessionControls: vi.fn(),
    maiaErrorText: (error) => String(error?.message || "Maia could not start."),
    endPlayGame: vi.fn((title, failure) => { play.active = false; play.ended = title; play.failure = failure; }),
  };
  const reply = compile("async function playOpponentReply(", deps);
  return { play, appState, board, banner, explorer, deps, reply };
}

describe("Play opponent response ownership", () => {
  it("names the real reason on the board, and says to retry", () => {
    const reason = maiaErrorText;
    expect(reason(new Error("weight size mismatch: download truncated"))).toContain("incomplete");
    // The stall case is its own message: a download that stopped part-way is not
    // the same problem as a download that failed.
    expect(reason(new Error("weight download stalled: no bytes from /m.onnx for 20s"))).toContain("stopped part-way");
    expect(reason(new Error("Maia3 predict timed out after 20000ms"))).toContain("in time");
    expect(reason(new Error("Failed to fetch"))).toContain("download failed");
    // A server status names the status, never the raw URL.
    expect(reason(new Error("weight fetch 503 for https://cdn/x.onnx"))).toBe("The Maia download failed (HTTP 503). Retry.");
    expect(reason(new Error("weight fetch 404 for https://cdn/x.onnx"))).not.toContain("https://");
    expect(reason(new Error("sha256 mismatch for x.onnx: got ab != manifest cd"))).toContain("corrupted");
    expect(reason(new Error("Maia3 worker request failed"))).toBe("Maia3 worker request failed");
    expect(reason(undefined)).toContain("could not start");
  });

  it("an opponent that cannot play ends the game with its reason, and is not saved as a run", () => {
    const end = source.slice(source.indexOf("function endPlayGame("), source.indexOf("\n}\n", source.indexOf("function endPlayGame(")));
    expect(end).toContain("if (play.history?.length && !failure) {");
    expect(end).toContain("home.showTrainResult(playResult(play));");
  });

  it("the palette's practice and Lucky actions open Train the way its Home rows do", async () => {
    const openTrain = vi.fn(async () => {});
    const onFeelingLucky = vi.fn();
    const palette = readFileSync(new URL("./palette.js", import.meta.url), "utf8");
    const at = palette.indexOf("async function runPaletteItem(");
    const run = new Function("closePalette", "switchView", "openTrain", "onFeelingLucky", "appState", "requireSignIn", "setReplaySection", "dismissTransientOverlays",
      `return (${palette.slice(at, palette.indexOf("\n}\n", at) + 2)});`)(vi.fn(), vi.fn(), openTrain, onFeelingLucky, { signedIn: true }, vi.fn(), vi.fn(), vi.fn());
    await run({ action: "play-human" });
    expect(openTrain).toHaveBeenLastCalledWith({ mode: "play" });
    await run({ action: "feeling-lucky" });
    expect(openTrain).toHaveBeenLastCalledWith({ mode: "play", autostart: false });
    expect(onFeelingLucky).toHaveBeenCalled();
    await run({ action: "start-training" });
    expect(openTrain).toHaveBeenLastCalledWith({ mode: "smart" });
  });
  function startHarness() {
    const info = deferred();
    const appState = { trainMode: "play" };
    const paint = vi.fn();
    const deps = {
      appState, START_FEN: FEN, playBook: () => "maia", playPickerColor: () => "white",
      resolvePlayColor: () => "white", effectiveMaiaRating: () => 1500, boardInfo: () => info.promise,
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

  it("names the Maia failure instead of blaming the book", async () => {
    const h = harness();
    h.deps.fetchPlayMaia.mockImplementation(async () => ({ error: new Error("Maia3 worker request failed") }));
    const pending = h.reply();
    h.explorer.resolve({ totalGames: 0, moves: [] });
    await pending;
    expect(h.play.active).toBe(false);
    expect(h.deps.endPlayGame).toHaveBeenCalledWith("Opponent unavailable", "Maia3 worker request failed");
    // The one reason that means "the move generator returned nothing" is NOT given.
    expect(h.play.failure).not.toContain("no legal move");
  });

  it("keeps the no-legal-move message for an empty move generator", async () => {
    const h = harness();
    h.deps.fetchPlayMaia.mockImplementation(async () => []);
    const pending = h.reply();
    h.explorer.resolve({ totalGames: 0, moves: [] });
    await pending;
    expect(h.deps.endPlayGame).toHaveBeenCalledWith("No reply from the opponent", "The opponent has no legal move from this book.");
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
