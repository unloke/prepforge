import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { acceptRepertoireListing, cachedRepertoireList, fetchRepertoireListing, finishRepertoireDelete, refreshRepertoireListing } from "./repertoire-listing.js";

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("shared repertoire listing requests", () => {
  it("shares one passive in-flight request for the same owner generation", async () => {
    const pending = deferred();
    const api = vi.fn(() => pending.promise);
    const first = fetchRepertoireListing(api, "u-share", 7);
    const second = fetchRepertoireListing(api, "u-share", 7);
    expect(api).toHaveBeenCalledTimes(1);
    pending.resolve({ repertoires: [], shared: [] });
    await expect(first).resolves.toEqual({ repertoires: [], shared: [] });
    await second;
  });

  it("moves stale readers to the newer refresh without waiting for the old request", async () => {
    const oldRequest = deferred();
    const refreshRequest = deferred();
    const api = vi.fn()
      .mockImplementationOnce(() => oldRequest.promise)
      .mockImplementationOnce(() => refreshRequest.promise);
    const initial = fetchRepertoireListing(api, "u-release", 7);
    const refresh = refreshRepertoireListing(api, "u-release", 7);
    let settled = false;
    const watching = initial.finally(() => { settled = true; });
    refreshRequest.resolve({ repertoires: [{ id: "new" }], shared: [] });
    await new Promise((done) => setTimeout(done, 0));
    expect(settled).toBe(true);
    await expect(initial).resolves.toEqual({ repertoires: [{ id: "new" }], shared: [] });
    await expect(refresh).resolves.toEqual({ repertoires: [{ id: "new" }], shared: [] });
    oldRequest.resolve({ repertoires: [{ id: "old" }], shared: [] });
    await watching;
  });

  it("lets a later passive read recover independently of a pending refresh", async () => {
    const refreshRequest = deferred();
    const passiveRequest = deferred();
    const api = vi.fn()
      .mockImplementationOnce(() => refreshRequest.promise)
      .mockImplementationOnce(() => passiveRequest.promise);
    const refresh = refreshRepertoireListing(api, "u-independent", 7);
    const passive = fetchRepertoireListing(api, "u-independent", 7);
    expect(api).toHaveBeenCalledTimes(2);
    refreshRequest.reject(new Error("background refresh failed"));
    await expect(refresh).rejects.toThrow("background refresh failed");
    passiveRequest.resolve({ repertoires: [{ id: "passive" }], shared: [] });
    await expect(passive).resolves.toEqual({ repertoires: [{ id: "passive" }], shared: [] });
  });

  it("gives stale readers the newer failure instead of the old request's failure", async () => {
    const oldRequest = deferred();
    const refreshRequest = deferred();
    const api = vi.fn()
      .mockImplementationOnce(() => oldRequest.promise)
      .mockImplementationOnce(() => refreshRequest.promise);
    const initial = fetchRepertoireListing(api, "u-failure", 7);
    refreshRepertoireListing(api, "u-failure", 7);
    let settled = false;
    const watching = initial.finally(() => { settled = true; });
    refreshRequest.reject(new Error("refresh failed"));
    await expect(initial).rejects.toThrow("refresh failed");
    expect(settled).toBe(true);
    oldRequest.reject(new Error("old failure"));
    await watching.catch(() => {});
  });

  it("starts a fresh passive read instead of attaching to an invalidated request", async () => {
    const oldRequest = deferred();
    let calls = 0;
    const api = vi.fn(() => {
      calls += 1;
      if (calls === 1) return oldRequest.promise;
      return Promise.resolve({ repertoires: [{ id: `r${calls}` }], shared: [] });
    });
    const initial = fetchRepertoireListing(api, "u-fresh", 7);
    await refreshRepertoireListing(api, "u-fresh", 7);
    const later = fetchRepertoireListing(api, "u-fresh", 7);
    expect(api).toHaveBeenCalledTimes(3);
    await expect(later).resolves.toEqual({ repertoires: [{ id: "r3" }], shared: [] });
    oldRequest.resolve({ repertoires: [{ id: "old" }], shared: [] });
    await expect(initial).resolves.toEqual({ repertoires: [{ id: "r2" }], shared: [] });
  });

  it("retires an older refresh once a newer passive listing is accepted", async () => {
    const oldRequest = deferred();
    const refreshRequest = deferred();
    const passiveRequest = deferred();
    const api = vi.fn()
      .mockImplementationOnce(() => oldRequest.promise)
      .mockImplementationOnce(() => refreshRequest.promise)
      .mockImplementationOnce(() => passiveRequest.promise);
    const initial = fetchRepertoireListing(api, "u-ordering", 7);
    const refresh = refreshRepertoireListing(api, "u-ordering", 7);
    const passive = fetchRepertoireListing(api, "u-ordering", 7);
    passiveRequest.resolve({ repertoires: [{ id: "renamed" }], shared: [] });
    expect(acceptRepertoireListing(passive, "u-ordering", 7)).toBe(true);
    await expect(refresh).resolves.toBeNull();
    await expect(initial).resolves.toBeNull();
    refreshRequest.resolve({ repertoires: [{ id: "stale" }], shared: [] });
    oldRequest.resolve({ repertoires: [{ id: "older" }], shared: [] });
    await passive;
  });

  it("refuses to accept a listing under a different owner generation", async () => {
    const api = vi.fn(async () => ({ repertoires: [{ id: "a" }], shared: [] }));
    const listing = fetchRepertoireListing(api, "u-owner-a", 7);
    await listing;
    expect(acceptRepertoireListing(listing, "u-owner-b", 8)).toBe(false);
  });

  it("does not share across owner generations or after settlement", async () => {
    const api = vi.fn(async () => ({ repertoires: [], shared: [] }));
    await fetchRepertoireListing(api, "u-generations", 7);
    await fetchRepertoireListing(api, "u-generations", 7);
    await fetchRepertoireListing(api, "u-generations", 8);
    expect(api).toHaveBeenCalledTimes(3);
  });

  it("is the listing read shared by every shared-state writer", () => {
    const train = readFileSync(new URL("./controllers/train-home.js", import.meta.url), "utf8");
    const dashboard = readFileSync(new URL("./views/dashboard.js", import.meta.url), "utf8");
    const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");
    const palette = readFileSync(new URL("./palette.js", import.meta.url), "utf8");
    for (const source of [train, dashboard, app, palette]) expect(source).toContain("acceptRepertoireListing");
    expect(dashboard).not.toContain('await api("/api/repertoires")');
  });
});

