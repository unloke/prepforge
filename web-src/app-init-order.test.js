import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Top-level `createX({ ... })` calls in app.js run while the module evaluates. Passing a
// `const` declared further down throws in dev (TDZ) and hands the controller `undefined`
// in the bundle, so every identifier they take must already be declared.
const lines = readFileSync(new URL("./app.js", import.meta.url), "utf8").split("\n");

function declarationLines() {
  const found = new Map();
  lines.forEach((line, index) => {
    const single = line.match(/^(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/);
    if (single && !found.has(single[1])) found.set(single[1], index + 1);
    const destructured = line.match(/^(?:export\s+)?(?:const|let)\s+\{([^}]*)\}\s*=/);
    if (destructured) {
      for (const part of destructured[1].split(",")) {
        const name = part.split(":").pop().trim();
        if (name && !found.has(name)) found.set(name, index + 1);
      }
    }
  });
  return found;
}

function topLevelFactoryCalls() {
  const calls = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^(?:(?:export\s+)?(?:const|let)\s+[\w${}\s,]+=\s*)?create\w*\(\{/.test(lines[i])) continue;
    let depth = 0;
    let body = "";
    for (let j = i; j < lines.length; j++) {
      body += `${lines[j]}\n`;
      for (const ch of lines[j]) depth += ch === "(" ? 1 : ch === ")" ? -1 : 0;
      if (depth <= 0) break;
    }
    const args = body.slice(body.indexOf("{"));
    const names = new Set();
    for (const m of args.matchAll(/[{,]\s*([A-Za-z_$][\w$]*)\s*(?=[,}\n])/g)) names.add(m[1]);
    for (const m of args.matchAll(/:\s*([A-Za-z_$][\w$]*)\s*[,\n}]/g)) names.add(m[1]);
    calls.push({ line: i + 1, names });
  }
  return calls;
}

describe("app.js init order", () => {
  it("declares every argument of a top-level controller factory before the call", () => {
    const declared = declarationLines();
    const calls = topLevelFactoryCalls();
    expect(calls.some((call) => call.names.has("hydrateBuild"))).toBe(true);
    const late = [];
    for (const call of calls) {
      for (const name of call.names) {
        const at = declared.get(name);
        if (at && at > call.line) late.push(`${name} (declared line ${at}, used line ${call.line})`);
      }
    }
    expect(late).toEqual([]);
  });
});
