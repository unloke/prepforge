// A modal closed with its close() leaves the DOM once its exit transition has
// played. The transition starts when the dialog closes, so close() has to look
// for it after closing: looked for before, there is none yet, and the closed
// dialog stayed in the document. A Build smoke then found two Generate dialogs
// by the same name while the old one faded out.
import { describe, expect, it } from "vitest";

function target() {
  const listeners = new Map();
  return {
    addEventListener(type, fn) { listeners.set(type, [...(listeners.get(type) || []), fn]); },
    removeEventListener(type, fn) { listeners.set(type, (listeners.get(type) || []).filter((l) => l !== fn)); },
    listeners,
  };
}

globalThis.document = Object.assign(target(), { activeElement: null, body: { append() {} } });

function fakeDialog() {
  let finishExit;
  const exit = { finished: new Promise((resolve) => { finishExit = resolve; }) };
  const dialog = Object.assign(target(), {
    open: false,
    isConnected: true,
    removed: false,
    exiting: false,
    hasAttribute: () => true,
    querySelector: () => null,
    showModal() { this.open = true; },
    // The exit transition (display/overlay allow-discrete) runs from the close.
    close() { this.open = false; this.exiting = true; },
    getAnimations() { return this.exiting ? [exit] : []; },
    remove() { this.removed = true; this.isConnected = false; },
  });
  return { dialog, finishExit };
}

const { openModal } = await import("./dialog.js");

describe("openModal close()", () => {
  it("removes the dialog after the exit transition it starts", async () => {
    const { dialog, finishExit } = fakeDialog();
    const close = openModal(dialog);
    close();
    expect(dialog.open).toBe(false);
    expect(dialog.removed).toBe(false);
    finishExit();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dialog.removed).toBe(true);
  });

  it("removes it at once when nothing animates (reduced motion)", () => {
    const { dialog } = fakeDialog();
    dialog.close = function () { this.open = false; };
    const close = openModal(dialog);
    close();
    expect(dialog.removed).toBe(true);
  });

  it("leaves a kept dialog in the document", async () => {
    const { dialog, finishExit } = fakeDialog();
    const close = openModal(dialog, { keep: true });
    close();
    finishExit();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dialog.removed).toBe(false);
  });
});