describe("cached repertoire list", () => {
  it("reads the listing once per account and the cache after that", async () => {
    const state = { ownerGeneration: 3 };
    const api = vi.fn(async () => ({ repertoires: [{ id: 1 }], shared: [] }));
    await expect(cachedRepertoireList(state, api, "u-cache")).resolves.toEqual([{ id: 1 }]);
    await expect(cachedRepertoireList(state, api, "u-cache")).resolves.toEqual([{ id: 1 }]);
    expect(api).toHaveBeenCalledTimes(1);
    expect(state.repertoireListGeneration).toBe(3);
  });

  it("reads again for another account generation", async () => {
    const state = { ownerGeneration: 4, repertoireListGeneration: 3, repertoireList: [{ id: "old" }] };
    const api = vi.fn(async () => ({ repertoires: [], shared: [] }));
    await expect(cachedRepertoireList(state, api, "u-next")).resolves.toEqual([]);
    expect(api).toHaveBeenCalledTimes(1);
  });

  it("fails as the request fails, leaving the listing unknown", async () => {
    const state = { ownerGeneration: 5 };
    await expect(cachedRepertoireList(state, async () => { throw new Error("offline"); }, "u-fail")).rejects.toThrow("offline");
    expect(state.repertoireListGeneration).toBeUndefined();
  });
});

describe("finishing a repertoire delete", () => {
  it("drops a committed delete from the listing and the count as its mark lifts", () => {
    const state = { repertoireList: [{ id: 1 }, { id: 2 }], account: { repertoireCount: 2 }, pendingRepDeletes: new Set(["1"]) };
    finishRepertoireDelete(state, "1", { committed: true });
    expect(state.repertoireList).toEqual([{ id: 2 }]);
    expect(state.account.repertoireCount).toBe(1);
    expect(state.pendingRepDeletes.size).toBe(0);
  });

  it("keeps a failed delete listed, so it comes back", () => {
    const state = { repertoireList: [{ id: 1 }], account: { repertoireCount: 1 }, pendingRepDeletes: new Set(["1"]) };
    finishRepertoireDelete(state, "1", { committed: false });
    expect(state.repertoireList).toEqual([{ id: 1 }]);
    expect(state.account.repertoireCount).toBe(1);
    expect(state.pendingRepDeletes.size).toBe(0);
  });
});
