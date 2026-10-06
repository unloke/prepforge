// Cross-end Brilliant/Great sanity gates — the browser half.
//
// tests/fixtures/sanity_gates_golden.json is shared with the server suite
// (tests/test_sanity_gates_golden.py): sanityExclusion here and sanity_exclusion in
// services/brilliant.py must exclude exactly the same moves.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { sanityExclusion } from "./features.js";

const GOLDEN = JSON.parse(
  readFileSync(new URL("../../tests/fixtures/sanity_gates_golden.json", import.meta.url), "utf8"),
);

describe("sanity gates golden contract", () => {
  for (const c of GOLDEN.cases) {
    it(c.id, () => {
      expect(
        sanityExclusion({
          fenBefore: c.fen_before,
          uci: c.uci,
          prevFenBefore: c.previous_fen_before,
          prevUci: c.previous_uci,
        }),
      ).toBe(c.expected);
    });
  }
});
