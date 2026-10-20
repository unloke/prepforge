// The "shared" tag on a repertoire row is a tag, not a micro-label.
//
// It used to be a 10px bold tracked cap in upper case, three sizes below the
// row's own text and unreadable next to the plain "disabled" chip on the
// same column. It now sits at the size of the other chips and says "shared"
// in lower case. These rules pin that so a later chip pass cannot shrink it
// back into a cap.
import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(root, "..", "styles.css"), "utf8");

function rule(selector) {
  const start = css.indexOf(selector);
  expect(start, selector).toBeGreaterThan(-1);
  const open = css.indexOf("{", start);
  return css.slice(open, css.indexOf("}", open));
}

it("the shared tag is not a tracked upper-case cap", () => {
  const chip = rule(".lib-chip.is-shared {");
  expect(chip).not.toMatch(/text-transform:\s*uppercase/);
  expect(chip).not.toMatch(/letter-spacing/);
  // It takes the chip's own size, so the tag and the "disabled" tag on the
  // same column read as one pair.
  expect(chip).not.toMatch(/font-size/);
});

it("the shared tag still reads as a shared tag", () => {
  const chip = rule(".lib-chip.is-shared {");
  expect(chip).toMatch(/background:\s*var\(--accent-soft\)/);
  expect(chip).toMatch(/color:\s*var\(--accent-text\)/);
});
