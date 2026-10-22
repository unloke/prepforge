import { describe, expect, it, vi } from "vitest";

import { createMoveTreeRenderer } from "./movetree.js";



function sampleTree() {
  const n1 = {
    id: "n1",
    san: "e4",
    moveNumber: 1,
    side: "white",
    children: [],
  };
  const n2 = {
    id: "n2",
    san: "e5",
    moveNumber: 1,
    side: "black",
    children: [],
  };
  n1.children = [n2];
  const alt = {
    id: "alt",
    san: "c5",
    moveNumber: 1,
    side: "black",
    children: [],
  };
  return {
    id: "root",
    children: [n1, alt],
  };
}

// A container that records the listeners bound on it (one set, by delegation)
// and lets a test dispatch an event from a move button inside it. `vars` names
// the variation each move sits in, as `{ nodeId: "name" }`, so the rail state
// can be read back the way the DOM would report it.
function stubMoveTreeContainer(html, { vars = {} } = {}) {
  const listeners = new Map();
  const variations = new Map(
    [...new Set(Object.values(vars))].map((name) => {
      const classes = new Set(["mtree-var"]);
      return [name, {
        classList: {
          add: (...names) => names.forEach((n) => classes.add(n)),
          remove: (...names) => names.forEach((n) => classes.delete(n)),
          contains: (name) => classes.has(name),
          toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
        },
        classes,
      }];
    }),
  );
  const buttons = new Map(
    [...String(html).matchAll(/data-node-id="([^"]+)"/g)].map((match) => {
      const classes = new Set();
      const attrs = {};
      const button = {
        dataset: { nodeId: match[1] },
        classList: {
          add: (...names) => names.forEach((n) => classes.add(n)),
          remove: (...names) => names.forEach((n) => classes.delete(n)),
          contains: (name) => classes.has(name),
          toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
        },
        setAttribute: (name, value) => { attrs[name] = value; },
        getAttribute: (name) => attrs[name] ?? null,
        removeAttribute: (name) => { delete attrs[name]; },
        matches: () => false,
        blur: vi.fn(),
        parentElement: variations.get(vars[match[1]]) || null,
        classes,
        attrs,
      };
      return [match[1], button];
    }),
  );
  const container = {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    querySelector(selector) {
      const current = [...buttons.entries()].find(([, b]) => b.classes.has("is-current"));
      if (selector === ".mtree-move.is-current") return current ? current[1] : null;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === ".mtree-move[data-node-id]") return [...buttons.values()];
      return [];
    },
    dispatch(type, nodeId, extra = {}) {
      const button = buttons.get(nodeId);
      const event = {
        target: { closest: (sel) => (sel.includes("mtree-move") ? button : null) },
        ...extra,
      };
      for (const fn of listeners.get(type) || []) fn(event);
      return event;
    },
    button: (nodeId) => buttons.get(nodeId),
    variation: (name) => variations.get(name),
    listenerCount: () => [...listeners.values()].reduce((n, fns) => n + fns.length, 0),
  };
  return container;
}

