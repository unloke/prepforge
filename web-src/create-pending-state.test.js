// i02: "Creating a repertoire feels slow." The create used to await the modal and
// then the POST with no pending state anywhere, so the click looked ignored until
// the server answered. These guard the two halves of the fix in the source, where
// no DOM exists to click around in: the modal's own pending state (showInputModal's
// onSubmit hook, also used by New team) and the optimistic empty repertoire that
// opens while the request runs, with its rollback.
import { describe, expect, it, vi } from "vitest";
import { html } from "./html.js";
import { localBoardInfo } from "./chess-local.js";
import { appSource } from "./test-app-source.js";

const source = appSource();
const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

function fakeEl() {
  const listeners = {};
  const classes = new Set();
  const attrs = {};
  const el = {
    dataset: {}, style: {}, hidden: false, textContent: "", title: "", innerHTML: "",
    disabled: false, className: "", name: "", value: "", children: [], parent: null, tagName: "DIV",
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
    },
    setAttribute: (key, value) => { attrs[key] = String(value); },
    getAttribute: (key) => (key in attrs ? attrs[key] : null),
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    fire: (type, event = {}) => (listeners[type] || [])
      .forEach((fn) => fn({ stopPropagation() {}, ...event })),
    appendChild(child) { child.parent = el; el.children.push(child); return child; },
    remove() { if (el.parent) el.parent.children = el.parent.children.filter((c) => c !== el); },
    querySelector: () => null,
    querySelectorAll: () => [],
    contains: () => false,
    focus() {},
  };
  return el;
}

// The modal showInputModal builds, stubbed down to what submit() touches.
function modalHarness() {
  const overlay = fakeEl();
  const cancelBtn = fakeEl();
  const okBtn = fakeEl();
  const nameField = Object.assign(fakeEl(), { name: "name", value: "Najdorf" });
  const colorField = Object.assign(fakeEl(), { name: "color", value: "white" });
  overlay.querySelector = (sel) => (sel === '[data-action="ok"]' ? okBtn
    : sel === '[data-action="cancel"]' ? cancelBtn : null);
  overlay.querySelectorAll = (sel) => (sel === "[data-field]" ? [nameField, colorField]
    : sel === ".modal-footer .btn, [data-field]" ? [cancelBtn, okBtn, nameField, colorField] : []);
  const body = fakeEl();
  let document_ = { body, createElement: () => overlay, addEventListener() {}, removeEventListener() {} };
  const showInputModal = compileFunction("function showInputModal(", {
    html, document: document_, activateModal: () => () => {},
  });
  return { overlay, okBtn, cancelBtn, nameField, colorField, showInputModal };
}

