import globals from "globals";

const htmlTemplates = {
  meta: { type: "problem", schema: [], messages: { unsafe: "Use html tagged templates for HTML sinks." } },
  create(context) {
    const source = context.sourceCode;
    const property = (node) => node?.type === "MemberExpression"
      ? node.computed ? node.property.value : node.property.name : null;
    function check(node) {
      if (!node || ["VariableDeclaration", "ObjectExpression"].includes(node.type)
        || node.type === "TaggedTemplateExpression" && node.tag.name === "html") return;
      if (node.type === "TemplateLiteral" && node.expressions.length) {
        context.report({ node, messageId: "unsafe" });
        return;
      }
      for (const key of source.visitorKeys[node.type] || []) {
        const child = node[key];
        if (Array.isArray(child)) child.forEach(check);
        else check(child);
      }
    }
    return {
      AssignmentExpression(node) {
        if (["innerHTML", "outerHTML"].includes(property(node.left))) check(node.right);
      },
      CallExpression(node) {
        if (property(node.callee) === "insertAdjacentHTML") check(node.arguments[1]);
      },
    };
  },
};

const trustedRaw = {
  meta: { type: "problem", schema: [], messages: { unsafe: "Non-literal raw() requires an eslint-disable comment explaining why the markup is trusted." } },
  create: (context) => ({
    Program() {
      for (const comment of context.sourceCode.getAllComments()) {
        if (/eslint-disable.*local\/trusted-raw/.test(comment.value)
          && !/--\s*\S/.test(comment.value)) context.report({ loc: comment.loc, messageId: "unsafe" });
      }
    },
    CallExpression(node) {
      if (node.callee.name === "raw" && node.arguments[0]?.type !== "Literal") {
        context.report({ node, messageId: "unsafe" });
      }
    },
  }),
};

// Every web-src file still over the 500-line ceiling, at its measured size.
const OVER_CEILING = [
  ["web-src/app.js", 1884],
  ["web-src/board/board-controller.js", 621],
  ["web-src/coach/brilliant-assess.test.js", 667],
  ["web-src/coach/why/facts.js", 816],
  ["web-src/controllers/account.js", 680],
  ["web-src/controllers/analyze-session.js", 1293],
  ["web-src/controllers/build-session.js", 1427],
  ["web-src/controllers/sync.js", 586],
  ["web-src/controllers/train-session.js", 2176],
  ["web-src/engine/build-generator.test.js", 720],
  ["web-src/engine/maia3-provider.test.js", 627],
  ["web-src/engine/stockfish-provider.js", 595],
  ["web-src/engine/stockfish-provider.test.js", 550],
  ["web-src/scout-prefilter.test.js", 612],
  ["web-src/scout-report.js", 1417],
  ["web-src/scout-report.test.js", 1351],
  ["web-src/scout-stats.js", 905],
  ["web-src/scout-stats.test.js", 769],
  ["web-src/scout.js", 1531],
  ["web-src/scout.test.js", 1717],
  ["web-src/train-lucky-db.js", 505],
  ["web-src/train-lucky-db.test.js", 554],
  ["web-src/ui-layout.test.js", 668],
  ["web-src/views/analyze.js", 768],
  ["web-src/views/dashboard.js", 803],
  ["web-src/views/scout.js", 2002],
  ["web-src/views/settings.js", 645],
  ["web-src/views/teams-controller.js", 609],
];

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
    plugins: { local: { rules: { "html-templates": htmlTemplates, "trusted-raw": trustedRaw } } },
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.browser, ...globals.es2021 },
    },
    rules: {
      ...commonRules,
      "local/html-templates": "error",
      "local/trusted-raw": "error",
      // One module, one concern. 500 code lines (blank lines and comments
      // excluded) is where a file stops being readable end to end — the reason
      // app.js was split into the modules around it.
      "max-lines": ["error", { max: 500, skipBlankLines: true, skipComments: true }],
    },
  },
  // Files already over the ceiling when it was introduced, with the measured
  // size (blank lines and comments excluded). Each number is a floor as well
  // as a ceiling: growth fails the lint, shrinking means lowering the number,
  // and splitting the file means deleting its line. This is the to-do list.
  ...OVER_CEILING.map(([file, max]) => ({
    files: [file],
    rules: { "max-lines": ["error", { max, skipBlankLines: true, skipComments: true }] },
  })),
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