describe("createMoveTreeRenderer", () => {
  const { renderMoveTree, bindMoveTreeClicks } = createMoveTreeRenderer();

  it("renders an empty-state wrapper when the root has no children", () => {
    const html = renderMoveTree({ id: "root", children: [] }, { emptyText: "Nothing here." });
    expect(String(html)).toContain('class="empty-state"');
    expect(String(html)).toContain("Nothing here.");
  });

  it("renders mainline tokens and marks the current node", () => {
    const root = sampleTree();
    const html = renderMoveTree(root, { currentId: "n2", pathIds: new Set(["n1", "n2"]) });
    expect(String(html)).toContain('data-node-id="n1"');
    expect(String(html)).toContain('<span class="mtree-san">e4</span>');
    expect(String(html)).toContain('data-node-id="n2"');
    expect(String(html)).toContain("is-current");
    expect(String(html)).toContain('aria-current="true"');
    expect(String(html)).toContain("on-path");
    expect(String(html)).toContain('class="mtree-var"');
    expect(String(html)).toContain('<span class="mtree-san">c5</span>');
  });

  it("escapes unsafe SAN text in rendered HTML", () => {
    const root = {
      id: "root",
      children: [
        {
          id: "x",
          san: '<img onerror="x">',
          moveNumber: 1,
          side: "white",
          children: [],
        },
      ],
    };
    const html = renderMoveTree(root, {});
    expect(String(html)).not.toContain("<img");
    expect(String(html)).toContain("&lt;img onerror=&quot;x&quot;&gt;");
  });

  it("names each move button by number, side, SAN and grade", () => {
    const graded = {
      id: "root",
      children: [
        { id: "n1", san: "e4", moveNumber: 1, side: "white", children: [] },
        { id: "n2", san: "e5", moveNumber: 1, side: "black", classification: "blunder", children: [] },
      ],
    };
    graded.children[0].children = [graded.children[1]];
    const html = renderMoveTree(graded, {
      decorate: (node) => ({
        classes: [],
        title: node.classification,
        label: node.classification,
      }),
    });
    expect(String(html)).toContain('aria-label="1. e4, White"');
    expect(String(html)).toContain('aria-label="1... e5, Black, blunder"');
  });

  it("still names a button whose node carries no grade", () => {
    const html = renderMoveTree(sampleTree(), {});
    expect(String(html)).toContain('aria-label="1. e4, White"');
    expect(String(html)).toContain('aria-label="1... c5, Black"');
  });

  it("binds one set of listeners on the container and routes move clicks by target", () => {
    const html = renderMoveTree(sampleTree(), { currentId: "n1" });
    const container = stubMoveTreeContainer(html);
    const onSelect = vi.fn();
    const onContext = vi.fn();
    bindMoveTreeClicks(container, onSelect, onContext);
    // Six events for the whole tree, not six per move.
    expect(container.listenerCount()).toBe(6);

    container.dispatch("click", "n2");
    expect(onSelect).toHaveBeenCalledWith("n2");
    expect(container.button("n2").blur).toHaveBeenCalled();

    const event = container.dispatch("contextmenu", "alt", { preventDefault: vi.fn() });
    expect(onContext).toHaveBeenCalledWith(event, "alt");
  });

  it("does not stack a second handler when the tree re-renders into the same container", () => {
    const container = stubMoveTreeContainer(renderMoveTree(sampleTree(), {}));
    const onSelect = vi.fn();
    bindMoveTreeClicks(container, onSelect, vi.fn());
    bindMoveTreeClicks(container, onSelect, vi.fn());
    container.dispatch("click", "n1");
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});

describe("updateMoveTreeSelection", () => {
  const { renderMoveTree, updateMoveTreeSelection } = createMoveTreeRenderer();

  // The classes each button carries, as the DOM would report them.
  function classesOf(container, id) {
    return [...container.button(id).classes].sort();
  }

  it("moves the current mark and clears the old one without rebuilding markup", () => {
    const container = stubMoveTreeContainer(
      renderMoveTree(sampleTree(), { currentId: "n1", pathIds: new Set(["n1"]) }),
    );
    updateMoveTreeSelection(container, { currentId: "n2" });
    expect(classesOf(container, "n2")).toContain("is-current");
    expect(classesOf(container, "n1")).not.toContain("is-current");
    expect(container.button("n2").getAttribute("aria-current")).toBe("true");
    expect(container.button("n1").getAttribute("aria-current")).toBeNull();
  });

  it("diffs the on-path set against the new ancestor chain", () => {
    const container = stubMoveTreeContainer(
      renderMoveTree(sampleTree(), { currentId: "n1", pathIds: new Set(["n1"]) }),
      { vars: { alt: "c5" } },
    );
    updateMoveTreeSelection(container, { currentId: "n2", pathIds: new Set(["n1", "n2"]) });
    expect(classesOf(container, "n1")).toContain("on-path");
    expect(classesOf(container, "n2")).toContain("is-current");
    expect(classesOf(container, "n2")).not.toContain("on-path");
    expect(container.variation("c5").classes.has("is-on-path")).toBe(false);
    // Stepping back to the first move drops the descendant from the trail.
    updateMoveTreeSelection(container, { currentId: "n1", pathIds: new Set(["n1"]) });
    expect(classesOf(container, "n2")).not.toContain("on-path");
    expect(classesOf(container, "n1")).toContain("is-current");
    // A branch off the shown line takes the rail with it.
    updateMoveTreeSelection(container, { currentId: "alt", pathIds: new Set(["alt"]) });
    expect(container.variation("c5").classes.has("is-on-path")).toBe(true);
    expect(classesOf(container, "n1")).not.toContain("on-path");
  });

  // Build marks the shown move and nothing else, so it passes no pathIds. The
  // variation rails still follow the selection: they are part of the mark.
  it("moves a variation's rail with no pathIds", () => {
    const container = stubMoveTreeContainer(
      renderMoveTree(sampleTree(), { currentId: "n1" }),
      { vars: { alt: "c5" } },
    );
    updateMoveTreeSelection(container, { currentId: "alt" });
    expect(container.variation("c5").classes.has("is-on-path")).toBe(true);
    updateMoveTreeSelection(container, { currentId: "n2" });
    expect(container.variation("c5").classes.has("is-on-path")).toBe(false);
  });

  // The start position is not a move, so it marks nothing — the state a render
  // of the same position draws.
  it("clears the mark when no move is current", () => {
    const container = stubMoveTreeContainer(
      renderMoveTree(sampleTree(), { currentId: "n2", pathIds: new Set(["n1", "n2"]) }),
    );
    expect(updateMoveTreeSelection(container, { currentId: null })).toBe(true);
    expect(classesOf(container, "n2")).not.toContain("is-current");
    expect(container.button("n2").getAttribute("aria-current")).toBeNull();
  });

  // A move that is not on screen (a collapsed branch) still asks for a render.
  it("reports a move that is not in the tree", () => {
    const container = stubMoveTreeContainer(renderMoveTree(sampleTree(), { currentId: "n1" }));
    expect(updateMoveTreeSelection(container, { currentId: "gone" })).toBe(false);
  });
});