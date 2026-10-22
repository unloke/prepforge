// Deleting the repertoire that is open in Build: the page must stop showing
// the deleted tree (its name, its position and that position's legal moves
// under a "No repertoire" caption) and offer the empty start position.
import { describe, expect, it, vi } from "vitest";
import { localBoardInfo } from "./chess-local.js";
import { appSource } from "./test-app-source.js";

const source = appSource();
const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const MID_FEN = "rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";

function compile(marker, deps) {
  const start = source.indexOf(marker);
  const end = source.indexOf("\n}\n", start) + 2;
  return new Function(...Object.keys(deps), `return (${source.slice(start, end)});`)(...Object.values(deps));
}

describe("closing the open repertoire", () => {
  it("resets the board, header, tree and URL", () => {
    const node = { id: "n1", fen: MID_FEN };
    const appState = {
      build: { repertoire_id: "R", name: "Doomed", nodes: [node] },
      buildNodeById: new Map([["n1", node]]), buildCurrentNodeId: "n1",
      buildUndoDeletes: new Set(["x"]), buildUndoCommitByMove: new Map([["k", () => {}]]), buildSyncState: "dirty",
    };
    const board = { setPosition: vi.fn(), setAnnotations: vi.fn() };
    const label = { textContent: "1... c5" };
    const deps = {
      appState, boards: { build: board }, START_FEN, localBoardInfo,
      document: { getElementById: () => label },
      renderBuildRepHeader: vi.fn(), renderBuilderTree: vi.fn(), renderBuildSync: vi.fn(),
      syncViewHeads: vi.fn(), syncWorkspaceUrl: vi.fn(), scheduleExplorerRefresh: vi.fn(),
      engineWidget: { onBoardChanged: vi.fn() },
    };
    compile("function closeOpenBuild(", deps)();
    expect(appState.build).toBe(null);
    expect(appState.buildCurrentNodeId).toBe(null);
    expect(appState.buildUndoDeletes.size).toBe(0);
    const position = board.setPosition.mock.calls.at(-1)[0];
    expect(position.fen).toBe(START_FEN);
    expect(position.legalMoves).toContain("e2e4");
    expect(board.setAnnotations).toHaveBeenCalledWith([], []);
    expect(label.textContent).toBe("No repertoire");
    for (const fn of ["renderBuildRepHeader", "renderBuilderTree", "syncWorkspaceUrl", "scheduleExplorerRefresh"]) {
      expect(deps[fn]).toHaveBeenCalled();
    }
  });

  it("the delete path uses it and undo reopens the tree", () => {
    const start = source.indexOf('if (action === "delete") {\n      // Undo-toast model');
    const body = source.slice(start, source.indexOf("\n      return;\n    }\n", start));
    expect(body).toContain("if (wasOpen) closeOpenBuild();");
    expect(body).toMatch(/onUndo[\s\S]*if \(wasOpen && !appState\.build && appState\.currentView === "build"\) void editRepertoire\(repertoireId\)/);
    // The URL drops the deleted id: training's pointer clears before the URL sync.
    expect(body.indexOf("appState.trainingRepertoireId = null")).toBeLessThan(body.indexOf("closeOpenBuild()"));
  });
});
