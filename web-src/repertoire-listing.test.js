import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { fetchRepertoireListing } from "./repertoire-listing.js";

describe("shared repertoire listing requests", () => {
  it("shares one in-flight request for the same owner generation", async () => {
    let resolve;
    const api = vi.fn(() => new Promise((done) => { resolve = done; }));
    const first = fetchRepertoireListing(api, "u1", 7, true);
    const second = fetchRepertoireListing(api, "u1", 7, true);
    expect(api).toHaveBeenCalledTimes(1);
    resolve({ repertoires: [], shared: [] });
    await expect(first).resolves.toEqual({ repertoires: [], shared: [] });
    await second;
  });

  it("lets mutation refreshes bypass the shared initial read", async () => {
    let resolveShared;
    const api = vi.fn()
      .mockImplementationOnce(() => new Promise((done) => { resolveShared = done; }))
      .mockResolvedValueOnce({ repertoires: [{ id: "new" }], shared: [] });
    const initial = fetchRepertoireListing(api, "u1", 7, true);
    const refresh = fetchRepertoireListing(api, "u1", 7);
    expect(api).toHaveBeenCalledTimes(2);
    await refresh;
    resolveShared({ repertoires: [{ id: "old" }], shared: [] });
    await initial;
  });

  it("moves stale shared readers to the newer in-flight refresh", async () => {
    let resolveOld;
    let resolveRefresh;
    let calls = 0;
    const api = vi.fn(() => {
      calls += 1;
      return new Promise((done) => {
        if (calls === 1) resolveOld = done;
        else resolveRefresh = done;
      });
    });
    const initial = fetchRepertoireListing(api, "u1", 7, true);
    const refresh = fetchRepertoireListing(api, "u1", 7);
    resolveOld({ repertoires: [{ id: "old" }], shared: [] });
    resolveRefresh({ repertoires: [{ id: "new" }], shared: [] });
    await expect(initial).resolves.toEqual({ repertoires: [{ id: "new" }], shared: [] });
    await expect(refresh).resolves.toEqual({ repertoires: [{ id: "new" }], shared: [] });
  });

  it("starts a fresh read instead of attaching to an invalidated request", async () => {
    let resolveOld;
    let calls = 0;
    const api = vi.fn(() => {
      calls += 1;
      if (calls === 1) return new Promise((done) => { resolveOld = done; });
      return Promise.resolve({ repertoires: [{ id: `r${calls}` }], shared: [] });
    });
    const initial = fetchRepertoireListing(api, "u1", 7, true);
    await fetchRepertoireListing(api, "u1", 7);
    const later = fetchRepertoireListing(api, "u1", 7, true);
    expect(api).toHaveBeenCalledTimes(3);
    await expect(later).resolves.toEqual({ repertoires: [{ id: "r3" }], shared: [] });
    resolveOld({ repertoires: [{ id: "old" }], shared: [] });
    await expect(initial).resolves.toEqual({ repertoires: [{ id: "r3" }], shared: [] });
  });

  it("gives stale readers the newer failure instead of a silent empty load", async () => {
    let resolveOld;
    const failure = new Error("refresh failed");
    const api = vi.fn()
      .mockImplementationOnce(() => new Promise((done) => { resolveOld = done; }))
      .mockRejectedValueOnce(failure);
    const initial = fetchRepertoireListing(api, "u1", 7, true);
    await expect(fetchRepertoireListing(api, "u1", 7)).rejects.toThrow("refresh failed");
    resolveOld({ repertoires: [{ id: "old" }], shared: [] });
    await expect(initial).rejects.toThrow("refresh failed");
  });

  it("does not share across owner generations or after settlement", async () => {
    const api = vi.fn(async () => ({ repertoires: [], shared: [] }));
    await fetchRepertoireListing(api, "u1", 7, true);
    await fetchRepertoireListing(api, "u1", 7, true);
    await fetchRepertoireListing(api, "u1", 8, true);
    expect(api).toHaveBeenCalledTimes(3);
  });

  it("is the listing read shared by Train and Library", () => {
    const train = readFileSync(new URL("./controllers/train-home.js", import.meta.url), "utf8");
    const dashboard = readFileSync(new URL("./views/dashboard.js", import.meta.url), "utf8");
    expect(train).toContain('fetchRepertoireListing(api, currentOwnerId()');
    expect(dashboard).toContain('fetchRepertoireListing(api, appState.accountUserId');
    expect(dashboard).not.toContain('await api("/api/repertoires")');
  });
});
