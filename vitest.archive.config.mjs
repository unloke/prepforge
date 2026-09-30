// Historical research tests are opt-in and never part of the product gate.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["archive/**/*.test.js"],
    // The missing Meta-Maia dependency already excluded this study before archive.
    exclude: ["archive/research/scout-robust-y/**"],
    environment: "node",
  },
});
