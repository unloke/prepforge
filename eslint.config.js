import globals from "globals";

const commonRules = {
  "no-undef": "error",
  "no-unreachable": "error",
  "no-fallthrough": "error",
  // Keep this advisory for the first pass: the legacy SPA intentionally has a
  // few callback signatures whose unused parameters document their position.
  // The CI gate still fails on correctness hazards above.
  "no-unused-vars": ["warn", { args: "none", ignoreRestSiblings: true }],
};

export default [
  {
    ignores: [
      "node_modules/**",
      "tmp/**",
      "out/**",
      "src/prepforge_chess/web/static/**",
      "research/**",
      // Vendored/generated engine runtimes are not authored product JavaScript;
      // lint their callers, not their bundled assets. Scout modules remain
      // authored source even when a URL or build flag gates their runtime path.
      "web-src/public/engine/**",
    ],
  },
  {
    files: ["web-src/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.browser, ...globals.es2021 },
    },
    rules: commonRules,
  },
  {
    // These authored Scout studies are exercised as Node-oriented research
    // entry points. Keep them in the lint set while declaring their host APIs;
    // this is intentionally different from excluding them as generated code.
    files: [
      "web-src/scout-ref-df-census.js",
      "web-src/scout-v15-*.js",
      "web-src/scout-shadow-prep-*.js",
      "web-src/scout-route-audit.js",
      "web-src/scout-maia-harness.js",
      "web-src/scout-stockfish-uci.js",
    ],
    languageOptions: {
      globals: { ...globals.browser, ...globals.es2021, ...globals.node },
    },
    rules: commonRules,
  },
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      // The audit scripts execute browser callbacks through Playwright. They are
      // still Node modules, so keep both host environments visible to the linter.
      globals: { ...globals.node, ...globals.browser, ...globals.es2021 },
    },
    rules: commonRules,
  },
];
