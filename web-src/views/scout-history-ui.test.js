import { describe, expect, it, vi } from "vitest";
import { createScoutHistoryUi, relativeTime, scoutHistoryRowsHtml } from "./scout-history-ui.js";

// The History list against a small fake DOM: the <details> root, its summary and
// its list, with clicks dispatched as the delegated handler sees them.

const NOW = 1_000_000_000_000;
const entry = (key, savedAt, extra = {}) => ({ key, usernames: [key.split("|")[0]], color: "white", gameCount: 120, savedAt, ...extra });

function fakeHistory(entries) {
  let list = entries.slice();
  return {
    list: vi.fn(async () => list.slice()),
    remove: vi.fn(async (_owner, key) => { list = list.filter((e) => e.key !== key); return true; }),
    clear: vi.fn(async () => { list = []; return true; }),
  };
}

function mount(history, { owner = () => "u1" } = {}) {
  const handlers = {};
  const summary = { focus: vi.fn() };
  const list = { html: "", set innerHTML(value) { this.html = String(value); }, get innerHTML() { return this.html; }, querySelectorAll: () => [] };
  const root = {
    hidden: true, open: false,
    querySelector: (sel) => (sel === "summary" ? summary : sel === ".scout-history-list" ? list : null),
    addEventListener: (type, fn) => { handlers[type] = fn; },
  };
  const onOpen = vi.fn();
  const ui = createScoutHistoryUi({ root, history, owner, onOpen, now: () => NOW });
  const press = (attr, value) => handlers.click({
    target: { dataset: {}, closest: (sel) => (sel === `[${attr}]` ? { dataset: value, closest: () => null } : null) },
  });
  return { ui, root, summary, list, onOpen, handlers, press };
}

describe("scout history list", () => {
  it("is hidden while empty and lists runs as name · colour · games · when", async () => {
    const empty = mount(fakeHistory([]));
    await empty.ui.refresh();
    expect(empty.root.hidden).toBe(true);

    const { ui, root, list } = mount(fakeHistory([entry("rival|white", NOW - 3 * 3600_000), entry("other|white", NOW - 2 * 86400_000)]));
    await ui.refresh();
    expect(root.hidden).toBe(false);
    expect(list.innerHTML).toContain("<b>rival</b>");
    expect(list.innerHTML).toContain("as White · 120 games · 3 h ago");
    expect(list.innerHTML).toContain('aria-label="Open rival, as White · 120 games · 3 h ago"');
    expect(list.innerHTML).toContain('aria-label="Delete other, as White · 120 games · 2 days ago"');
  });

  it("escapes a saved name", () => {
    const rows = scoutHistoryRowsHtml([entry("x|both", NOW, { usernames: ["<img onerror=x>"], color: "both" })], NOW).join("");
    expect(rows).not.toContain("<img");
    expect(rows).toContain("both colours");
  });

  it("Open closes the list, returns focus and opens that run", async () => {
    const view = mount(fakeHistory([entry("rival|white", NOW)]));
    await view.ui.refresh();
    view.root.open = true;
    await view.press("data-scout-history-open", { scoutHistoryOpen: "rival|white" });
    expect(view.root.open).toBe(false);
    expect(view.summary.focus).toHaveBeenCalled();
    expect(view.onOpen).toHaveBeenCalledWith(expect.objectContaining({ key: "rival|white", color: "white" }));
  });

  it("Delete removes one run; Clear all empties and hides the list", async () => {
    const history = fakeHistory([entry("a|white", NOW), entry("b|white", NOW - 1)]);
    const view = mount(history);
    await view.ui.refresh();
    await view.press("data-scout-history-delete", { scoutHistoryDelete: "a|white" });
    expect(history.remove).toHaveBeenCalledWith("u1", "a|white");
    expect(view.list.innerHTML).not.toContain("<b>a</b>");
    expect(view.list.innerHTML).toContain("<b>b</b>");
    expect(view.summary.focus).toHaveBeenCalled();

    view.root.open = true;
    await view.press("data-scout-history-clear", {});
    expect(history.clear).toHaveBeenCalledWith("u1");
    expect(view.root.hidden).toBe(true);
    expect(view.root.open).toBe(false);
  });

  it("Escape closes the open list and puts focus back on History", async () => {
    const view = mount(fakeHistory([entry("a|white", NOW)]));
    await view.ui.refresh();
    view.root.open = true;
    const event = { key: "Escape", preventDefault: vi.fn() };
    view.handlers.keydown(event);
    expect(view.root.open).toBe(false);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(view.summary.focus).toHaveBeenCalled();
  });

  it("opening the list re-reads it; with no account it lists nothing", async () => {
    const history = fakeHistory([entry("a|white", NOW)]);
    const view = mount(history);
    view.root.open = true;
    view.handlers.toggle();
    await vi.waitFor(() => expect(view.root.hidden).toBe(false));
    const guest = mount(history, { owner: () => null });
    await guest.ui.refresh();
    expect(guest.root.hidden).toBe(true);
  });

  it("says when in words", () => {
    expect(relativeTime(NOW - 10_000, NOW)).toBe("just now");
    expect(relativeTime(NOW - 5 * 60_000, NOW)).toBe("5 min ago");
    expect(relativeTime(NOW - 30 * 3600_000, NOW)).toBe("yesterday");
  });
});
