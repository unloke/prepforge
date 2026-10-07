import { describe, expect, it } from "vitest";
import {
  normalizeSelection,
  isSelectionEmpty,
  selfGroupState,
  selectSelf,
  deselectSelf,
  toggleAccount,
  addExternal,
  removeExternal,
  selectionChips,
  resolveFetchUsernames,
  positionPopover,
  sameFetchSources,
} from "./source-composer.js";

const linked = [
  { id: "a", username: "accountA", is_primary: true },
  { id: "b", username: "accountB", is_primary: false },
];

describe("source composer selection model", () => {
  it("normalizes to the explicit linkedMode model and dedupes external names", () => {
    expect(
      normalizeSelection({ linkedMode: "subset", accountIds: ["a", "a", "b"], external: [" Hikaru ", "hikaru", ""] })
    ).toEqual({ linkedMode: "subset", accountIds: ["a", "b"], external: ["Hikaru", "hikaru"] });
    expect(normalizeSelection(null)).toEqual({ linkedMode: "all", accountIds: [], external: [] });
    expect(normalizeSelection({ accountIds: ["a"] })).toEqual({
      linkedMode: "all",
      accountIds: [],
      external: [],
    });
    expect(isSelectionEmpty(null)).toBe(false);
    expect(isSelectionEmpty({ linkedMode: "none", accountIds: [], external: [] })).toBe(true);
    expect(isSelectionEmpty({ linkedMode: "none", external: ["Hikaru"] })).toBe(false);
  });

  it("models Self explicitly: all / subset / none", () => {
    expect(selfGroupState(null, linked)).toBe("all");
    expect(selfGroupState({ linkedMode: "none" }, linked)).toBe("none");
    expect(selfGroupState(selectSelf(null, linked), linked)).toBe("all");
    expect(selfGroupState(toggleAccount(selectSelf(null, linked), "b"), linked)).toBe("mixed");
    expect(selfGroupState({ linkedMode: "none", external: ["Hikaru"] }, linked)).toBe("none");
    expect(selfGroupState(deselectSelf(selectSelf(null, linked), linked), linked)).toBe("none");
  });

  it("toggles single linked accounts through the subset mode", () => {
    expect(toggleAccount(null, "a")).toEqual({
      linkedMode: "subset",
      accountIds: ["a"],
      external: [],
    });
    expect(toggleAccount({ linkedMode: "subset", accountIds: ["a"] }, "a")).toEqual({
      linkedMode: "subset",
      accountIds: [],
      external: [],
    });
  });

  it("adds and removes arbitrary external usernames, keeping linkedMode", () => {
    const sel = addExternal(addExternal({ linkedMode: "all" }, "Hikaru"), "hikaru");
    expect(sel).toEqual({ linkedMode: "all", accountIds: [], external: ["Hikaru"] });
    expect(removeExternal(sel, "HIKARU")).toEqual({
      linkedMode: "all",
      accountIds: [],
      external: [],
    });
    expect(addExternal(null, "   ").external).toEqual([]);
  });

  it("collapses full Self to one chip, partial to account chips", () => {
    const full = selectionChips(selectSelf(null, linked), linked);
    expect(full.selfState).toBe("all");
    expect(full.chips).toEqual([{ kind: "self", label: "Self · 2", count: 2 }]);
    const partial = selectionChips({ linkedMode: "subset", accountIds: ["b"] }, linked);
    expect(partial.selfState).toBe("mixed");
    expect(partial.chips).toEqual([
      { kind: "account", id: "b", label: "accountB", primary: false },
    ]);
    const mixed = selectionChips(
      { linkedMode: "subset", accountIds: ["a"], external: ["Hikaru", "Chessbae"] },
      linked
    );
    expect(mixed.chips.map((c) => c.kind)).toEqual(["account", "external", "external"]);
    expect(mixed.chips[0]).toMatchObject({ label: "accountA", primary: true });
  });


  it("resolves fetch usernames identically for Games and Scout", () => {
    const cases = [
      [{ linkedMode: "all" }, ["accountA", "accountB"]],
      [{ linkedMode: "all", external: ["Hikaru"] }, ["accountA", "accountB", "Hikaru"]],
      [{ linkedMode: "subset", accountIds: ["b"], external: ["Hikaru"] }, ["accountB", "Hikaru"]],
      [{ linkedMode: "subset", accountIds: ["b"] }, ["accountB"]],
      [{ linkedMode: "none", external: ["Hikaru"] }, ["Hikaru"]],
      [{ linkedMode: "none" }, []],
    ];
    for (const [sel, expected] of cases) {
      expect(resolveFetchUsernames({ selection: sel, linkedAccounts: linked })).toEqual(expected);
    }
    expect(
      resolveFetchUsernames({ selection: { linkedMode: "all", external: ["Hikaru"] }, linkedAccounts: [] })
    ).toEqual(["Hikaru"]);
  });

  it("positions the popover in viewport coordinates and clamps to edges", () => {
    const popover = { style: {}, offsetWidth: 320, offsetHeight: 200 };
    const anchor = { getBoundingClientRect: () => ({ left: 100, top: 100, bottom: 130, right: 180 }) };
    const at = positionPopover({ anchor, popover, viewport: { width: 1280, height: 800 } });
    expect(at).toEqual({ top: 136, left: 100 });
    expect(popover.style.position).toBe("fixed");
    const edge = positionPopover({
      anchor: { getBoundingClientRect: () => ({ left: 1200, top: 700, bottom: 730, right: 1260 }) },
      popover: { style: {}, offsetWidth: 320, offsetHeight: 200 },
      viewport: { width: 1280, height: 800 },
    });
    expect(edge.left).toBeLessThanOrEqual(1280 - 320 - 8);
    expect(edge.top + 200).toBeLessThanOrEqual(800 - 8);
  });

  it("keeps the cached anchor rect so tray reflow never moves the popover", () => {
    const popover = { style: {}, offsetWidth: 320, offsetHeight: 200 };
    const first = positionPopover({
      anchor: { getBoundingClientRect: () => ({ left: 100, top: 100, bottom: 130, right: 180 }) },
      popover,
      viewport: { width: 1280, height: 800 },
    });
    const second = positionPopover({
      anchor: { getBoundingClientRect: () => ({ left: 140, top: 160, bottom: 190, right: 220 }) },
      popover,
      viewport: { width: 1280, height: 800 },
    });
    expect(second).toEqual(first);
  });
});

describe("sameFetchSources (UX 2026-10-01 P2-11)", () => {
  it("ignores order and case", () => {
    expect(sameFetchSources(["Me", "Alt"], ["alt", "me"])).toBe(true);
  });
  it("compares account sets even when linked and external names differ only in case", () => {
    expect(sameFetchSources(["Me", "me", "Alt"], ["alt", "me"])).toBe(true);
  });
  it("notices an added or removed account", () => {
    expect(sameFetchSources(["me", "alt"], ["me", "alt", "DrNykterstein"])).toBe(false);
    expect(sameFetchSources(["me", "alt", "DrNykterstein"], ["me", "alt"])).toBe(false);
  });
  it("treats missing lists as empty", () => {
    expect(sameFetchSources(undefined, [])).toBe(true);
  });
});
