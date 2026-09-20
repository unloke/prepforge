import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  normalizeSelection,
  selectionChips,
  selectionToLegacyIds,
  resolveFetchUsernames,
} from "./source-composer.js";

const linked = [
  { id: "acc-a", username: "account_a", is_primary: true },
  { id: "acc-b", username: "account_b", is_primary: false },
];

const GAMES_KEY = "prepforge.games_source";
const SCOUT_KEY = "prepforge.scout_source";
const SCOUT_EXTERNAL_KEY = "prepforge.scout_external";
const SCOUT_SELF_KEY = "prepforge.scout_self";

function makeStorage(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    _dump: () => Object.fromEntries(store),
  };
}

function readIds(storage, key) {
  try {
    const raw = storage.getItem(key);
    if (raw) return JSON.parse(raw);
  } catch (_) {
    /* ignore */
  }
  return null;
}

function writeIds(storage, key, ids) {
  if (!ids || !ids.length) storage.removeItem(key);
  else storage.setItem(key, JSON.stringify(ids));
}

function gamesSelection(storage) {
  const raw = readIds(storage, GAMES_KEY);
  if (Array.isArray(raw) && raw.includes("__none__")) {
    return { accountIds: [], external: [], _selfOff: true };
  }
  const ids = Array.isArray(raw) ? raw : [];
  return normalizeSelection({ accountIds: ids });
}

function writeGamesSelection(storage, sel, linkedAccounts) {
  if (sel?._selfOff) writeIds(storage, GAMES_KEY, ["__none__"]);
  else writeIds(storage, GAMES_KEY, selectionToLegacyIds(sel, linkedAccounts));
}

function scoutSelection(storage) {
  const raw = readIds(storage, SCOUT_KEY);
  if (Array.isArray(raw) && raw.includes("__none__")) {
    return { accountIds: [], external: [], _selfOff: true };
  }
  if (storage.getItem(SCOUT_SELF_KEY) === "off") {
    const ids = Array.isArray(raw) ? raw : [];
    let external = [];
    try {
      const rawExt = storage.getItem(SCOUT_EXTERNAL_KEY);
      if (rawExt) external = JSON.parse(rawExt);
    } catch (_) {
      external = [];
    }
    if (!ids.length && !(Array.isArray(external) ? external : []).length) {
      return { accountIds: [], external: [], _selfOff: true };
    }
  }
  const ids = Array.isArray(raw) ? raw : [];
  let external = [];
  try {
    const rawExt = storage.getItem(SCOUT_EXTERNAL_KEY);
    if (rawExt) external = JSON.parse(rawExt);
  } catch (_) {
    external = [];
  }
  return { accountIds: ids, external: Array.isArray(external) ? external : [] };
}

function writeScoutSelection(storage, sel, linkedAccounts) {
  const normalized = normalizeSelection(sel);
  const selfOff = !!sel?._selfOff;
  const empty = !normalized.accountIds.length && !normalized.external.length;
  if (selfOff && empty) writeIds(storage, SCOUT_KEY, ["__none__"]);
  else writeIds(storage, SCOUT_KEY, selectionToLegacyIds(normalized, linkedAccounts));
  if (normalized.external.length) storage.setItem(SCOUT_EXTERNAL_KEY, JSON.stringify(normalized.external));
  else storage.removeItem(SCOUT_EXTERNAL_KEY);
  storage.setItem(SCOUT_SELF_KEY, selfOff && empty ? "off" : "on");
}

function scoutPickedUsernames(storage, linkedAccounts) {
  const sel = scoutSelection(storage);
  if (sel._selfOff) return [];
  return resolveFetchUsernames({
    selection: { accountIds: sel.accountIds, external: sel.external },
    linkedAccounts,
    includeExternal: true,
  });
}