function compileFunction(marker, deps) {
  const start = source.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("\n}\n", start) + 2;
  return new Function(...Object.keys(deps), `return (${source.slice(start, end)});`)(...Object.values(deps));
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("create dialogs hold a pending state while the request runs", () => {
  it("spins the Create button and locks the fields until the caller settles", async () => {
    const h = modalHarness();
    let closeWith = null;
    let release;
    const done = new Promise((resolve) => { release = resolve; });
    const show = h.showInputModal({
      title: "New repertoire",
      okLabel: "Create",
      fields: [{ name: "name" }, { name: "color" }],
      onSubmit: async (_values, close) => {
        closeWith = close;
        await done;
      },
    });
    await flush();
    h.okBtn.fire("click");
    // The click reads as work in progress instead of a dropped click.
    expect(h.okBtn.classList.contains("is-loading")).toBe(true);
    expect(h.okBtn.disabled).toBe(true);
    expect(h.nameField.disabled).toBe(true);
    expect(h.cancelBtn.disabled).toBe(true);
    expect(h.overlay.getAttribute("aria-busy")).toBe("true");
    // A second submit cannot double-fire while one is in flight.
    h.okBtn.fire("click");
    release();
    await vi.waitFor(() => expect(h.okBtn.classList.contains("is-loading")).toBe(false));
    expect(typeof closeWith).toBe("function"); // the caller keeps the dialog open until it decides
    h.overlay.remove(); // what the caller's close() would do
    expect(closeWith).not.toBeNull();
    expect(h.overlay.children).not.toContain(h.overlay);
  });

  it("a failed submit re-enables the form instead of closing it", async () => {
    const h = modalHarness();
    const show = h.showInputModal({
      title: "New repertoire",
      okLabel: "Create",
      fields: [{ name: "name" }, { name: "color" }],
      onSubmit: async () => { throw new Error("offline"); },
    });
    await flush();
    h.okBtn.fire("click");
    await vi.waitFor(() => expect(h.okBtn.disabled).toBe(false));
    expect(h.okBtn.classList.contains("is-loading")).toBe(false);
    expect(h.nameField.disabled).toBe(false);
    expect(h.overlay.getAttribute("aria-busy")).toBe("false");
    // Still open: the user can fix the name and try again.
    expect(h.overlay.parent).toBeTruthy();
    show.catch(() => {});
  });

  it("submits that carry no request still close with the field values", async () => {
    const h = modalHarness();
    const show = h.showInputModal({ title: "Rename", fields: [{ name: "name" }] });
    await flush();
    h.okBtn.fire("click");
    await expect(show).resolves.toMatchObject({ name: "Najdorf" });
  });

  it("Enter submits through the same pending path, not the old close()", () => {
    const handler = source.slice(
      source.indexOf("const onKey = (event) =>"),
      source.indexOf("document.addEventListener(\"keydown\", onKey)"),
    );
    expect(handler).toMatch(/submit\(\)/);
    expect(handler).not.toMatch(/close\(collect\(\)\)/);
  });
});

describe("New team behaves like New repertoire", () => {
  const createTeam = source.slice(
    source.indexOf("async function createTeam("),
    source.indexOf("async function renameTeam("),
  );

  it("runs the request inside the dialog's pending state", () => {
    expect(createTeam).toMatch(/onSubmit: async \(result, close\) =>/);
    expect(createTeam).toMatch(/postJson\("\/api\/teams"/);
  });

  it("keeps the dialog open when the create fails", () => {
    const failure = createTeam.slice(createTeam.indexOf("} catch (error) {"));
    expect(failure).toMatch(/setStatusError\(error\.message\)/);
    expect(failure).not.toMatch(/close\(/);
  });
});

describe("createRepertoirePrompt opens the new repertoire optimistically", () => {
  function repHarness(create) {
    const appState = {
      build: null, buildNodeById: new Map(), buildCurrentNodeId: null,
      buildPending: [], buildPendingDeletes: [], buildSyncState: "saved", trainingRepertoireId: null,
    };
    const board = { setOrientation: vi.fn(), setPosition: vi.fn() };
    const views = [];
    const rendered = [];
    const postJson = vi.fn(create);
    const prompt = compileFunctionRange("async function createRepertoirePrompt(", {
      requireSignIn: () => true,
      showInputModal: (options) => options.onSubmit(
        { name: "Najdorf", color: "black" },
        () => {},
      ),
      repertoireColorField: () => ({ name: "color", type: "select", options: ["white", "black"] }),
      normalizeRepertoireColor: (value) => (value === "black" ? "black" : "white"),
      optimisticEmptyRepertoire: undefined, // compiled in from the same range below
      postJson,
      hydrateBuild: vi.fn(async (payload) => { appState.build = payload; }),
      appState, OUTBOX_TAB_ID: "tab",
      START_FEN, localBoardInfo, boards: { build: board },
      switchView: (name) => views.push(name),
      setStatus: vi.fn(),
      setStatusError: vi.fn(),
      refreshDashboardRepertoires: vi.fn(async () => {}),
      renderBuildRepHeader: () => rendered.push("header"),
      renderBuildSync: () => rendered.push("sync"),
      renderBuilderTree: () => rendered.push("tree"),
      syncWorkspaceUrl: () => rendered.push("url"),
    });
    return { appState, board, views, rendered, postJson, prompt };
  }

  it("puts the empty board and tree on screen before the server answers", async () => {
    let release;
    const create = new Promise((resolve) => { release = resolve; });
    const h = repHarness(() => create);
    const run = h.prompt({ defaultName: "Najdorf", defaultColor: "black" });
    await vi.waitFor(() => expect(h.postJson).toHaveBeenCalled());
    // Local-first: the tree exists while the request is still in flight.
    expect(h.appState.build).toMatchObject({ name: "Najdorf", color: "black", writable: true, revision: 0 });
    expect(h.appState.buildCurrentNodeId).toMatch(/^tmp-rep-tab-/);
    expect(h.appState.buildSyncState).toBe("saved");
    expect(h.board.setOrientation).toHaveBeenCalledWith("black");
    expect(h.board.setPosition).toHaveBeenCalledWith(
      expect.objectContaining({ fen: START_FEN }),
    );
    expect(h.views).toEqual(["build"]);
    expect(h.rendered).toEqual(expect.arrayContaining(["header", "tree", "sync", "url"]));
    release({ repertoire_id: "rep-1", selected_node_id: "root-1", revision: 1, nodes: [] });
    await run;
    expect(h.appState.build.repertoire_id).toBe("rep-1");
  });

  it("a failed create drops the empty tree and restores the previous one", async () => {
    const previous = {
      repertoire_id: "rep-0", name: "Italian", color: "white", revision: 4,
      selected_node_id: "root-0", nodes: [{ id: "root-0", fen: START_FEN, uci: null }],
    };
    const h = repHarness(async () => { throw new Error("Free plan: 3 repertoires max"); });
    h.appState.build = previous;
    h.appState.buildNodeById = new Map(previous.nodes.map((node) => [node.id, node]));
    h.appState.buildCurrentNodeId = "root-0";
    await expect(h.prompt({})).resolves.toBeNull();
    expect(h.appState.build).toBe(previous);
    expect(h.appState.buildNodeById.get("root-0")).toBe(previous.nodes[0]);
    expect(h.appState.buildCurrentNodeId).toBe("root-0");
    expect(h.board.setPosition).toHaveBeenLastCalledWith(
      expect.objectContaining({ fen: START_FEN }),
    );
    expect(h.postJson.mock.results).toBeTruthy();
  });

  it("rolls all the way back when there was no repertoire to restore", async () => {
    const h = repHarness(async () => { throw new Error("offline"); });
    await expect(h.prompt({})).resolves.toBeNull();
    expect(h.appState.build).toBeNull();
    expect(h.appState.buildNodeById.size).toBe(0);
  });
});

// createRepertoirePrompt shares its file with the two helpers the optimistic open
// needs, so compile the whole run together.
function compileFunctionRange(marker, deps) {
  const start = source.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const rollback = source.indexOf("function rollbackOptimisticRepertoire(", start);
  expect(rollback).toBeGreaterThan(start);
  const end = source.indexOf("\n}\n", rollback) + 2;
  const block = source.slice(start, end);
  const fn = new Function(...Object.keys(deps), `${block}; return createRepertoirePrompt;`)(...Object.values(deps));
  return fn;
}
