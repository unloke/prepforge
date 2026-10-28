import { expect, it, vi } from "vitest";
import { bindErrorChart, errorChartHtml } from "./analyze-error-chart.js";

const report = { from: 1, to: 9, errors: [
  { ply: 3, side: "white", grade: "inaccuracy", label: "2.Nf3", loss: 7 },
  { ply: 5, side: "white", grade: "blunder", label: "3.Bb5", loss: 40 },
  { ply: 8, side: "black", grade: "mistake", label: "4…a6", loss: 12 },
] };

it("encodes side, severity and magnitude without permanent text labels", () => {
  const markup = String(errorChartHtml(report));
  expect(markup).not.toMatch(/<text|rp-error-axis|rp-error-ticks/);
  expect(markup).toContain('rp-error-white g-blunder');
  expect(markup).toContain('rp-error-black g-mistake');
  const heights = [...markup.matchAll(/class="rp-error-bar"[^>]+height="([^"]+)"/g)].map((m) => Number(m[1]));
  expect(heights[1] / heights[0]).toBeCloseTo(40 / 7);
  expect(markup).toContain('aria-label="White 3.Bb5 · Blunder · 40% winning chances lost"');
});

it("selects the nearest error in the touched player's lane and supports keyboard", () => {
  const readout = { hidden: true };
  const chart = { querySelector: (s) => s === "output" ? readout : { getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 140 }) }, querySelectorAll: () => [] };
  const jump = vi.fn();
  bindErrorChart({ querySelector: () => chart }, report, jump);
  chart.onclick({ clientX: 320, clientY: 35, stopPropagation() {} });
  expect(jump).toHaveBeenLastCalledWith(5);
  chart.onclick({ clientX: 320, clientY: 90, stopPropagation() {} });
  expect(jump).toHaveBeenLastCalledWith(8);
  expect(readout.textContent).toContain("Black 4…a6");
  chart.onpointerleave();
  expect(readout.hidden).toBe(true);
  const preventDefault = vi.fn();
  chart.onkeydown({ key: "Enter", target: { dataset: { ply: "3" } }, preventDefault });
  expect(jump).toHaveBeenLastCalledWith(3);
  expect(preventDefault).toHaveBeenCalledOnce();
});
