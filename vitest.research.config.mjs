// Vitest config for research/ protocols (ORCBR, robust-y, acquisition).
// Default vite.config.js roots web-src only; research tests live outside that tree.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["research/**/*.test.js"],
    environment: "node",
  },
});
