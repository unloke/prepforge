import { beforeEach, describe, expect, it, vi } from "vitest";
import { openSourceComposer } from "./source-composer.js";

const linked = [
  { id: "a", username: "accountA", is_primary: true },
  { id: "b", username: "accountB", is_primary: false },
];

function makeDoc() {
  const listeners = {};
  const created = [];
  const docListeners = {};
  const overlay = {
    className: "",
    innerHTML: "",
    dataset: {},
    _boxes: new Map(),
    querySelector: (sel) => {
      if (sel === ".src-popover") return { style: {} };
      if (sel === "[data-src-self-checkbox]") return { focus: vi.fn() };
      if (sel === "[data-src-add]") return overlay._input;
      return null;
    },
    querySelectorAll: () => [],
    addEventListener: (name, handler) => {
      listeners[name] = handler;
    },
    remove: vi.fn(),
  };
  overlay._input = { value: "", focus: vi.fn() };
  const doc = {
    activeElement: { focus: vi.fn() },
    body: { appendChild: vi.fn(), contains: () => true },
    addEventListener: (name, handler) => {
      docListeners[name] = handler;
    },
    removeEventListener: vi.fn(),
    createElement: (tag) => {
      void tag;
      created.push(overlay);
      return overlay;
    },
  };
  return { doc, overlay, listeners, docListeners };
}

describe("source composer popover", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("renders Self group, linked rows, and mixed state", async () => {
    const { doc, overlay } = makeDoc();
    const changes = [];
    openSourceComposer({
      document: doc,
      selection: { accountIds: ["b"], external: [] },
      linkedAccounts: linked,
      allowExternal: true,
      escapeHtml: (s) => String(s),
      onChange: (sel) => changes.push(sel),
      onClose: () => {},
    });
    expect(overlay.innerHTML).toContain("Self");
    expect(overlay.innerHTML).toContain("accountA");
    expect(overlay.innerHTML).toContain("accountB");
    expect(overlay.innerHTML).toContain('aria-checked="mixed"');
    expect(overlay.innerHTML).toContain("Add Lichess username");
    expect(overlay.innerHTML).toContain("Done");
    expect(changes).toEqual([]);
  });

  it("deselects Self from the group checkbox and reselects back", async () => {
    const { doc, overlay, listeners } = makeDoc();
    const changes = [];
    const metas = [];
    openSourceComposer({
      document: doc,
      selection: { accountIds: [], external: [] },
      linkedAccounts: linked,
      escapeHtml: (s) => String(s),
      onChange: (sel, meta) => {
        changes.push(sel);
        metas.push(meta);
      },
      onClose: () => {},
    });
    // Direct input click: pre-flip model still "all" -> deselect to "none".
    listeners.click({
      target: { closest: (sel) => (sel === "[data-src-self-checkbox]" ? { checked: true } : null) },
    });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual({ accountIds: [], external: [] });
    expect(metas[0]).toEqual({ selfState: "none" });
    expect(overlay.innerHTML).not.toContain("checked");
    // The change event from the same activation no-ops (already synced).
    listeners.change({
      target: {
        closest: (sel) => (sel === "[data-src-self-checkbox]" ? { checked: false } : null),
      },
    });
    expect(changes).toHaveLength(1);
    // Clicking again from "none" reselects the whole group.
    listeners.click({
      target: { closest: (sel) => (sel === "[data-src-self-checkbox]" ? { checked: false } : null) },
    });
    expect(changes).toHaveLength(2);
    expect(changes[1].accountIds.sort()).toEqual(["a", "b"]);
    expect(metas[1]).toEqual({ selfState: "all" });
  });

  it("esc closes, focus returns to the opener", async () => {
    const { doc, overlay, listeners, docListeners } = makeDoc();
    const opener = { focus: vi.fn() };
    overlay.querySelector = (sel) => {
      if (sel === ".src-popover") return { style: {} };
      if (sel === "[data-src-self-checkbox]") return { focus: vi.fn() };
      if (sel === "[data-src-add]") return overlay._input;
      return null;
    };
    const closed = [];
    const handle = openSourceComposer({
      document: doc,
      anchor: opener,
      selection: null,
      linkedAccounts: linked,
      escapeHtml: (s) => String(s),
      onClose: (sel) => closed.push(sel),
    });
    listeners.keydown({ key: "Escape", preventDefault: vi.fn(), stopPropagation: vi.fn() });
    docListeners.keydown({
      key: "Escape",
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    });
    expect(opener.focus).toHaveBeenCalled();
    expect(closed).toHaveLength(1);
    expect(handle.getSelection()).toEqual({ accountIds: [], external: [] });
  });

  it("adds and removes external usernames with accessible labels", async () => {
    const { doc, overlay, listeners } = makeDoc();
    const changes = [];
    openSourceComposer({
      document: doc,
      selection: null,
      linkedAccounts: linked,
      allowExternal: true,
      escapeHtml: (s) => String(s),
      onChange: (sel) => changes.push(sel),
      onClose: () => {},
    });
    overlay._input.value = "Hikaru";
    listeners.keydown({
      key: "Enter",
      preventDefault: vi.fn(),
      target: { matches: (sel) => sel === "[data-src-add]" },
    });
    expect(changes[0].external).toEqual(["Hikaru"]);
    expect(overlay.innerHTML).toContain('aria-label="Remove Hikaru"');
    listeners.click({
      target: {
        closest: (sel) =>
          sel === "[data-src-remove-external]" ? { dataset: { srcRemoveExternal: "Hikaru" } } : null,
      },
    });
    expect(changes[1].external).toEqual([]);
  });
});
