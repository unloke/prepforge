import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  normalizeSelection,
  selectionChips,
  selectionFromStorage,
  selectionToStorage,
  resolveFetchUsernames,
} from "./source-composer.js";

const linked = [
  { id: "acc-a", username: "account_a", is_primary: true },
  { id: "acc-b", username: "account_b", is_primary: false },
];

function makeStorage(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    _dump: () => Object.fromEntries(store),
  };
}

function readStore(storage, sourceKey, externalKey, selfKey) {
  let rawIds = null;
  try {
    const raw = storage.getItem(sourceKey);
    if (raw) rawIds = JSON.parse(raw);
  } catch (_) {
    rawIds = null;
  }
  let rawExternal = null;
  try {
    const raw = storage.getItem(externalKey);
    if (raw) rawExternal = JSON.parse(raw);
  } catch (_) {
    rawExternal = null;
  }
  let selfOff = false;
  if (selfKey) selfOff = storage.getItem(selfKey) === "off";
  return selectionFromStorage({ ids: rawIds, external: rawExternal, selfOff });
}

function writeStore(storage, sourceKey, externalKey, selfKey, selection) {
  const stored = selectionToStorage(selection);
  if (!stored.ids || !stored.ids.length) storage.removeItem(sourceKey);
  else storage.setItem(sourceKey, JSON.stringify(stored.ids));
  if (stored.external.length) storage.setItem(externalKey, JSON.stringify(stored.external));
  else storage.removeItem(externalKey);
  if (selfKey) {
    const sel = normalizeSelection(selection);
    storage.setItem(selfKey, sel.linkedMode === "none" && !sel.external.length ? "off" : "on");
  }
}

const pages = [
  { name: "games", source: "prepforge.games_source", external: "prepforge.games_external", self: null },
  { name: "scout", source: "prepforge.scout_source", external: "prepforge.scout_external", self: "prepforge.scout_self" },
];

function pickedUsernames(storage, page, linkedAccounts) {
  return resolveFetchUsernames({
    selection: readStore(storage, page.source, page.external, page.self),
    linkedAccounts,
    includeExternal: true,
  });
}

