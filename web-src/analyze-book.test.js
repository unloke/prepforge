import { afterEach, describe, expect, it, vi } from "vitest";
import { Chess } from "chess.js";
import { createBookActions } from "./analyze-book.js";

afterEach(() => vi.unstubAllGlobals());

function repertoire(color, sans) {
  const chess = new Chess(), children = new Map(), kids = new Map();
  let parent = "root";
  for (const san of sans) {
    const move = chess.move(san);
    const node = { id: `${color}-${chess.history().length}`, san, uci: move.lan };
    children.set(`${parent}|${move.lan}`, node);
    kids.set(parent, [node]);
    parent = node.id;
  }
  return { id: color, name: `${color} prep`, color, rootId: "root", children, kids };
}

function harness(side, sans, reps) {
  const el = { hidden: true, innerHTML: "", querySelector: () => ({ addEventListener: vi.fn() }) };
  vi.stubGlobal("document", { getElementById: () => el });
  const chess = new Chess(), byId = new Map();
  let node = { id: "root" };
  for (const san of sans) {
    const fenBefore = chess.fen(), move = chess.move(san);
    node = { id: `ply-${chess.history().length}`, parent: node, san, uci: move.lan,
      side: move.color === "w" ? "white" : "black", fenBefore };
    byId.set(node.id, node);
  }
  const buildBookline = vi.fn(() => "Departure");
  const appState = { signedIn: true, analysisCurrentNodeId: node.id, analysisTree: { byId } };
  const actions = createBookActions({
    bookState: { loaded: true, reps }, appState, analysisSelfSide: () => side,
    loadCoach: async () => ({ buildBookline }),
  });
  return { ...actions, appState, buildBookline, el };
}

describe("Analyze repertoire ownership", () => {
  it("shows a white player's departure even when the black repertoire contains that move", async () => {
    const h = harness("white", ["e4", "e5", "Bc4"], [
      repertoire("white", ["e4", "e5", "Nf3"]),
      repertoire("black", ["e4", "e5", "Bc4"]),
    ]);
    await h.updateBookline();
    expect(h.buildBookline).toHaveBeenCalledWith(expect.objectContaining({ kind: "user", repName: "white prep", expectedSan: "Nf3" }));
    expect(h.el.hidden).toBe(false);
  });

  it("shows a black player's departure even when the white repertoire contains that move", async () => {
    const h = harness("black", ["e4", "c5"], [
      repertoire("white", ["e4", "c5"]),
      repertoire("black", ["e4", "e5"]),
    ]);
    await h.updateBookline();
    expect(h.buildBookline).toHaveBeenCalledWith(expect.objectContaining({ kind: "user", repName: "black prep", expectedSan: "e5" }));
  });

  it("uses the user's book for an opponent novelty, rather than the mover's book", async () => {
    const h = harness("white", ["e4", "c5"], [
      repertoire("black", ["e4", "e5"]),
      repertoire("white", ["e4", "e6"]),
    ]);
    await h.updateBookline();
    expect(h.buildBookline).toHaveBeenCalledWith(expect.objectContaining({ kind: "opponent", repName: "white prep" }));
  });

  it("does not attribute a position found only in the opposite-color book", async () => {
    const h = harness("white", ["e4", "c5"], [
      repertoire("white", ["d4", "d5"]), repertoire("black", ["e4", "e5"]),
    ]);
    await h.updateBookline();
    expect(h.buildBookline).not.toHaveBeenCalled();
    expect(h.el.hidden).toBe(true);
  });

  it("compares both colors only when the player is unknown", async () => {
    const h = harness(null, ["e4", "c5"], [
      repertoire("white", ["e4", "e5"]), repertoire("black", ["e4", "c5"]),
    ]);
    await h.updateBookline();
    expect(h.buildBookline).not.toHaveBeenCalled();
    expect(h.el.hidden).toBe(true);
  });

  it("hides a previous note when there are no books for the identified side", async () => {
    const h = harness("black", ["e4", "c5"], [repertoire("white", ["e4", "e5"])]);
    h.el.hidden = false;
    h.el.innerHTML = "Previous departure";
    await h.updateBookline();
    expect(h.buildBookline).not.toHaveBeenCalled();
    expect(h.el).toMatchObject({ hidden: true, innerHTML: "" });
  });
});
