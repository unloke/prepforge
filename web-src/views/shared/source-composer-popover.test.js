import { beforeEach, describe, expect, it, vi } from "vitest";
import { openSourceComposer, positionPopover } from "./source-composer.js";

const linked = [
  { id: "a", username: "accountA", is_primary: true },
  { id: "b", username: "accountB", is_primary: false },
];

function makeDoc() {
  const listeners = {};
  const created = [];
  const docListeners = {};
  const popoverStyle = { style: {} };
  const overlay = {
    className: "",
    innerHTML: "",
    dataset: {},
    _boxes: new Map(),
    querySelector: (sel) => {
      if (sel === ".src-popover") return popoverStyle;
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
      return overlay;
    },
  };
  const winListeners = {};
  const realAdd = globalThis.addEventListener;
  const realRemove = globalThis.removeEventListener;
  globalThis.addEventListener = (name, handler) => {
    winListeners[name] = handler;
  };
  globalThis.removeEventListener = vi.fn();
  return {
    doc,
    overlay,
    listeners,
    docListeners,
    popoverStyle,
    winListeners,
    restore: () => {
      globalThis.addEventListener = realAdd;
      globalThis.removeEventListener = realRemove;
    },
  };
}

describe("source composer popover", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("renders one shared surface: Self, linked rows, externals, Add, Done", async () => {
    const { doc, overlay, restore } = makeDoc();
    const changes = [];
    try {
      openSourceComposer({
        document: doc,
        selection: { linkedMode: "subset", accountIds: ["b"], external: ["Hikaru"] },
        linkedAccounts: linked,
        escapeHtml: (s) => String(s),
        onChange: (sel) => changes.push(sel),
        onClose: () => {},
      });
      expect(overlay.innerHTML).toContain("Self");
      expect(overlay.innerHTML).toContain("accountA");
      expect(overlay.innerHTML).toContain("accountB");
      expect(overlay.innerHTML).toContain('aria-checked="mixed"');
      expect(overlay.innerHTML).toContain("data-src-external");
      expect(overlay.innerHTML).toContain("Hikaru");
      expect(overlay.innerHTML).toContain("External");
      expect(overlay.innerHTML).toContain("Add Lichess username");
      expect(overlay.innerHTML).toContain("Done");
      expect(changes).toEqual([]);
    } finally {
      restore();
    }
  });

  it("deselects Self from the group checkbox and reselects back", async () => {
    const { doc, overlay, listeners, restore } = makeDoc();
    const changes = [];
    const metas = [];
    try {
      openSourceComposer({
        document: doc,
        selection: { linkedMode: "all", external: [] },
        linkedAccounts: linked,
        escapeHtml: (s) => String(s),
        onChange: (sel, meta) => {
          changes.push(sel);
          metas.push(meta);
        },
        onClose: () => {},
      });
      listeners.click({
        target: { closest: (sel) => (sel === "[data-src-self-checkbox]" ? { checked: false } : null) },
      });
      expect(changes).toHaveLength(1);
      expect(changes[0]).toEqual({ linkedMode: "none", accountIds: [], external: [] });
      expect(metas[0]).toEqual({ selfState: "none" });
      expect(overlay.innerHTML).not.toContain("checked");
      listeners.change({
        target: {
          closest: (sel) => (sel === "[data-src-self-checkbox]" ? { checked: false } : null),
        },
      });
      expect(changes).toHaveLength(1);
      listeners.click({
        target: { closest: (sel) => (sel === "[data-src-self-checkbox]" ? { checked: true } : null) },
      });
      expect(changes).toHaveLength(2);
      expect(changes[1]).toEqual({ linkedMode: "all", accountIds: [], external: [] });
      expect(metas[1]).toEqual({ selfState: "all" });
    } finally {
      restore();
    }
  });

  it("repositions on every render, resize, and scroll without changing anchor", async () => {
    const { doc, listeners, popoverStyle, winListeners, restore } = makeDoc();
    try {
      const anchor = {
        focus: vi.fn(),
        getBoundingClientRect: () => ({ left: 50, top: 50, bottom: 80, right: 120 }),
      };
      openSourceComposer({
        document: doc,
        anchor,
        selection: { linkedMode: "all" },
        linkedAccounts: linked,
        escapeHtml: (s) => String(s),
        onChange: () => {},
        onClose: () => {},
      });
      expect(popoverStyle.style.position).toBe("fixed");
      const first = { top: popoverStyle.style.top, left: popoverStyle.style.left };
      listeners.click({
        target: { closest: (sel) => (sel === "[data-src-self-checkbox]" ? { checked: false } : null) },
      });
      expect({ top: popoverStyle.style.top, left: popoverStyle.style.left }).toEqual(first);
      expect(typeof winListeners.resize).toBe("function");
      expect(typeof winListeners.scroll).toBe("function");
      winListeners.resize();
      winListeners.scroll();
      expect({ top: popoverStyle.style.top, left: popoverStyle.style.left }).toEqual(first);
    } finally {
      restore();
    }
  });

  it("esc closes, focus returns to the opener", async () => {
    const { doc, overlay, listeners, docListeners, restore } = makeDoc();
    const opener = { focus: vi.fn() };
    overlay.querySelector = (sel) => {
      if (sel === ".src-popover") return { style: {} };
      if (sel === "[data-src-self-checkbox]") return { focus: vi.fn() };
      if (sel === "[data-src-add]") return overlay._input;
      return null;
    };
    const closed = [];
    try {
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
      expect(handle.getSelection()).toEqual({ linkedMode: "all", accountIds: [], external: [] });
    } finally {
      restore();
    }
  });

  it("adds and removes external usernames with accessible labels", async () => {
    const { doc, overlay, listeners, restore } = makeDoc();
    const changes = [];
    try {
      openSourceComposer({
        document: doc,
        selection: null,
        linkedAccounts: linked,
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
    } finally {
      restore();
    }
  });

  it("removes an external source by unchecking its row", async () => {
    const { doc, overlay, listeners, restore } = makeDoc();
    const changes = [];
    try {
      openSourceComposer({
        document: doc,
        selection: { linkedMode: "none", external: ["Hikaru"] },
        linkedAccounts: linked,
        escapeHtml: (s) => String(s),
        onChange: (sel) => changes.push(sel),
        onClose: () => {},
      });
      expect(overlay.innerHTML).toContain("data-src-external-checkbox");
      listeners.change({
        target: {
          closest: (sel) =>
            sel === "[data-src-external-checkbox]"
              ? { checked: false, dataset: { srcExternalCheckbox: "Hikaru" } }
              : null,
        },
      });
      expect(changes[0].external).toEqual([]);
      expect(positionPopover).toBeTypeOf("function");
    } finally {
      restore();
    }
  });
});
