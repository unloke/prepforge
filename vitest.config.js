// Vitest config for PrepForge Chess.
// Vite app root remains web-src (vite.config.js). The default test command is the
// product gate: research protocols have their own explicit vitest.research.config.mjs
// entry point so an archived study cannot make a deployable product red.
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
      "**/archive/**",
    ],
  },
});
