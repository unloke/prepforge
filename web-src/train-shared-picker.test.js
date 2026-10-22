// Line rehearsal's picker lists the repertoires shared with the user after their
// own, so a shared repertoire is drilled on the user's own progress like theirs.
import { describe, expect, it, vi } from "vitest";
import { html } from "./html.js";
import { appSource } from "./test-app-source.js";

const source = appSource();
function compile(marker, deps) {
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`not found: ${marker}`);
  const end = source.indexOf("\n}\n", start) + 2;
  return new Function(...Object.keys(deps), `return (${source.slice(start, end)});`)(...Object.values(deps));
}

describe("line rehearsal picker", () => {
  it("offers shared repertoires in their own group and keeps one picked from a share", async () => {
    const select = { innerHTML: "", value: "" };
    const appState = { signedIn: true, authKnown: true, pendingRepDeletes: new Set(), trainingRepertoireId: "shared-1" };
    const load = compile("async function loadTrainRepertoireOptions(", {
      appState,
      html,
      document: { getElementById: (id) => (id === "train-repertoire-select" ? select : null) },
      api: vi.fn(async () => ({
        repertoires: [{ id: "mine-1", name: "KP", color: "white", is_active: true }],
        shared: [{ id: "shared-1", name: "Coach's Sicilian", color: "black", role: "view" }],
      })),
      setStatusError: vi.fn(),
      playRepertoireStorageKey: () => "k",
      readStoredPlayRepertoireIds: () => null,
      persistPlayRepertoireIds: vi.fn(),
      renderPlayRepertoirePicker: vi.fn(),
      syncTrainPickerVisibility: vi.fn(),
    });
    await load();
    const markup = String(select.innerHTML);
    expect(markup.indexOf('value="mine-1"')).toBeLessThan(markup.indexOf("Shared with you"));
    expect(markup).toContain('<optgroup label="Shared with you"><option value="shared-1">');
    expect(select.value).toBe("shared-1");
    expect(appState.trainingRepertoireId).toBe("shared-1");
    expect(appState.sharedRepertoireList).toHaveLength(1);
  });
});
