import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// A 401 reaches the shell through hooks.authRequired. The handler is exported by
// the account service; the entry object has no such method, and calling it there
// threw on every expired session instead of opening the sign-in dialog.
const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");
const entry = readFileSync(new URL("./account-entry.js", import.meta.url), "utf8");
const account = readFileSync(new URL("./controllers/account.js", import.meta.url), "utf8");

describe("auth-required hook", () => {
  it("routes to the account service's handler", () => {
    expect(app).toMatch(/hooks\.authRequired = \(\) => accountEntry && accountService\(\)\.handleAuthRequired\(\)/);
    expect(account).toMatch(/^\s+handleAuthRequired,$/m);
  });
  it("does not call a method the entry object lacks", () => {
    expect(app).not.toMatch(/accountEntry\?*\.handleAuthRequired/);
    expect(entry).not.toMatch(/handleAuthRequired/);
  });
});
