// Vitest config for runnable research/ protocols (ORCBR and acquisition).
// Default vite.config.js roots web-src only; research tests live outside that tree.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["research/**/*.test.js"],
    environment: "node",
  },
});
