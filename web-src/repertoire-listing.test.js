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