describe("source composer regression: scout selection model", () => {
  let storage;
  beforeEach(() => {
    storage = makeStorage();
    vi.restoreAllMocks();
  });

  it("Self only: implicit default chips Self and fetches every linked account", () => {
    const sel = scoutSelection(storage);
    const { chips, selfState } = selectionChips(sel, linked);
    expect(selfState).toBe("all");
    expect(chips).toEqual([{ kind: "self", label: "Self · 2", count: 2 }]);
    expect(scoutPickedUsernames(storage, linked)).toEqual(["account_a", "account_b"]);
  });

  it("Self + external: chips union, fetch includes all linked + external", () => {
    writeScoutSelection(storage, { accountIds: [], external: ["Hikaru"] }, linked);
    const sel = scoutSelection(storage);
    const { chips, selfState } = selectionChips(sel, linked);
    expect(selfState).toBe("all");
    expect(chips.map((c) => c.kind)).toEqual(["self", "external"]);
    expect(scoutPickedUsernames(storage, linked)).toEqual(["account_a", "account_b", "Hikaru"]);
  });

  it("external only: Self deselected, chips + fetch carry externals alone", () => {
    writeScoutSelection(storage, { accountIds: [], external: ["Hikaru"] }, []);
    const sel = scoutSelection(storage);
    const { chips, selfState } = selectionChips(sel, []);
    expect(selfState).toBe("all");
    expect(chips.map((c) => c.kind)).toEqual(["external"]);
    expect(scoutPickedUsernames(storage, [])).toEqual(["Hikaru"]);
  });

  it("partial linked + external: mixed chips, fetch unions picked + external", () => {
    writeScoutSelection(storage, { accountIds: ["acc-b"], external: ["Hikaru"] }, linked);
    const sel = scoutSelection(storage);
    const { chips, selfState } = selectionChips(sel, linked);
    expect(selfState).toBe("mixed");
    expect(chips.map((c) => c.kind)).toEqual(["account", "external"]);
    expect(chips[0]).toMatchObject({ label: "account_b" });
    expect(scoutPickedUsernames(storage, linked)).toEqual(["account_b", "Hikaru"]);
  });

  it("Self deselect / reselect round-trips through the empty marker", () => {
    writeScoutSelection(storage, { accountIds: [], external: [], _selfOff: true }, linked);
    let sel = scoutSelection(storage);
    expect(sel._selfOff).toBe(true);
    const { selfState } = selectionChips(sel, linked);
    expect(selfState).toBe("none");
    expect(scoutPickedUsernames(storage, linked)).toEqual([]);
    writeScoutSelection(storage, { accountIds: ["acc-a", "acc-b"], external: [] }, linked);
    sel = scoutSelection(storage);
    expect(sel._selfOff).toBeUndefined();
    expect(scoutPickedUsernames(storage, linked)).toEqual(["account_a", "account_b"]);
  });

  it("reload persistence: explicit picks and externals survive a storage round-trip", () => {
    writeScoutSelection(storage, { accountIds: ["acc-b"], external: ["Hikaru"] }, linked);
    const reloaded = makeStorage(storage._dump());
    const sel = scoutSelection(reloaded);
    expect(sel.accountIds).toEqual(["acc-b"]);
    expect(sel.external).toEqual(["Hikaru"]);
    expect(scoutPickedUsernames(reloaded, linked)).toEqual(["account_b", "Hikaru"]);
    const emptyStore = makeStorage();
    writeScoutSelection(emptyStore, { accountIds: [], external: [], _selfOff: true }, linked);
    const reloadedEmpty = makeStorage(emptyStore._dump());
    expect(scoutSelection(reloadedEmpty)._selfOff).toBe(true);
    expect(scoutPickedUsernames(reloadedEmpty, linked)).toEqual([]);
  });

  it("games selection keeps the same empty-marker contract", () => {
    writeGamesSelection(storage, { accountIds: [], external: [], _selfOff: true }, linked);
    expect(gamesSelection(storage)._selfOff).toBe(true);
    const reloaded = makeStorage(storage._dump());
    expect(gamesSelection(reloaded)._selfOff).toBe(true);
  });
});
