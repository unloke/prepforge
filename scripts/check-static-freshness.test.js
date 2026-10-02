import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkStaticFreshness } from "./check-static-freshness.mjs";

let root;
afterEach(() => {
  if (!root) return;
  const target = resolve(root);
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith("prepforge-static-")) {
    throw new Error("Unexpected test cleanup path");
  }
  rmSync(target, { recursive: true, force: true });
});

function fixture() {
  root = mkdtempSync(join(tmpdir(), "prepforge-static-"));
  const output = join(root, "src/prepforge_chess/web/static");
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, "index.html"), "committed bundle");
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init");
  git("add", ".");
  git("-c", "user.name=Static Test", "-c", "user.email=static@example.test", "commit", "-m", "fixture");
  return output;
}

describe("committed production output guard", () => {
  it("accepts unchanged generated files despite unrelated edits", () => {
    fixture();
    writeFileSync(join(root, "unrelated.txt"), "user change");
    expect(() => checkStaticFreshness(root)).not.toThrow();
  });
  it("rejects a rebuilt tracked bundle that was not committed", () => {
    const output = fixture();
    writeFileSync(join(output, "index.html"), "new build");
    expect(() => checkStaticFreshness(root)).toThrow(/static output is stale/);
  });
  it("rejects new untracked build chunks", () => {
    const output = fixture();
    writeFileSync(join(output, "new-chunk.js"), "export default 1");
    expect(() => checkStaticFreshness(root)).toThrow(/new-chunk.js/);
  });
});
