// Vitest config for PrepForge Chess.
// Vite app root remains web-src (vite.config.js). This is the product gate; research/
// is not discovered.
import { defineConfig } from "vitest/config";
import { stockfishIdentity } from "./scripts/sync-stockfish.mjs";

export default defineConfig({
  define: { "globalThis.__STOCKFISH__": JSON.stringify(stockfishIdentity()) },
  test: {
    include: [
      "web-src/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "scripts/**/*.{test,spec}.?(c|m)[jt]s?(x)",
    ],
    exclude: [
      "**/node_modules/**",
      "**/.git/**",
      "**/.claude/**",
      "**/tmp/**",
    ],
  },
});
