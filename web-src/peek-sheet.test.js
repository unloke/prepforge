// The phone peek sheet: the pane switch under a board is a sheet's head. The
// home pane reads in the peek, another pane rises, and tapping the open tab or
// dragging the switch overrides that until another pane opens.
import { afterEach, expect, it } from "vitest";
import { sheetIsUp, wirePeekSheets } from "./peek-sheet.js";

function fakeTab(pane, selected) {
  const attrs = { "aria-selected": String(selected) };
  return {
    dataset: { pane },
    getAttribute: (k) => attrs[k] ?? null,
    setAttribute: (k, v) => { attrs[k] = String(v); },
    removeAttribute: (k) => { delete attrs[k]; },
    closest: function (sel) { return sel === "[role=tab]" ? this : null; },
    attrs,
  };
}

function setup({ phone = true } = {}) {
  const view = { dataset: { pane: "coach" } };
  const tabs = [fakeTab("coach", true), fakeTab("engine", false), fakeTab("report", false)];
  const handlers = {};
  const list = {
    dataset: { peekHome: "coach" },
    closest: (sel) => (sel === ".view" ? view : null),
    querySelectorAll: () => tabs,
    addEventListener: (type, fn) => { (handlers[type] ||= []).push(fn); },
  };
  globalThis.window = { matchMedia: () => ({ matches: phone }) };
  wirePeekSheets({ querySelectorAll: () => [list] });
  const fire = (type, event) => handlers[type]?.forEach((fn) => fn({ stopImmediatePropagation() {}, preventDefault() {}, ...event }));
  // The view's own handler: selecting a tab sets the pane.
  const select = (tab) => {
    fire("click", { target: tab });
    tabs.forEach((t) => t.setAttribute("aria-selected", String(t === tab)));
    view.dataset.pane = tab.dataset.pane;
  };
  return { view, tabs, fire, select };
}

afterEach(() => { delete globalThis.window; });

it("is up off the home pane unless the user chose otherwise", () => {
  expect(sheetIsUp({ dataset: { pane: "coach" } }, "coach")).toBe(false);
  expect(sheetIsUp({ dataset: { pane: "report" } }, "coach")).toBe(true);
  expect(sheetIsUp({ dataset: {} }, "moves")).toBe(false);
  expect(sheetIsUp({ dataset: { pane: "report", sheet: "peek" } }, "coach")).toBe(false);
  expect(sheetIsUp({ dataset: { pane: "coach", sheet: "up" } }, "coach")).toBe(true);
});

it("tapping the open tab toggles the sheet; opening another pane clears the choice", () => {
  const { view, tabs, select } = setup();
  select(tabs[0]);
  expect(view.dataset.sheet).toBe("up");
  expect(tabs[0].attrs["aria-expanded"]).toBe("true");
  select(tabs[0]);
  expect(view.dataset.sheet).toBe("peek");
  select(tabs[2]);
  expect(view.dataset.sheet).toBeUndefined();
  expect(sheetIsUp(view, "coach")).toBe(true);
});

it("a vertical drag on the switch raises or lowers the sheet and swallows its click", () => {
  const { view, tabs, fire } = setup();
  fire("pointerdown", { clientY: 500 });
  fire("pointermove", { clientY: 460 });
  expect(view.dataset.sheet).toBe("up");
  let swallowed = false;
  fire("click", { target: tabs[1], stopImmediatePropagation: () => { swallowed = true; } });
  expect(swallowed).toBe(true);
  fire("pointerdown", { clientY: 300 });
  fire("pointermove", { clientY: 340 });
  expect(view.dataset.sheet).toBe("peek");
});

it("does nothing off a phone", () => {
  const { view, tabs, select, fire } = setup({ phone: false });
  select(tabs[0]);
  fire("pointerdown", { clientY: 500 });
  fire("pointermove", { clientY: 400 });
  expect(view.dataset.sheet).toBeUndefined();
});
