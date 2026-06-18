import { describe, expect, it, vi } from "vitest";

import { createMoveTreeRenderer } from "./movetree.js";

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

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

function stubMoveTreeContainer(html) {
  const handlers = [];
  const buttons = [...html.matchAll(/data-node-id="([^"]+)"/g)].map((match) => {
    const button = {
      dataset: { nodeId: match[1] },
      addEventListener(type, fn) {
        handlers.push({ button, type, fn });
      },
      blur: vi.fn(),
    };
    return button;
  });
  return {
    querySelectorAll(selector) {
      if (selector === ".mtree-move[data-node-id]") return buttons;
      return [];
    },
    click(nodeId) {
      const entry = handlers.find((h) => h.type === "click" && h.button.dataset.nodeId === nodeId);
      entry?.fn({ currentTarget: entry.button });
    },
    contextmenu(nodeId, event) {
      const entry = handlers.find(
        (h) => h.type === "contextmenu" && h.button.dataset.nodeId === nodeId
      );
      entry?.fn(event);
    },
  };
}

describe("createMoveTreeRenderer", () => {
  const { renderMoveTree, bindMoveTreeClicks } = createMoveTreeRenderer({ escapeHtml });

  it("renders an empty-state wrapper when the root has no children", () => {
    const html = renderMoveTree({ id: "root", children: [] }, { emptyText: "Nothing here." });
    expect(html).toContain('class="empty-state"');
    expect(html).toContain("Nothing here.");
  });

  it("renders mainline tokens and marks the current node", () => {
    const root = sampleTree();
    const html = renderMoveTree(root, { currentId: "n2", pathIds: new Set(["n1", "n2"]) });
    expect(html).toContain('data-node-id="n1"');
    expect(html).toContain('<span class="mtree-san">e4</span>');
    expect(html).toContain('data-node-id="n2"');
    expect(html).toContain("is-current");
    expect(html).toContain("on-path");
    expect(html).toContain('class="mtree-var"');
    expect(html).toContain('<span class="mtree-san">c5</span>');
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
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img onerror=&quot;x&quot;&gt;");
  });

  it("binds move clicks and optional context-menu callbacks", () => {
    const html = renderMoveTree(sampleTree(), { currentId: "n1" });
    const container = stubMoveTreeContainer(html);
    const onSelect = vi.fn();
    const onContext = vi.fn();
    bindMoveTreeClicks(container, onSelect, onContext);

    container.click("n2");
    expect(onSelect).toHaveBeenCalledWith("n2");

    const event = { preventDefault: vi.fn() };
    container.contextmenu("alt", event);
    expect(onContext).toHaveBeenCalledWith(event, "alt");
  });
});