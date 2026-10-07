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
    rules: { ...commonRules, "local/html-templates": "error", "local/trusted-raw": "error" },
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
