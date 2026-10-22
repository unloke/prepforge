import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The banner on a repertoire someone shared with you names your role, the
// Copy button shows only where the owner allows copies, and Train shows at every
// role (a public link is not a share: no Train).

const els = new Map();
const el = (id) => {
  if (!els.has(id)) els.set(id, { id, hidden: true, textContent: "", dataset: {} });
  return els.get(id);
};

beforeEach(() => {
  els.clear();
  vi.stubGlobal("document", { getElementById: el });
});
afterEach(() => vi.unstubAllGlobals());

async function viewer() {
  const mod = await import("./shared-viewer.js");
  mod.createSharedViewer({ syncViewHeads: () => {} });
  return mod;
}

describe("shared repertoire banner", () => {
  it.each([
    ["view", "View only · KP · shared with you", true],
    ["copy", "Can copy · KP · shared with you", false],
    ["edit", "Can edit · KP · shared with you", false],
  ])("role %s reads %j, Copy hidden: %s", async (role, title, copyHidden) => {
    const { renderReadOnlyBanner } = await viewer();
    el("shared-fork-btn").hidden = false;
    renderReadOnlyBanner({ name: "KP", role });
    expect(el("shared-banner").hidden).toBe(false);
    expect(el("shared-banner-title").textContent).toBe(title);
    expect(el("shared-fork-btn").hidden).toBe(copyHidden);
    expect(el("shared-train-btn").hidden).toBe(false);
  });

  it("offers no Train through a public link", async () => {
    const { renderReadOnlyBanner } = await viewer();
    const { appState } = await import("./core/state.js");
    appState.sharedToken = "tok";
    try {
      renderReadOnlyBanner({ name: "KP", role: "view" });
      expect(el("shared-train-btn").hidden).toBe(true);
    } finally {
      appState.sharedToken = null;
    }
  });
});
