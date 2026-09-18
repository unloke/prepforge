// Vitest config for research/ protocols (ORCBR, robust-y, acquisition).
// Default vite.config.js roots web-src only; research tests live outside that tree.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["research/**/*.test.js"],
    // Robust-Y is an archived protocol whose Meta-Maia dependency was deliberately
    // removed from the product tree. Keep it opt-in until its research bundle is
    // restored; it must never leak into the production test gate.
    exclude: ["research/scout-robust-y/**"],
    environment: "node",
  },
});
