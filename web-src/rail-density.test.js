// The desktop rail's rows. Eight destinations, four foot controls, the brand
// and the account chip all have to fit a laptop window without a scrollbar;
// the rows were 34px, under a comfortable pointer target, while the window had
// ~380px of slack at 900. At 40px they are a real target and the foot still
// lands on the bottom edge. A short window (528px, the 1000x528 check) has no
// room for both the taller rows and the group dividers, so it drops the
// dividers instead of scrolling the account chip off the screen.
import { expect, it } from "vitest";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

it("gives every rail row a 40px target", () => {
  expect(css).toMatch(/\.rail \.tab,\s*\.rail \.rail-btn \{ height: 40px; \}/);
  expect(css).toMatch(/\.rail \.account-btn \{ height: 40px; \}/);
  expect(css).not.toMatch(/\.rail \.tab,\s*\.rail \.rail-btn \{ height: 34px; \}/);
});

it("drops the group dividers on a short window rather than scrolling the rail", () => {
  // At 40px rows the 528px window overflowed by 57px and put the account chip
  // below the screen; the dividers are the only thing there that is not a
  // destination.
  expect(css).toMatch(
    /@media \(min-width: 761px\) and \(max-height: 560px\) \{\s*\.rail \.nav-group-label \{ display: none; \}/,
  );
});
