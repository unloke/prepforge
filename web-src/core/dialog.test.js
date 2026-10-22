// A menu's trigger closes the menu it opened. The press on it light-dismisses
// the open popover first, so without help the click that follows would open it
// straight back up. Chromium ignores showPopover's `source`, so dialog.js
// remembers each open popover's opener and swallows that one click.
import { beforeEach, describe, expect, it } from "vitest";

function makeTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, fn, capture) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push({ fn, capture: Boolean(capture) });
    },
    removeEventListener(type, fn) {
      listeners.set(type, (listeners.get(type) || []).filter((l) => l.fn !== fn));
    },
    listeners,
  };
}

const doc = Object.assign(makeTarget(), { activeElement: null, body: null });
doc.body = { append() {} };
globalThis.document = doc;

function element(name) {
  const node = Object.assign(makeTarget(), {
    name,
    attrs: new Map(),
    children: new Set(),
    isConnected: true,
    hasAttribute: (k) => node.attrs.has(k),
    getAttribute: (k) => node.attrs.get(k) ?? null,
    setAttribute: (k, v) => node.attrs.set(k, String(v)),
    contains: (other) => other === node || node.children.has(other),
    closest: () => null,
    getClientRects: () => [1],
    focus() { doc.activeElement = node; },
  });
  return node;
}

function popover(name) {
  const el = element(name);
  el.open = false;
  el.matches = (selector) => selector === ":popover-open" && el.open;
  el.showPopover = () => { el.open = true; };
  el.hidePopover = () => {
    if (!el.open) return;
    el.open = false;
    for (const { fn } of el.listeners.get("toggle") || []) fn({ newState: "closed" });
  };
  return el;
}

// Dispatches through the document's capture listeners, then the target's own
// handler unless a capture listener stopped it.
function press(target, { lightDismiss = [] } = {}) {
  const down = { target, preventDefault() {}, stopImmediatePropagation() {} };
  for (const { fn, capture } of doc.listeners.get("pointerdown") || []) if (capture) fn(down);
  for (const el of lightDismiss) el.hidePopover();
  const click = {
    target,
    defaultPrevented: false,
    stopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopImmediatePropagation() { this.stopped = true; },
  };
  for (const { fn, capture } of doc.listeners.get("click") || []) if (capture && !click.stopped) fn(click);
  if (!click.stopped) target.onclick?.(click);
  return click;
}

const { openPopover } = await import("./dialog.js");

describe("openPopover toggle", () => {
  let trigger;
  let menu;
  beforeEach(() => {
    trigger = element("trigger");
    menu = popover("menu");
    trigger.onclick = () => openPopover(menu, { opener: trigger });
  });

  it("opens on the first press of its trigger", () => {
    const click = press(trigger);
    expect(click.stopped).toBe(false);
    expect(menu.open).toBe(true);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  it("closes, and stays closed, on a second press of its trigger", () => {
    press(trigger);
    const click = press(trigger, { lightDismiss: [menu] });
    expect(click.stopped).toBe(true);
    expect(click.defaultPrevented).toBe(true);
    expect(menu.open).toBe(false);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("opens again on the third press", () => {
    press(trigger);
    press(trigger, { lightDismiss: [menu] });
    const click = press(trigger);
    expect(click.stopped).toBe(false);
    expect(menu.open).toBe(true);
  });

  it("counts a press on a child of the trigger as a press on the trigger", () => {
    const icon = element("icon");
    trigger.children.add(icon);
    press(trigger);
    const click = press(icon, { lightDismiss: [menu] });
    expect(click.stopped).toBe(true);
    expect(menu.open).toBe(false);
  });

  it("lets a press elsewhere through while the menu is open", () => {
    const other = element("other");
    let clicked = false;
    other.onclick = () => { clicked = true; };
    press(trigger);
    const click = press(other, { lightDismiss: [menu] });
    expect(click.stopped).toBe(false);
    expect(clicked).toBe(true);
  });

  it("forgets the trigger once the menu closed some other way", () => {
    press(trigger);
    menu.hidePopover(); // Escape
    const click = press(trigger);
    expect(click.stopped).toBe(false);
    expect(menu.open).toBe(true);
  });
});