describe.each(pages.map((p) => [p.name, p]))("source composer parity: %s selection model", (_name, page) => {
  let storage;
  beforeEach(() => {
    storage = makeStorage();
    vi.restoreAllMocks();
  });

  it("Self only: chips Self and fetches every linked account", () => {
    const sel = readStore(storage, page.source, page.external, page.self);
    const { chips, selfState } = selectionChips(sel, linked);
    expect(selfState).toBe("all");
    expect(chips).toEqual([{ kind: "self", label: "Self · 2", count: 2 }]);
    expect(pickedUsernames(storage, page, linked)).toEqual(["account_a", "account_b"]);
  });

  it("Self + external: chips union, fetch includes all linked + external", () => {
    writeStore(storage, page.source, page.external, page.self, {
      linkedMode: "all",
      external: ["Hikaru"],
    }, linked);
    const sel = readStore(storage, page.source, page.external, page.self);
    const { chips, selfState } = selectionChips(sel, linked);
    expect(selfState).toBe("all");
    expect(chips.map((c) => c.kind)).toEqual(["self", "external"]);
    expect(pickedUsernames(storage, page, linked)).toEqual(["account_a", "account_b", "Hikaru"]);
  });

  it("external only: chips + fetch carry externals alone", () => {
    writeStore(storage, page.source, page.external, page.self, {
      linkedMode: "none",
      external: ["Hikaru"],
    }, linked);
    const sel = readStore(storage, page.source, page.external, page.self);
    const { chips, selfState } = selectionChips(sel, linked);
    expect(selfState).toBe("none");
    expect(chips.map((c) => c.kind)).toEqual(["external"]);
    expect(pickedUsernames(storage, page, linked)).toEqual(["Hikaru"]);
  });

  it("partial linked + external: mixed chips, fetch unions picked + external", () => {
    writeStore(storage, page.source, page.external, page.self, {
      linkedMode: "subset",
      accountIds: ["acc-b"],
      external: ["Hikaru"],
    }, linked);
    const sel = readStore(storage, page.source, page.external, page.self);
    const { chips, selfState } = selectionChips(sel, linked);
    expect(selfState).toBe("mixed");
    expect(chips.map((c) => c.kind)).toEqual(["account", "external"]);
    expect(chips[0]).toMatchObject({ label: "account_b" });
    expect(pickedUsernames(storage, page, linked)).toEqual(["account_b", "Hikaru"]);
  });

  it("partial linked only: mixed chips, fetch carries the picked account", () => {
    writeStore(storage, page.source, page.external, page.self, {
      linkedMode: "subset",
      accountIds: ["acc-b"],
      external: [],
    }, linked);
    expect(pickedUsernames(storage, page, linked)).toEqual(["account_b"]);
  });

  it("no sources: empty chips, empty fetch", () => {
    writeStore(storage, page.source, page.external, page.self, {
      linkedMode: "none",
      external: [],
    }, linked);
    const sel = readStore(storage, page.source, page.external, page.self);
    const { chips, selfState } = selectionChips(sel, linked);
    expect(selfState).toBe("none");
    expect(chips).toEqual([]);
    expect(pickedUsernames(storage, page, linked)).toEqual([]);
  });

  it("Self deselect / reselect round-trips", () => {
    writeStore(storage, page.source, page.external, page.self, { linkedMode: "none" }, linked);
    expect(readStore(storage, page.source, page.external, page.self).linkedMode).toBe("none");
    expect(pickedUsernames(storage, page, linked)).toEqual([]);
    writeStore(storage, page.source, page.external, page.self, { linkedMode: "all" }, linked);
    expect(pickedUsernames(storage, page, linked)).toEqual(["account_a", "account_b"]);
  });

  it("reload persistence: explicit picks and externals survive a round-trip", () => {
    writeStore(storage, page.source, page.external, page.self, {
      linkedMode: "subset",
      accountIds: ["acc-b"],
      external: ["Hikaru"],
    }, linked);
    const reloaded = makeStorage(storage._dump());
    const sel = readStore(reloaded, page.source, page.external, page.self);
    expect(sel).toEqual({
      linkedMode: "subset",
      accountIds: ["acc-b"],
      external: ["Hikaru"],
    });
    expect(pickedUsernames(reloaded, page, linked)).toEqual(["account_b", "Hikaru"]);
    const legacy = makeStorage({ [page.source]: JSON.stringify(["acc-b"]) });
    expect(readStore(legacy, page.source, page.external, page.self)).toEqual({
      linkedMode: "subset",
      accountIds: ["acc-b"],
      external: [],
    });
    const legacyNone = makeStorage({ [page.source]: JSON.stringify(["__none__"]) });
    expect(readStore(legacyNone, page.source, page.external, page.self).linkedMode).toBe("none");
  });

  it("remove / re-add: dropping the last external keeps linkedMode, re-add restores", () => {
    writeStore(storage, page.source, page.external, page.self, {
      linkedMode: "all",
      external: ["Hikaru"],
    }, linked);
    let sel = readStore(storage, page.source, page.external, page.self);
    writeStore(storage, page.source, page.external, page.self, {
      linkedMode: sel.linkedMode,
      accountIds: sel.accountIds,
      external: [],
    }, linked);
    sel = readStore(storage, page.source, page.external, page.self);
    expect(sel.external).toEqual([]);
    expect(pickedUsernames(storage, page, linked)).toEqual(["account_a", "account_b"]);
    writeStore(storage, page.source, page.external, page.self, {
      linkedMode: sel.linkedMode,
      accountIds: sel.accountIds,
      external: ["Hikaru"],
    }, linked);
    expect(pickedUsernames(storage, page, linked)).toEqual(["account_a", "account_b", "Hikaru"]);
  });
});
