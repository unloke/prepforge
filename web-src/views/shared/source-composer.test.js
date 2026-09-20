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
  legacyIdsToSelection,
  selectionToLegacyIds,
  resolveFetchUsernames,
} from "./source-composer.js";

const linked = [
  { id: "a", username: "accountA", is_primary: true },
  { id: "b", username: "accountB", is_primary: false },
];

describe("source composer selection model", () => {
  it("normalizes and dedupes ids and external usernames", () => {
    expect(
      normalizeSelection({ accountIds: ["a", "a", "b"], external: [" Hikaru ", "hikaru", ""] })
    ).toEqual({ accountIds: ["a", "b"], external: ["Hikaru", "hikaru"] });
    expect(normalizeSelection(null)).toEqual({ accountIds: [], external: [] });
    expect(isSelectionEmpty(null)).toBe(true);
    expect(isSelectionEmpty({ accountIds: ["a"] })).toBe(false);
  });

  it("models Self as the group of all linked accounts", () => {
    // Empty (no ids) is the implicit Self default; the popover passes an
    // explicit _selfOff marker only while the user is mid-deselect.
    expect(selfGroupState(null, linked)).toBe("all");
    expect(selfGroupState({ accountIds: [], _selfOff: true }, linked)).toBe("none");
    expect(selfGroupState(selectSelf(null, linked), linked)).toBe("all");
    expect(selfGroupState(toggleAccount(selectSelf(null, linked), "b"), linked)).toBe("mixed");
    expect(selfGroupState(deselectSelf(selectSelf(null, linked), linked), linked)).toBe("all");
  });

  it("toggles single linked accounts", () => {
    expect(toggleAccount(null, "a")).toEqual({ accountIds: ["a"], external: [] });
    expect(toggleAccount({ accountIds: ["a"] }, "a")).toEqual({ accountIds: [], external: [] });
  });

  it("adds and removes arbitrary external usernames", () => {
    const sel = addExternal(addExternal(null, "Hikaru"), "hikaru");
    expect(sel.external).toEqual(["Hikaru"]);
    expect(removeExternal(sel, "HIKARU").external).toEqual([]);
    expect(addExternal(null, "   ").external).toEqual([]);
  });

  it("collapses full Self to one chip, partial to account chips", () => {
    const full = selectionChips(selectSelf(null, linked), linked);
    expect(full.selfState).toBe("all");
    expect(full.chips).toEqual([{ kind: "self", label: "Self · 2", count: 2 }]);
    const partial = selectionChips({ accountIds: ["b"] }, linked);
    expect(partial.selfState).toBe("mixed");
    expect(partial.chips).toEqual([
      { kind: "account", id: "b", label: "accountB", primary: false },
    ]);
    const mixed = selectionChips(
      { accountIds: ["a"], external: ["Hikaru", "Chessbae"] },
      linked
    );
    expect(mixed.chips.map((c) => c.kind)).toEqual(["account", "external", "external"]);
    expect(mixed.chips[0]).toMatchObject({ label: "accountA", primary: true });
  });

  it("bridges the legacy null-means-Self persistence", () => {
    expect(legacyIdsToSelection(null)).toEqual({ accountIds: [], external: [] });
    expect(legacyIdsToSelection(["a"])).toEqual({ accountIds: ["a"], external: [] });
    expect(selectionToLegacyIds(null, linked)).toBe(null);
    expect(selectionToLegacyIds(selectSelf(null, linked), linked)).toBe(null);
    expect(selectionToLegacyIds({ accountIds: ["b"] }, linked)).toEqual(["b"]);
  });

  it("resolves fetch usernames: implicit Self unions external", () => {
    // Self only (implicit default): every linked username.
    expect(resolveFetchUsernames({ selection: null, linkedAccounts: linked })).toEqual([
      "accountA",
      "accountB",
    ]);
    // Self + external: implicit Self contributes ALL linked + every external.
    expect(
      resolveFetchUsernames({
        selection: { accountIds: [], external: ["Hikaru"] },
        linkedAccounts: linked,
        includeExternal: true,
      })
    ).toEqual(["accountA", "accountB", "Hikaru"]);
    // External only: Self deselected (empty linked, no marker) with no linked
    // accounts to default to — externals alone. (With linked accounts present,
    // empty linked IS implicit Self, so Self + external unions by design.)
    expect(
      resolveFetchUsernames({
        selection: { accountIds: [], external: ["Hikaru"] },
        linkedAccounts: [],
        includeExternal: true,
      })
    ).toEqual(["Hikaru"]);
    // Partial linked + external: picked linked union external.
    expect(
      resolveFetchUsernames({
        selection: { accountIds: ["b"], external: ["Hikaru"] },
        linkedAccounts: linked,
        includeExternal: true,
      })
    ).toEqual(["accountB", "Hikaru"]);
    // Explicit Self-off fetches nothing, even with external present.
    expect(
      resolveFetchUsernames({
        selection: { accountIds: [], external: ["Hikaru"], _selfOff: true },
        linkedAccounts: linked,
        includeExternal: true,
      })
    ).toEqual([]);
    // Games ignores external.
    expect(
      resolveFetchUsernames({
        selection: { accountIds: ["b"], external: ["Hikaru"] },
        linkedAccounts: linked,
      })
    ).toEqual(["accountB"]);
  });

  it("persists explicit Self-off as a marker so reload stays empty", () => {
    expect(selectionToLegacyIds({ accountIds: [], external: [], _selfOff: true }, linked)).toEqual([
      "__none__",
    ]);
    // Implicit empty still persists as the Self default.
    expect(selectionToLegacyIds(null, linked)).toBe(null);
  });
});
