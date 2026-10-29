import { expect, it, vi } from "vitest";
import { bindErrorChart, errorChartHtml } from "./analyze-error-chart.js";

const report = { from: 1, to: 9, errors: [
  { ply: 3, side: "white", grade: "inaccuracy", label: "2.Nf3", loss: 7 },
  { ply: 5, side: "white", grade: "blunder", label: "3.Bb5", loss: 40 },
  { ply: 8, side: "black", grade: "mistake", label: "4…a6", loss: 12 },
] };

it("shows errors in chronological player lanes without numeric axes", () => {
  const markup = String(errorChartHtml(report));
  expect(markup).not.toMatch(/<text|rp-error-ticks|rp-error-scale|rp-error-moves/);
  expect(markup).toContain('rp-error-white g-blunder');
  expect(markup).toContain('rp-error-black g-mistake');
  const tops = [...markup.matchAll(/top:([\d.]+)%/g)].map((m) => Number(m[1]));
  expect(tops).toEqual([25, 25, 75]);
  expect(markup).toContain('left:50%');
  expect(markup).toContain('aria-label="White 3.Bb5 · Blunder · 40% winning chances lost"');
  expect(markup.match(/<button type="button" class="rp-error /g)).toHaveLength(3);
});

it("keeps missing loss distinct from a measured zero", () => {
  const markup = String(errorChartHtml({ ...report, errors: [
    { ...report.errors[0], loss: null },
    { ...report.errors[1], loss: 0 },
  ] }));
  expect(markup).toContain('Inaccuracy · loss unavailable');
  expect(markup).toContain('Blunder · 0% winning chances lost');
  expect(markup).not.toContain('Inaccuracy · 0%');
});

function bind() {
  const readout = { hidden: true, style: {}, setAttribute: vi.fn(), getBoundingClientRect: () => ({ width: 190, height: 28 }) };
  const cursor = { hidden: true, style: {} };
  const listeners = {};
  let focused = null;
  // The first two targets overlap: pointer selection must use the stone's
  // position, not whichever transparent 44px button paints last.
  const centers = [[100, 80], [140, 60], [200, 100]];
  const markers = report.errors.map((row, i) => {
    const el = { dataset: { ply: String(row.ply) }, classList: { toggle: vi.fn(), remove: vi.fn() },
      getBoundingClientRect: () => ({ left: centers[i][0] - 22, top: centers[i][1] - 22, width: 44, height: 44 }) };
    el.closest = () => el;
    el.focus = vi.fn(() => { focused = el; listeners.focusin({ target: el }); });
    return el;
  });
  const plot = { getBoundingClientRect: () => ({ left: 60, width: 160 }) };
  const chart = { getBoundingClientRect: () => ({ left: 40, top: 0, width: 220, height: 160 }), querySelector: (s) => ({ output: readout, ".rp-error-cursor": cursor, ".rp-error-plot": plot, ":focus-visible": focused })[s], querySelectorAll: () => markers, addEventListener: (event, handler) => { listeners[event] = handler; } };
  const jump = vi.fn(), peek = vi.fn();
  const cleanup = bindErrorChart({ querySelector: () => chart }, report, jump, peek);
  return { chart, jump, peek, cleanup, readout, cursor, markers, listeners };
}

it("previews along the error axis without jumping, and restores on leave or disposal", () => {
  const { chart, peek, jump, cleanup } = bind();
  chart.onpointermove({ pointerType: "mouse", clientX: 100 });
  chart.onpointermove({ pointerType: "mouse", clientX: 100 });
  chart.onpointermove({ pointerType: "mouse", clientX: 140 });
  expect(peek.mock.calls).toEqual([[3], [5]]);
  expect(jump).not.toHaveBeenCalled();
  chart.onpointerleave();
  expect(peek).toHaveBeenLastCalledWith(null);
  chart.onpointermove({ pointerType: "mouse", clientX: 200 });
  cleanup();
  expect(peek.mock.calls).toEqual([[3], [5], [null], [8], [null]]);
});

it("touch scrolling never previews, and a committed jump cannot restore an old position", () => {
  const { chart, peek, markers } = bind();
  chart.onpointermove({ pointerType: "touch", clientX: 100 });
  expect(peek).not.toHaveBeenCalled();
  chart.onpointermove({ pointerType: "mouse", clientX: 100 });
  chart.onclick({ detail: 1, clientX: 140, target: markers[1], stopPropagation() {} });
  expect(peek).toHaveBeenLastCalledWith(null);
  const calls = peek.mock.calls.length;
  chart.onpointerleave();
  expect(peek).toHaveBeenCalledTimes(calls);
});

it("scrubs the move axis across the plot and focuses the resolved touch target", () => {
  const { chart, jump, readout, markers } = bind();
  chart.onclick({ detail: 1, clientX: 100, clientY: 80, target: markers[1], stopPropagation() {} });
  expect(jump).toHaveBeenLastCalledWith(3);
  expect(markers[0].focus).toHaveBeenCalledWith({ preventScroll: true });
  chart.onclick({ detail: 1, clientX: 200, clientY: 100, stopPropagation() {} });
  expect(jump).toHaveBeenLastCalledWith(8);
  expect(String(readout.innerHTML)).toContain('4…a6');
  chart.onclick({ detail: 1, clientX: 400, clientY: 0, stopPropagation() {} });
  expect(jump).toHaveBeenLastCalledWith(8);
  expect(jump).toHaveBeenCalledTimes(3);
  chart.onpointermove({ clientX: 140, clientY: 150 });
  expect(String(readout.innerHTML)).toContain('3.Bb5');
  chart.onpointermove({ clientX: 140, clientY: 0 });
  expect(String(readout.innerHTML)).toContain('3.Bb5');
});

it("keeps focused details visible after the pointer leaves and supports native button activation", () => {
  const { chart, jump, readout, cursor, markers } = bind();
  markers[0].focus();
  chart.onpointerleave();
  expect(readout.hidden).toBe(false);
  expect(cursor.hidden).toBe(false);
  chart.onclick({ detail: 0, target: markers[0], stopPropagation() {} });
  expect(jump).toHaveBeenLastCalledWith(3);
  chart.onkeydown({ key: "Escape" });
  expect(readout.hidden).toBe(true);
});

it.each([{}, { shiftKey: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }])(
  "leaves game navigation to the page with modifiers %j, even after End leaves a stale marker focus",
  (modifiers) => {
    const { chart, jump, markers } = bind();
    markers[1].focus();
    // Home/End can move the board without moving chart focus. Every navigation
    // key must keep bubbling so the next arrow uses the board's current move.
    for (const key of ["End", "ArrowRight", "ArrowLeft", "Home", "ArrowRight", "ArrowUp", "ArrowDown"]) {
      const event = { ...modifiers, key, target: markers[1], preventDefault: vi.fn(), stopPropagation: vi.fn() };
      chart.onkeydown(event);
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(event.stopPropagation).not.toHaveBeenCalled();
    }
    expect(jump).not.toHaveBeenCalled();
    expect(markers[1].focus).toHaveBeenCalledOnce();
    expect(markers[0].focus).not.toHaveBeenCalled();
    expect(markers[2].focus).not.toHaveBeenCalled();
  },
);
