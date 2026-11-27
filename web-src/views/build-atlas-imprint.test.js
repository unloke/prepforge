import { afterEach, describe, expect, it, vi } from "vitest";

// The Atlas's Imprint is the owner's training over the open tree, and that
// colour is its own read (build-mastery.js). Opened before the read lands,
// the Atlas must take the colour when it arrives, not keep "—" until reopened.

const preparation = { onResult: null };
vi.mock("../atlas-preparation-client.js", () => ({
  startAtlasPreparation: (_input, callbacks) => {
    Object.assign(preparation, callbacks);
    return () => {};
  },
}));

function element() {
  const el = { innerHTML: "", attrs: {}, children: {}, listeners: {} };
  el.setAttribute = (name, value) => { el.attrs[name] = value; };
  el.addEventListener = (type, fn) => { el.listeners[type] = fn; };
  el.querySelector = (selector) => {
    if (selector === ".atlas-imprint b") {
      if (!String(el.innerHTML).includes("atlas-imprint")) return null;
      el.children[selector] ||= { textContent: String(el.innerHTML).match(/Imprint<\/span><b>([^<]*)<\/b>/)?.[1] };
      return el.children[selector];
    }
    el.children[selector] ||= element();
    return el.children[selector];
  };
  return el;
}

let dialog;
vi.mock("../core/dialog.js", () => ({
  modalDialog: () => { dialog = element(); dialog.open = true; return dialog; },
  openModal: () => () => {},
}));

const { openBuildAtlas } = await import("./build-atlas.js");
const { createBuildMastery } = await import("../build-mastery.js");

const nodes = [
  { id: "r", parent_id: null, ply: 0 },
  { id: "a", parent_id: "r", move_side: "white", ply: 1 },
  { id: "b", parent_id: "a", move_side: "black", ply: 2 },
];

afterEach(() => { preparation.onResult = null; });

describe("Atlas imprint follows the owner's mastery", () => {
  it("shows the colour that lands after the Atlas opened", async () => {
    const buildState = { build: { repertoire_id: "r1", revision: 1, name: "KP", color: "white", nodes }, buildMastery: null };
    const appState = { sharedToken: null };
    let resolve;
    const api = vi.fn(() => new Promise((done) => { resolve = done; }));
    const mastery = createBuildMastery({ api, appState, buildState, repaint: () => {} });
    const read = mastery.refresh();

    openBuildAtlas({ appState, buildState });
    const body = dialog.querySelector(".lineage-body");
    const content = body.querySelector("[data-atlas-content]");
    expect(content.querySelector(".atlas-imprint b").textContent).toBe("—");

    resolve({ repertoire_id: "r1", revision: 1, mastery: { a: "mastered" } });
    await read;
    expect(content.querySelector(".atlas-imprint b").textContent).toBe("100");

    // The preparation result repaints the portrait; the imprint keeps the colour.
    preparation.onResult({ score: 40, facets: ["Replies", "Reach", "Depth", "Consistency", "Ease"].map((label) => ({ label, value: 40, definition: "" })) });
    delete content.children[".atlas-imprint b"];
    expect(content.querySelector(".atlas-imprint b").textContent).toBe("100");
  });
});
