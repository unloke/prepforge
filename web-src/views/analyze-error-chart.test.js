import { expect, it, vi } from "vitest";
import { bindErrorChart, errorChartHtml } from "./analyze-error-chart.js";

const report = { from: 1, to: 9, errors: [
  { ply: 3, side: "white", grade: "inaccuracy", label: "2.Nf3", loss: 7 },
  { ply: 5, side: "white", grade: "blunder", label: "3.Bb5", loss: 40 },
  { ply: 8, side: "black", grade: "mistake", label: "4…a6", loss: 12 },
] };

it("encodes move position, player, grade and proportional loss without standing labels", () => {
  const markup = String(errorChartHtml(report));
  expect(markup).not.toMatch(/<text|rp-error-ticks/);
  expect(markup).toContain('rp-error-white g-blunder');
  expect(markup).toContain('rp-error-black g-mistake');
  const tops = [...markup.matchAll(/top:([\d.]+)%/g)].map((m) => Number(m[1]));
  expect((50 - tops[1]) / (50 - tops[0])).toBeCloseTo(40 / 7);
  expect(tops[1]).toBe(8);
  expect(tops[2]).toBeGreaterThan(50);
  expect(markup).toContain('shared scale 0 to 40%');
  expect(markup).toContain('left:25%');
  expect(markup).toContain('aria-label="White 3.Bb5 · Blunder · 40% winning chances lost"');
  expect(markup.match(/<button type="button" class="rp-error /g)).toHaveLength(3);
});

it("keeps missing loss distinct from a measured zero", () => {
  const markup = String(errorChartHtml({ ...report, errors: [
    { ...report.errors[0], loss: null },
    { ...report.errors[1], loss: 0 },
  ] }));
  expect(markup).toContain('g-inaccuracy is-unknown');
  expect(markup).toContain('Inaccuracy · loss unavailable');
  expect(markup).toContain('Blunder · 0% winning chances lost');
  expect(markup).not.toContain('Inaccuracy · 0%');
});

function bind() {
  const readout = { hidden: true, setAttribute: vi.fn() };
  const cursor = { hidden: true, style: {} };
  const listeners = {};
  let focused = null;
  // The first two targets overlap: pointer selection must use the stone's
  // position, not whichever transparent 44px button paints last.
  const centers = [[100, 80], [120, 60], [240, 100]];
  const markers = report.errors.map((row, i) => {
    const el = { dataset: { ply: String(row.ply) }, classList: { toggle: vi.fn(), remove: vi.fn() },
      getBoundingClientRect: () => ({ left: centers[i][0] - 22, top: centers[i][1] - 22, width: 44, height: 44 }) };
    el.closest = () => el;
    el.focus = vi.fn(() => { focused = el; listeners.focusin({ target: el }); });
    return el;
  });
  const chart = { querySelector: (s) => ({ output: readout, ".rp-error-cursor": cursor, ":focus": focused })[s], querySelectorAll: () => markers, addEventListener: (event, handler) => { listeners[event] = handler; } };
  const jump = vi.fn();
  bindErrorChart({ querySelector: () => chart }, report, jump);
  return { chart, jump, readout, cursor, markers };
}

it("resolves overlapping touch targets by distance and ignores empty chart space", () => {
  const { chart, jump, readout, markers } = bind();
  chart.onclick({ detail: 1, clientX: 100, clientY: 80, target: markers[1], stopPropagation() {} });
  expect(jump).toHaveBeenLastCalledWith(3);
  chart.onclick({ detail: 1, clientX: 240, clientY: 100, stopPropagation() {} });
  expect(jump).toHaveBeenLastCalledWith(8);
  expect(String(readout.innerHTML)).toContain('4…a6');
  chart.onclick({ detail: 1, clientX: 400, clientY: 0, stopPropagation() {} });
  expect(jump).toHaveBeenCalledTimes(2);
});

it("keeps focused details visible after the pointer leaves and supports native button activation", () => {
  const { chart, jump, readout, cursor, markers } = bind();
  markers[0].focus();
  chart.onpointerleave();
  expect(readout.hidden).toBe(false);
  expect(cursor.hidden).toBe(false);
  chart.onclick({ detail: 0, target: markers[0], stopPropagation() {} });
  expect(jump).toHaveBeenLastCalledWith(3);
  const event = { key: "ArrowLeft", target: markers[0], preventDefault: vi.fn(), stopPropagation: vi.fn() };
  chart.onkeydown(event);
  expect(markers[2].focus).toHaveBeenCalledOnce();
  expect(jump).toHaveBeenLastCalledWith(8);
  expect(event.stopPropagation).toHaveBeenCalledOnce();
  chart.onkeydown({ key: "Escape" });
  expect(readout.hidden).toBe(true);
});
