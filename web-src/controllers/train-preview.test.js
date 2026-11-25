import { describe, expect, it, vi } from "vitest";
import { createTrainPreview } from "./train-preview.js";
import { hooks } from "../core/hooks.js";

describe("train preview requests", () => {
  it("makes a cached A active again and ignores B after an A → B → A switch", async () => {
    let resolveB;
    const api = vi.fn((key) => key === "A"
      ? Promise.resolve({ scope: "A" })
      : new Promise((resolve) => { resolveB = resolve; }));
    const preview = createTrainPreview(api);
    await preview.load("A");
    const b = preview.load("B");
    expect(preview.current("B")).toBe(true);
    await preview.load("A");
    expect(preview.current("A")).toBe(true);
    expect(preview.dataFor("A")).toEqual({ scope: "A" });
    resolveB({ scope: "B" });
    await b;
    expect(preview.current("A")).toBe(true);
    expect(preview.dataFor("A")).toEqual({ scope: "A" });
    expect(api).toHaveBeenCalledTimes(2);
  });

  it("routes a 401 through the session-expired auth handler", async () => {
    const authRequired = vi.fn();
    hooks.authRequired = authRequired;
    const preview = createTrainPreview(() => Promise.reject(Object.assign(new Error("unauthorized"), { status: 401, authRequired: true })));
    await preview.load("scope");
    expect(preview.authFailed("scope")).toBe(true);
    expect(authRequired).toHaveBeenCalledTimes(1);
    hooks.authRequired = null;
  });

  it("keeps request and cache state local to each Home instance", async () => {
    let resolveOld;
    const old = createTrainPreview(() => new Promise((resolve) => { resolveOld = resolve; }));
    const current = createTrainPreview(async () => ({ scope: "current" }));
    const oldRequest = old.load("scope");
    await current.load("scope");
    resolveOld({ scope: "old" });
    await oldRequest;
    expect(current.dataFor("scope")).toEqual({ scope: "current" });
  });
});
