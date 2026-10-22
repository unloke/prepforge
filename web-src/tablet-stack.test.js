// Portrait tablets: at 900x1100 the board sat beside a 360px panel at 436px,
// and the stacked 761-860 tablets capped it at 560px with a third of the width
// empty. A portrait screen up to 1100px narrower than 5:6 now stacks, and a
// stacked tablet gives the board the width up to 58vh (Train's Start stays
// above the fold at 768x1024), with the bar and panel lined up under it. The
// 860 / 761 split from the phone-on-its-side fix is unchanged.
import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "styles.css"), "utf8");
const STACKED = "(max-width: 760px), (max-width: 860px) and (orientation: portrait), (max-width: 860px) and (min-height: 521px), (max-width: 1100px) and (aspect-ratio < 5/6)";
const WIDE = "(min-width: 1101px), (min-width: 861px) and (aspect-ratio >= 5/6), (min-width: 761px) and (orientation: landscape) and (max-height: 520px)";

// Evaluate a media query list for a viewport (only the features used here).
function matches(query, w, h) {
  return query.split(", ").some((part) => part.split(" and ").every((f) => {
    if (f === "(orientation: portrait)") return h >= w;
    if (f === "(orientation: landscape)") return w > h;
    if (f === "(aspect-ratio < 5/6)") return w / h < 5 / 6;
    if (f === "(aspect-ratio >= 5/6)") return w / h >= 5 / 6;
    const [, name, px] = f.match(/^\(([a-z-]+): (\d+)px\)$/).map((v, i) => (i === 2 ? Number(v) : v));
    return { "max-width": w <= px, "min-width": w >= px, "max-height": h <= px, "min-height": h >= px }[name];
  }));
}

it("stacked and wide split every viewport exactly once", () => {
  const cases = [
    [1440, 900, false], [1180, 820, false], [1000, 528, false], [1024, 768, false],
    [900, 1100, true], [820, 1180, true], [768, 1024, true], [1024, 1366, true],
    [390, 844, true], [844, 390, false], [800, 600, true], [1100, 1400, true], [1100, 1300, false], [1101, 1400, false],
  ];
  for (const [w, h, stacked] of cases) {
    expect(matches(STACKED, w, h), `${w}x${h} stacked`).toBe(stacked);
    expect(matches(WIDE, w, h), `${w}x${h} wide`).toBe(!stacked);
  }
});

it("every study rule uses the same split", () => {
  const queries = [...css.matchAll(/@media ([^{]*(?:860px|861px|1100px|1101px)[^{]*) \{/g)].map((m) => m[1])
    .filter((q) => q.includes("orientation"));
  expect(queries.length).toBeGreaterThanOrEqual(5);
  for (const q of queries) expect([STACKED, WIDE]).toContain(q);
});

it("a stacked tablet gives the board the width, up to 58vh, with the panel under it", () => {
  const block = css.slice(css.indexOf(`@media ${STACKED} {\n  /* Stacked: board over sidebar.`));
  expect(block).toMatch(/\.board-stack \{\s*max-width: min\(55vh, 560px\);/);
  expect(block).toMatch(/@media \(min-width: 761px\) \{\s*\.study \{ --stack-w: min\(100%, 58vh\); \}\s*\.board-area,\s*\.study > \.sidebar \{ width: var\(--stack-w\); justify-self: center; \}\s*\.board-stack \{ max-width: none; \}/);
});
