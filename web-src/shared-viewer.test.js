import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The banner on a repertoire someone shared with you names your role, and the
// Copy button shows only where the owner allows copies.

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
    ["view", "View only · shared with you", true],
    ["copy", "Can copy · shared with you", false],
    ["edit", "Can edit · shared with you", false],
  ])("role %s reads %j, Copy hidden: %s", async (role, title, copyHidden) => {
    const { renderReadOnlyBanner } = await viewer();
    el("shared-fork-btn").hidden = false;
    renderReadOnlyBanner({ name: "KP", role });
    expect(el("shared-banner").hidden).toBe(false);
    expect(el("shared-banner-title").textContent).toBe(title);
    expect(el("shared-fork-btn").hidden).toBe(copyHidden);
  });
});
