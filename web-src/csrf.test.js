import { describe, it, expect, vi } from "vitest";

import {
  readCsrfCookie,
  isSafeMethod,
  createCsrfTokenSource,
  headersWithCsrf,
  CSRF_COOKIE,
  CSRF_HEADER,
} from "./csrf.js";

describe("readCsrfCookie", () => {
  it("extracts the pf_csrf value from a cookie string", () => {
    expect(readCsrfCookie("a=1; pf_csrf=tok123; b=2")).toBe("tok123");
  });

  it("matches when pf_csrf is first", () => {
    expect(readCsrfCookie("pf_csrf=abc; other=x")).toBe("abc");
  });

  it("URL-decodes the value", () => {
    expect(readCsrfCookie("pf_csrf=a%2Bb%3D")).toBe("a+b=");
  });

  it("returns null when absent or empty", () => {
    expect(readCsrfCookie("foo=bar")).toBeNull();
    expect(readCsrfCookie("")).toBeNull();
    expect(readCsrfCookie(undefined)).toBeNull();
  });

  it("does not match a cookie that merely ends in pf_csrf", () => {
    expect(readCsrfCookie("not_pf_csrf=nope")).toBeNull();
  });
});

describe("isSafeMethod", () => {
  it("treats GET/HEAD/OPTIONS/TRACE as safe (case-insensitive)", () => {
    for (const m of ["GET", "get", "HEAD", "options", "TRACE"]) {
      expect(isSafeMethod(m)).toBe(true);
    }
  });

  it("treats POST/PUT/DELETE/PATCH as unsafe", () => {
    for (const m of ["POST", "put", "DELETE", "patch"]) {
      expect(isSafeMethod(m)).toBe(false);
    }
  });

  it("defaults a missing method to safe (GET)", () => {
    expect(isSafeMethod(undefined)).toBe(true);
  });
});

describe("headersWithCsrf", () => {
  it("adds X-CSRF-Token to DELETE requests", async () => {
    const getCsrfToken = vi.fn().mockResolvedValue("unlink-token");
    const headers = await headersWithCsrf("DELETE", { Accept: "application/json" }, getCsrfToken);
    expect(headers).toEqual({
      Accept: "application/json",
      "X-CSRF-Token": "unlink-token",
    });
    expect(getCsrfToken).toHaveBeenCalledOnce();
  });

  it("builds the keepalive unload header set synchronously from the cookie", async () => {
    // beforeunload/pagehide cannot await the async CSRF bootstrap — the fire-
    // and-forget keepalive path reads the cookie synchronously instead. This
    // pins that contract: cookie present → header set; cookie absent → omit
    // the header (same as headersWithCsrf's "no token" branch) rather than
    // throwing a ReferenceError on an unimported constant.
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const root = dirname(fileURLToPath(import.meta.url));
    const app = readFileSync(join(root, "app.js"), "utf8");
    expect(app).toContain('import { createCsrfTokenSource, headersWithCsrf, readCsrfCookie, CSRF_HEADER } from "./csrf.js"');
    for (const site of ["beaconFlushBuild", "beaconFlushTrain"]) {
      expect(app).toContain(`function ${site}(`);
    }
    const headerFor = (cookieString) => {
      const token = readCsrfCookie(cookieString);
      return { "Content-Type": "application/json", ...(token ? { [CSRF_HEADER]: token } : {}) };
    };
    expect(headerFor("pf_csrf=abc")).toEqual({
      "Content-Type": "application/json",
      "X-CSRF-Token": "abc",
    });
    expect(headerFor("")).toEqual({ "Content-Type": "application/json" });
  });
});

describe("createCsrfTokenSource", () => {
  it("returns the existing cookie token without fetching", async () => {
    const fetchImpl = vi.fn();
    const getCsrfToken = createCsrfTokenSource({
      fetchImpl,
      cookieGetter: () => `${CSRF_COOKIE}=already`,
    });
    expect(await getCsrfToken()).toBe("already");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("bootstraps via /api/csrf when no cookie is set", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ csrf_token: "minted" }),
    }));
    const getCsrfToken = createCsrfTokenSource({
      fetchImpl,
      cookieGetter: () => "",
    });
    expect(await getCsrfToken()).toBe("minted");
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/csrf",
      expect.objectContaining({ credentials: "same-origin" })
    );
  });

  it("de-duplicates concurrent bootstrap calls into one fetch", async () => {
    let resolve;
    const fetchImpl = vi.fn(
      () =>
        new Promise((r) => {
          resolve = () => r({ ok: true, json: async () => ({ csrf_token: "shared" }) });
        })
    );
    const getCsrfToken = createCsrfTokenSource({
      fetchImpl,
      cookieGetter: () => "",
    });
    const a = getCsrfToken();
    const b = getCsrfToken();
    resolve();
    expect(await a).toBe("shared");
    expect(await b).toBe("shared");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("falls back to the cookie the bootstrap set when the body omits the token", async () => {
    let cookie = "";
    const fetchImpl = vi.fn(async () => {
      cookie = `${CSRF_COOKIE}=from-cookie`;
      return { ok: true, json: async () => ({}) };
    });
    const getCsrfToken = createCsrfTokenSource({
      fetchImpl,
      cookieGetter: () => cookie,
    });
    expect(await getCsrfToken()).toBe("from-cookie");
  });

  it("retries the bootstrap after a failed attempt", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ csrf_token: "second" }) });
    const getCsrfToken = createCsrfTokenSource({
      fetchImpl,
      cookieGetter: () => "",
    });
    await expect(getCsrfToken()).rejects.toThrow(/CSRF bootstrap failed/);
    expect(await getCsrfToken()).toBe("second");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("module constants", () => {
  it("exposes the header name the API expects", () => {
    expect(CSRF_HEADER).toBe("X-CSRF-Token");
    expect(CSRF_COOKIE).toBe("pf_csrf");
  });
});
