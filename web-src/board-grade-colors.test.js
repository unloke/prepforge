import { describe, expect, it } from "vitest";
import { gradeSquareTones } from "./board-grade-colors.js";
import { hexLab } from "./board-arrow-colors.js";
import { eagerCss } from "./test-styles-source.js";
import { BOARD_MODES } from "./theme.js";

const tokensCss = eagerCss.slice(eagerCss.indexOf("/* Design tokens"));
const lightBlock = tokensCss.slice(0, tokensCss.indexOf(":root[data-theme=\"dark\"]"));
const darkBlock = tokensCss.slice(tokensCss.indexOf(":root[data-theme=\"dark\"]"), tokensCss.indexOf("/* ---- Board colour themes"));
const groups = {
  good: "--good",
  great: "--great",
  brilliant: "--brilliant",
  inaccuracy: "--inaccuracy",
  mistake: "--warn",
  blunder: "--danger",
  missed: "--missed",
};

function token(block, name) {
  const line = block.split("\n").map((x) => x.trim()).find((x) => x.startsWith(`${name}:`));
  return line?.split(":")[1]?.trim().replace(/;$/, "");
}
function parseOklab(value) {
  const match = /^oklab\(([\d.]+) ([-\d.]+) ([-\d.]+)\)$/.exec(value);
  return match?.slice(1).map(Number);
}
const distance = (a, b) => Math.hypot(...a.map((x, i) => x - b[i]));
const chromaDistance = (a, b) => Math.hypot(a[1] - b[1], a[2] - b[2]);
function hueAngle(lab) {
  return Math.atan2(lab[2], lab[1]);
}
function hueDifference(a, b) {
  const diff = Math.abs(hueAngle(a) - hueAngle(b));
  return Math.min(diff, Math.PI * 2 - diff);
}
const boardRows = [...tokensCss.matchAll(/\.board-color-swatch\[data-board="(.*?)"\][^{]*\{\s*--square-light:\s*(#[\da-f]+);\s*--square-dark:\s*(#[\da-f]+)/g)]
  .map((match) => ({ name: match[1], light: match[2], dark: match[3] }));

describe("adaptive grade square tones", () => {
  it("fits every semantic grade to every production board, theme and parity without hue rotation", () => {
    expect(boardRows.map((row) => row.name).sort()).toEqual([...BOARD_MODES].sort());
    for (const board of boardRows) for (const [theme, block] of [["light", lightBlock], ["dark", darkBlock]]) {
      for (const [group, tokenName] of Object.entries(groups)) {
        const ink = token(block, tokenName);
        expect(ink, `${board.name} ${theme} ${group}`).toMatch(/^#[\da-f]{6}$/);
        const tones = gradeSquareTones(board.light, board.dark, ink);
        const badgeLab = hexLab(ink);
        const scaledBadge = [badgeLab[0], badgeLab[1] * 0.9, badgeLab[2] * 0.9];
        for (const [parity, nativeHex] of [["light", board.light], ["dark", board.dark]]) {
          const lab = parseOklab(tones[parity]);
          expect(lab, `${board.name} ${theme} ${group} ${parity} parses as opaque OKLab`).toBeTruthy();
          expect(hueDifference(lab, scaledBadge)).toBeLessThan(0.002);
          expect(chromaDistance(lab, scaledBadge)).toBeLessThan(0.0002);
          expect(distance(lab, hexLab(nativeHex))).toBeGreaterThanOrEqual(0.09);
        }
        expect(parseOklab(tones.light)[0]).toBeGreaterThan(parseOklab(tones.dark)[0] + 0.06);
      }
    }
  });

  it("keeps the green-board check green rather than accent blue and separates the confusable families", () => {
    expect(eagerCss).toContain('.chessboard[data-move-class="good"]');
    expect(eagerCss).toContain('--grade-ink: var(--good);');
    const tones = Object.fromEntries(Object.entries({
      good: "#1d8a4f", great: "#4a7fb5", brilliant: "#2f7fe0", inaccuracy: "#c98a2b", mistake: "#b26a00",
    }).map(([group, ink]) => [group, parseOklab(gradeSquareTones("#eeeed2", "#769656", ink).light)]));
    expect(tones.good[1]).toBeLessThan(0);
    expect(tones.good[2]).toBeGreaterThan(0);
    expect(distance(tones.good, tones.great)).toBeGreaterThanOrEqual(0.11);
    expect(distance(tones.good, tones.brilliant)).toBeGreaterThanOrEqual(0.11);
    expect(distance(tones.great, tones.brilliant)).toBeGreaterThan(0.01);
    expect(distance(tones.inaccuracy, tones.mistake)).toBeGreaterThan(0.01);
  });

  it("handles independent custom squares and rejects a meaningless unknown color", () => {
    const tones = gradeSquareTones("#123456", "#fedcba", "#1d8a4f");
    expect(parseOklab(tones.light)).toBeTruthy();
    expect(parseOklab(tones.dark)).toBeTruthy();
    expect(parseOklab(tones.light)[0]).toBeGreaterThan(parseOklab(tones.dark)[0] + 0.06);
    expect(() => gradeSquareTones("#123456", "#fedcba", "not-a-color")).toThrow(TypeError);
  });
});
