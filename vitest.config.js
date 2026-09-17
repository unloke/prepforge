// Vitest config for PrepForge Chess.
// Vite app root remains web-src (vite.config.js). Tests also cover research-only
// cores outside web-src so rating-moderation and similar studies need no Vite build.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "web-src/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "research/**/*.{test,spec}.?(c|m)[jt]s?(x)",
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
