import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnalysisStudySaver } from "./analyze-study.js";
import { parsePgn } from "./analyze-pgn.js";
import { createAnalyzeView } from "./views/analyze.js";
import { appSource } from "./test-app-source.js";

const source = appSource();
const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const PGN = '[Event "Opera"]\n[Site "Paris"]\n[Date "1858.11.02"]\n[Round "1"]\n[White "Morphy"]\n[Black "Duke"]\n[Result "*"]\n\n1. e4 e5 2. Nf3 Nc6 (2... d6) *';

function compile(name, deps) {
  const start = source.indexOf(`export async function ${name}(`);
  const body = source.slice(start, source.indexOf("\n}\n", start) + 2).replace("export ", "");
  return new Function(...Object.keys(deps), `let analyzePgnWriting = false; ${body}; return ${name};`)(...Object.values(deps));
}

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("Analyze study saves", () => {
  it.each([null, "g1"])("keeps introductory-comment headers and custom FEN when navigation synchronizes PGN (%s)", async gameId => {
    const fen = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 9";
    const pgn = `{intro}\n[Event "Custom"]\n[Site "Paris"]\n[Round "3"]\n[SetUp "1"]\n[FEN "${fen}"]\n\n9. Nf3 Nc6 *`;
    const parsed = parsePgn(pgn);
    const appState = { analysisPgnStale: false };
    const view = createAnalyzeView({ appState, START_FEN });
    const { moves, varNodes } = view.adaptParsedTree(parsed.root);
    appState.analysis = { game_id: gameId, moves, pgn };
    appState.analysisVarNodes = varNodes;
    const input = { value: pgn };
    const sync = compile("syncPgnFromTree", {
      appState, document: { getElementById: () => input }, analysisRecallSeq: 1,
      ensureAnalyzeView: async () => view,
    });
    await sync();
    const restored = parsePgn(input.value);
    expect(restored.ok).toBe(true);
    expect(restored.headers).toEqual(parsed.headers);
    expect(restored.root.children[0].fenBefore).toBe(fen);
    expect(input.value).toContain("{intro}");
    expect(appState.analysis.pgn).toBe(input.value);
  });

  it("debounces tree edits and writes only the newest PGN to its original game", async () => {
    vi.useFakeTimers();
    const save = vi.fn(async () => {});
    const saver = createAnalysisStudySaver({ save, onError: vi.fn() });
    saver.queue("g1", "old", "owner");
    await vi.advanceTimersByTimeAsync(200);
    saver.queue("g1", PGN, "owner");
    await vi.advanceTimersByTimeAsync(399);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledExactlyOnceWith("g1", PGN, "owner");
    await saver.flush("owner");
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("reports failed saves and retains the study for a flush retry", async () => {
    vi.useFakeTimers();
    const error = new Error("offline");
    const onError = vi.fn();
    const save = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined);
    const saver = createAnalysisStudySaver({ save, onError });
    await saver.flush("owner");
    expect(save).not.toHaveBeenCalled();
    saver.queue("g1", PGN, "owner");
    await vi.advanceTimersByTimeAsync(400);
    expect(onError).toHaveBeenCalledWith(error);
    await saver.flush("owner");
    expect(save).toHaveBeenLastCalledWith("g1", PGN, "owner");
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("serializes new tree branches and queues the accepted PGN, not a textarea draft", async () => {
    const appState = { analysisVarNodes: new Map(), analysisPgnStale: true };
    const view = createAnalyzeView({ appState, START_FEN });
    const { moves, varNodes } = view.adaptParsedTree(parsePgn(PGN).root);
    appState.analysis = { game_id: "g1", moves, pgn: PGN };
    appState.analysisVarNodes = varNodes;
    const input = { value: "1. Qh9" };
    const queue = vi.fn();
    const sync = compile("syncPgnFromTree", {
      appState, document: { getElementById: () => input }, analysisRecallSeq: 1,
      ensureAnalyzeView: async () => view, analysisStudy: { queue }, currentOwnerId: () => "owner",
    });
    await sync();
    expect(queue).toHaveBeenCalledExactlyOnceWith("g1", input.value, "owner");
    expect(input.value).toContain('[Round "1"]');
    expect(input.value).toContain("(2... d6)");
    expect(input.value).not.toContain("Qh9");
    await sync();
    expect(queue).toHaveBeenCalledTimes(1);
  });

  it("flushes only the current owner's study before switching games", async () => {
    vi.useFakeTimers();
    const save = vi.fn(async () => {});
    const saver = createAnalysisStudySaver({ save, onError: vi.fn() });
    saver.queue("g1", PGN, "previous-owner");
    saver.queue("g2", PGN, "owner");
    await saver.flush("owner");
    expect(save).toHaveBeenCalledExactlyOnceWith("g2", PGN, "owner");
  });

  it("autosaves added board variations without dropping imported comments or NAGs", async () => {
    const annotated = PGN.replace("1. e4", "{Opening note} 1. e4 $1 {King pawn}")
      .replace("e5 2.", "e5 ;Black's reply\n2.")
      .replace("Nf3", "Nf3!?").replace("(2... d6)", "({Alternative} 2... d6 $5 {Philidor})");
    const appState = { analysisPgnStale: true };
    const view = createAnalyzeView({ appState, START_FEN });
    const extended = annotated.replace("Nc6 (", "Nc6 (2... Nf6) (");
    const { moves, varNodes } = view.adaptParsedTree(parsePgn(extended).root);
    appState.analysis = { game_id: "g1", moves, pgn: annotated };
    appState.analysisVarNodes = varNodes;
    const input = { value: annotated };
    const queue = vi.fn();
    const sync = compile("syncPgnFromTree", {
      appState, document: { getElementById: () => input }, analysisRecallSeq: 1,
      ensureAnalyzeView: async () => view, analysisStudy: { queue }, currentOwnerId: () => "owner",
    });
    await sync();
    expect(queue).toHaveBeenCalledExactlyOnceWith("g1", input.value, "owner");
    for (const annotation of ["{Opening note}", "$1", "{King pawn}", ";Black's reply\n", "!?", "{Alternative}", "$5", "{Philidor}"]) {
      expect(input.value).toContain(annotation);
    }
    expect(input.value).toContain("(2... Nf6)");
    expect(parsePgn(input.value).ok).toBe(true);
    appState.analysisPgnStale = true;
    await sync();
    expect(queue.mock.calls[1][1]).toBe(queue.mock.calls[0][1]);
  });

  it("serializes overlapping saves so the newest branch wins", async () => {
    vi.useFakeTimers();
    let release;
    const saving = new Promise(resolve => { release = resolve; });
    const save = vi.fn().mockReturnValueOnce(saving).mockResolvedValue(undefined);
    const saver = createAnalysisStudySaver({ save, onError: vi.fn() });
    saver.queue("g1", "first", "owner");
    await vi.advanceTimersByTimeAsync(400);
    saver.queue("g1", PGN, "owner");
    const flushing = saver.flush("owner");
    expect(save).toHaveBeenCalledTimes(1);
    release();
    await flushing;
    expect(save.mock.calls.map(call => call[1])).toEqual(["first", PGN]);
  });
});

describe("Recent analyses study restore", () => {
  function harness(flush = vi.fn(async () => {})) {
    const appState = { analysisVarNodes: new Map() };
    const view = createAnalyzeView({ appState, START_FEN });
    const { moves } = view.adaptParsedTree(parsePgn("1. e4 e5 2. Nf3 Nc6").root);
    const payload = { game_id: "g1", moves, pgn: PGN };
    const input = { value: '[Event "Other game"]' };
    const deps = {
      appState, analysisRecallSeq: 1, analysisStudy: { flush }, parsePgn, currentOwnerId: () => "owner",
      api: vi.fn(async () => payload), ensureAnalyzeView: async () => ({ ...view, renderAnalysis: vi.fn() }),
      document: { getElementById: (id) => id === "pgn-input" ? input : null, querySelector: () => null },
      hideAnalysisHandoff: vi.fn(), resetAnalysisVariations: () => { appState.analysisVarNodes = new Map(); },
      orientAnalysisForSelf: vi.fn(), showAnalysisPly: vi.fn(), syncViewHeads: vi.fn(),
      revealAnalysisResults: vi.fn(), syncPgnFromTree: vi.fn(), setStatusError: vi.fn(),
    };
    return { recall: compile("recallAnalysis", deps), deps, input, appState, payload, view };
  }

  it("flushes pending edits before recall and restores full headers and variations without losing grades", async () => {
    const h = harness();
    h.payload.moves[3].classification = "blunder";
    expect(await h.recall("g1", null, { sourceSeq: 1 })).toBe(true);
    expect(h.deps.analysisStudy.flush.mock.invocationCallOrder[0]).toBeLessThan(h.deps.api.mock.invocationCallOrder[0]);
    expect(h.input.value).toBe(PGN);
    expect(h.appState.analysis).toBe(h.payload);
    expect(h.appState.analysis.moves[3].classification).toBe("blunder");
    expect([...h.appState.analysisVarNodes.values()].map(n => n.san)).toContain("d6");
    const exported = h.view.serializeAnalysisPgn(h.input.value);
    for (const tag of ["Event", "Site", "Date", "Round"]) expect(exported).toContain(`[${tag} `);
    expect(exported).toContain("(2... d6)");
  });

  it("does not leave the study when its pending save fails", async () => {
    const h = harness(vi.fn(async () => { throw new Error("offline"); }));
    expect(await h.recall("g1", null, { sourceSeq: 1 })).toBe(false);
    expect(h.deps.api).not.toHaveBeenCalled();
    expect(h.deps.setStatusError).toHaveBeenCalledWith("offline");
    expect(h.appState.analysis).toBeUndefined();
  });

  it.each([404, 409])("reports an unavailable saved report (%s) to the batch flow without showing an error", async status => {
    const h = harness();
    const onMissing = vi.fn();
    h.deps.api.mockRejectedValue(Object.assign(new Error("no usable report"), { status }));
    expect(await h.recall("g1", null, { sourceSeq: 1, onMissing })).toBe(false);
    expect(onMissing).toHaveBeenCalledOnce();
    expect(h.deps.setStatusError).not.toHaveBeenCalled();
  });

  it("keeps network errors out of the missing-report path", async () => {
    const h = harness();
    const onMissing = vi.fn();
    h.deps.api.mockRejectedValue(Object.assign(new Error("server unavailable"), { status: 500 }));
    expect(await h.recall("g1", null, { sourceSeq: 1, onMissing })).toBe(false);
    expect(onMissing).not.toHaveBeenCalled();
    expect(h.deps.setStatusError).toHaveBeenCalledWith("server unavailable");
  });
});
