// Drawing inks are fitted as they will appear on the board: each translucent
// brush is first composited over both opaque squares, then compared in OKLab.
const PALETTES = {
  user: ["#163da1", "#245bdb", "#67a0ff", "#342079", "#aa7aff"],
  engine: ["#005141", "#00846a", "#38cda3", "#55109a", "#ac66fc"],
  better: ["#871444", "#c42761", "#ff77a6", "#9c2018", "#ff6846"],
  line: ["#814000", "#bd6607", "#ffb539", "#064854", "#00d1d7"],
};

export function rgb(hex) {
  if (typeof hex !== "string" || !/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex)) {
    throw new TypeError("Expected a hex color");
  }
  const digits = hex.slice(1);
  const full = digits.length === 3 ? [...digits].map((digit) => digit.repeat(2)).join("") : digits;
  return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16));
}

export function sample(channels) {
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

export function hexSample(hex) {
  return sample(rgb(hex));
}

export function hexLab(hex) {
  return hexSample(hex).lab;
}

export function labDistance(a, b) {
  return Math.hypot(...a.lab.map((value, i) => value - b.lab[i]));
}

const abDistance = (a, b) => Math.hypot(a.lab[1] - b.lab[1], a.lab[2] - b.lab[2]);
const penalty = (target, value) => Math.max(0, 1 - value / target) ** 2;
const ratio = (a, b) => (Math.max(a.y, b.y) + 0.05) / (Math.min(a.y, b.y) + 0.05);

function blendSample(hex, baseHex, alpha) {
  const ink = rgb(hex);
  const base = rgb(baseHex);
  return sample(ink.map((channel, i) => Math.round(alpha * channel + (1 - alpha) * base[i])));
}

// Pick one shade for each simultaneous role. Each candidate's composited
// square views and local losses are precomputed outside the five-way choice;
// pair comparisons reuse those cached composites. The fit sees the colors
// exactly as the one translucent SVG group composites them.
export function pickBoardArrowColors(lightHex, darkHex, alpha = 0.56) {
  const squaresHex = [lightHex, darkHex];
  const ground = squaresHex.map(hexSample);
  const colors = Object.entries(PALETTES).map(([role, palette]) => [role, palette.map((hex, index) => {
    const view = squaresHex.map((base) => blendSample(hex, base, alpha));
    const loss = Math.max(...view.map((composite, squareIndex) =>
      penalty(0.21, labDistance(composite, ground[squareIndex]))
      + 0.8 * penalty(2.35, ratio(composite, ground[squareIndex]))
      + 2 * penalty(0.115, abDistance(composite, ground[squareIndex]))
    ));
    return { hex, view, loss, cost: loss + (index >= 3 ? 0.16 : 0) };
  })]);

  let bestScore = Infinity;
  let best;
  for (const user of colors[0][1]) for (const engine of colors[1][1])
    for (const better of colors[2][1]) for (const line of colors[3][1]) {
      const combination = [user, engine, better, line];
      const pairLosses = [];
      for (let i = 0; i < combination.length; i++) for (let j = i + 1; j < combination.length; j++) {
        pairLosses.push(Math.max(...squaresHex.map((_, squareIndex) =>
          penalty(0.13, labDistance(combination[i].view[squareIndex], combination[j].view[squareIndex]))
        )));
      }
      const score = combination.reduce((total, color) => total + color.cost, 0)
        + Math.max(...combination.map((color) => color.loss))
        + 2 * Math.max(...pairLosses)
        + pairLosses.reduce((total, loss) => total + loss, 0);
      if (score < bestScore) {
        bestScore = score;
        best = combination;
      }
    }
  const [user, engine, better, line] = best;
  return { user: user.hex, engine: engine.hex, better: better.hex, line: line.hex };
}
