// Keep the same color families across boards, like Chessground's drawing brushes.
const BRUSHES = {
  user: ["#163da1", "#245bdb", "#67a0ff"],
  engine: ["#005141", "#00846a", "#38cda3"],
  better: ["#871444", "#c42761", "#ff77a6"],
  line: ["#814000", "#bd6607", "#ffb539"],
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

// Main fill colors of the light and dark pieces in board.css.
const PIECES = ["#f9fbff", "#253247"].map((hex) => sample(rgb(hex)));
const deficit = (target, value) => Math.max(0, 1 - value / target) ** 2;
const OPTIONS = Object.entries(BRUSHES).map(([role, brushes]) => [role, brushes.map((brush) => sample(rgb(brush)))]);

// Pick one of each role's three handpicked shades. Squares dominate the fit,
// collisions between simultaneous roles are nearly as important, pieces count
// less, and the middle shade is mildly preferred over either extreme.
export function pickBoardArrowColors(lightHex, darkHex) {
  const squares = [sample(rgb(lightHex)), sample(rgb(darkHex))];
  let bestScore = Infinity;
  let best;
  for (let user = 0; user < 3; user++) for (let engine = 0; engine < 3; engine++)
    for (let better = 0; better < 3; better++) for (let line = 0; line < 3; line++) {
      const indexes = { user, engine, better, line };
      const colors = Object.fromEntries(OPTIONS.map(([role, options]) => [role, options[indexes[role]]]));
      const squareLosses = Object.values(colors).map((color) => Math.max(...squares.map((square) =>
        deficit(3, contrast(color, square)) + 0.5 * deficit(0.25, distance(color, square))
      )));
      const roles = Object.keys(colors);
      const pairCollisions = [];
      for (let i = 0; i < roles.length; i++) for (let j = i + 1; j < roles.length; j++) {
        pairCollisions.push(deficit(0.23, distance(colors[roles[i]], colors[roles[j]])));
      }
      const pieceLosses = Object.values(colors).map((color) => Math.max(...PIECES.map((piece) => deficit(2, contrast(color, piece)))));
      const score = Math.max(...squareLosses) + 0.35 * squareLosses.reduce((a, b) => a + b, 0)
        + 3 * Math.max(...pairCollisions) + pairCollisions.reduce((a, b) => a + b, 0)
        + 0.18 * pieceLosses.reduce((a, b) => a + b, 0)
        + 0.025 * Object.values(indexes).filter((index) => index !== 1).length;
      if (score < bestScore) {
        bestScore = score;
        best = colors;
      }
    }
  return Object.fromEntries(Object.entries(best).map(([role, color]) => [role, color.hex]));
}
