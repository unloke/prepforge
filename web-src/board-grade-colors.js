import { hexLab } from "./board-arrow-colors.js";

const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const cssNumber = (value) => String(Number(value.toFixed(4)));

function preferredLightness(squareLab, badgeLab) {
  const [, a, b] = badgeLab;
  return 0.51 * squareLab[0] + 0.49 * badgeLab[0] - 0.8 * (Math.hypot(a, b) - 0.12);
}

function candidatesFor(squareLab, badgeLab, a, b) {
  const preferred = clamp(preferredLightness(squareLab, badgeLab), 0.46, 0.89);
  const levels = [];
  for (let l = 0.46; l < 0.89; l += 0.02) levels.push(Number(l.toFixed(2)));
  levels.push(preferred);
  return [...new Set(levels)].sort((x, y) => x - y).map((l) => {
    const lab = [l, a, b];
    const closeness = Math.max(0, 0.11 - distance(lab, squareLab));
    return {
      l,
      // The objective already pushes away from the native square; this floor
      // keeps a near-miss optimum visibly distinct instead of merely cheaper.
      usable: distance(lab, squareLab) >= 0.092,
      local: (l - preferred) ** 2 + 16 * closeness ** 2,
    };
  });
}

// Fit the two opaque last-move washes to the active board without rotating the
// badge hue. Chromatic nearness is only a soft constraint: when the grade hue
// is already close to a square, the answer is a lightness step, not a new hue.
export function gradeSquareTones(lightHex, darkHex, inkHex) {
  const lightSquare = hexLab(lightHex);
  const darkSquare = hexLab(darkHex);
  const badge = hexLab(inkHex);
  const a = 0.90 * badge[1];
  const b = 0.90 * badge[2];
  const lightCandidates = candidatesFor(lightSquare, badge, a, b);
  const darkCandidates = candidatesFor(darkSquare, badge, a, b);
  let bestCost = Infinity;
  let best = null;
  for (const light of lightCandidates) for (const dark of darkCandidates) {
    if (!light.usable || !dark.usable || light.l <= dark.l + 0.06) continue;
    const separation = Math.max(0, 0.085 - (light.l - dark.l));
    const cost = light.local + dark.local + 18 * separation ** 2;
    if (cost < bestCost) {
      bestCost = cost;
      best = [light.l, dark.l];
    }
  }
  if (!best) throw new Error("No contrasting grade tones");
  const chroma = `${cssNumber(a)} ${cssNumber(b)}`;
  return {
    light: `oklab(${cssNumber(best[0])} ${chroma})`,
    dark: `oklab(${cssNumber(best[1])} ${chroma})`,
  };
}
