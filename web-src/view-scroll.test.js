import { describe, expect, it } from "vitest";
import { resetViewScroll } from "./view-scroll.js";

function fakeWindow(offset, height = 660) {
  const top = {
    scrollTop: offset,
    clientHeight: height,
    get scrollHeight() { return Math.max(height, this.scrollTop + this.clientHeight); },
  };
  return { document: { scrollingElement: top, documentElement: top }, top };
}

describe("resetViewScroll", () => {
  it("puts a page left mid-scroll back at its top", () => {
    const win = fakeWindow(1500);
    expect(resetViewScroll(win)).toBe(1500);
    expect(win.top.scrollTop).toBe(0);
  });

  it("leaves a page that already fits the screen still", () => {
    const win = fakeWindow(0);
    expect(resetViewScroll(win)).toBe(0);
    expect(win.top.scrollTop).toBe(0);
  });

  it("survives a window without a document", () => {
    expect(resetViewScroll({})).toBe(0);
    expect(resetViewScroll()).toBe(0);
  });
});
