// Keep the same color families across boards, like Chessground's drawing brushes.
const BRUSHES = {
  user: ["#4b73c8", "#5869c5"],
  engine: ["#218c64", "#147e83"],
  better: ["#a7529f", "#b04f88"],
  line: ["#c77c23", "#b96236"],
};

function rgb(hex) {
  if (typeof hex !== "string" || !/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex)) {
    throw new TypeError("Expected a hex color");
  }
  const digits = hex.slice(1);
  const full = digits.length === 3 ? [...digits].map((digit) => digit.repeat(2)).join("") : digits;
  return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16));
}

function sample(channels) {
  const [r, g, b] = channels.map((byte) => {
    const value = byte / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    hex: `#${channels.map((byte) => byte.toString(16).padStart(2, "0")).join("")}`,
    y: 0.2126 * r + 0.7152 * g + 0.0722 * b,
    lab: [
      0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
    ],
  };
}

const contrast = (a, b) => (Math.max(a.y, b.y) + 0.05) / (Math.min(a.y, b.y) + 0.05);
const distance = (a, b) => Math.hypot(...a.lab.map((v, i) => v - b.lab[i]));

const OPTIONS = Object.entries(BRUSHES).map(([role, brushes]) => {
  const seeds = brushes.map((brush) => sample(rgb(brush)));
  const options = brushes.flatMap((brush) => {
    const rgbSeed = rgb(brush);
    return [-0.50, -0.34, -0.22, -0.12, -0.06, 0, 0.08, 0.17, 0.27, 0.38, 0.53].map((t) => {
      const to = t < 0 ? 0 : 255;
      const color = sample(rgbSeed.map((byte) => Math.round(byte + (to - byte) * Math.abs(t))));
      return { ...color, shift: Math.min(...seeds.map((seed) => distance(seed, color))) };
    });
  });
  return [role, options];
});

// Main fill colors of the light and dark pieces in board.css.
const PIECES = ["#f9fbff", "#253247"].map((hex) => sample(rgb(hex)));
const TARGET_DISTANCE = 0.13;
const deficit = (target, value) => Math.max(0, 1 - value / target) ** 2;
const visibilityLoss = (color, against, contrastWeight, distanceWeight, targetDistance) =>
  contrastWeight * deficit(3, contrast(color, against))
  + distanceWeight * deficit(targetDistance, distance(color, against));

// Compare the weakest square and piece separately: an arrow that stands out on
// a light square can still vanish over a dark piece. These are soft goals,
// with no cutoff on how light or dark a brush may be.
export function pickBoardArrowColors(lightHex, darkHex) {
  const squares = [sample(rgb(lightHex)), sample(rgb(darkHex))];
  const choices = OPTIONS.map(([, options]) => options.map((color) => ({
    ...color,
    loss: Math.max(...squares.map((square) => visibilityLoss(color, square, 0.55, 1, 0.26)))
      + Math.max(...PIECES.map((piece) => visibilityLoss(color, piece, 0.75, 0.55, 0.28))),
  })));
  let bestScore = Infinity;
  let best;
  function choose(selected, cost) {
    if (cost >= bestScore) return;
    if (selected.length === choices.length) {
      bestScore = cost;
      best = selected;
      return;
    }
    for (const color of choices[selected.length]) {
      const collision = selected.reduce((sum, other) =>
        sum + deficit(TARGET_DISTANCE, distance(color, other)), 0);
      choose([...selected, color], cost + color.loss + 0.60 * color.shift + 1.6 * collision);
    }
  }
  choose([], 0);
  return Object.fromEntries(OPTIONS.map(([role], index) => [role, best[index].hex]));
}
