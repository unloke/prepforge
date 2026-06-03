import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";

// The Python server (web/server.py) serves the built app: index.html at "/"
// and every other asset under "/static/*". So Vite builds into the package's
// static dir and prefixes built asset URLs with /static/.
//
// Build artifacts are committed (the deploy image runs `pip install .` with no
// Node), so a build must be run and committed when web-src/ changes.
export default defineConfig({
  root: "web-src",
  base: "/static/",
  build: {
    outDir: fileURLToPath(
      new URL("./src/prepforge_chess/web/static", import.meta.url),
    ),
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    // `npm run dev` (HMR). API/oauth are proxied to the Python server so the
    // dev server can stay a pure static/asset host. App is at /static/ in dev.
    proxy: {
      "/api": "http://127.0.0.1:8765",
      "/oauth": "http://127.0.0.1:8765",
    },
  },
});
