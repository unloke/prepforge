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
      // Vendored/generated engine runtimes and archived Scout studies are not
      // authored product JavaScript; lint their callers, not their bundles.
      "web-src/public/engine/**",
      "web-src/scout-bias-*.js",
      "web-src/scout-v12-*.js",
      "web-src/scout-v13-*.js",
      "web-src/scout-v15-*.js",
      "web-src/scout-shadow-*.js",
      "web-src/scout-ref-df-census.js",
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
