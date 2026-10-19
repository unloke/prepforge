import { describe, expect, it, vi } from "vitest";
import { assertCiPassed, mergeAfterCi, newerStockfishVersion } from "./update-stockfish.mjs";

describe("Stockfish release selection", () => {
  it.each([
    ["19.0.0", "19.0.1"], ["19.0.9", "19.0.10"], ["19.9.9", "19.10.0"], ["19.9.9", "20.0.0"],
  ])("updates %s to %s", (current, latest) => {
    expect(newerStockfishVersion(current, latest)).toBe(latest);
  });
  it.each([["19.0.1", "19.0.1"], ["20.0.0", "19.9.9"], ["19.10.0", "19.9.9"], ["19.0.10", "19.0.9"]])(
    "does not downgrade or repeat %s with %s", (current, latest) => {
      expect(newerStockfishVersion(current, latest)).toBeNull();
    });
  it.each(["^19.0.0", "19.0", "19.0.1-beta.1", "019.0.0", "garbage", "", null, ["19.0.1"]])(
    "fails loudly for invalid version %j", value => {
      expect(() => newerStockfishVersion(value, "20.0.0")).toThrow(/exact stable/);
      expect(() => newerStockfishVersion("19.0.0", value)).toThrow(/exact stable/);
    });
});

const sha = "candidate-sha";
const passed = () => ({ headSha: sha, conclusion: "success",
  jobs: ["python", "postgres", "js", "stockfish", "e2e"].map(name => ({ name, conclusion: "success" })) });

describe("Stockfish CI merge gate", () => {
  it("requires the exact head and all five successful jobs", () => {
    expect(() => assertCiPassed(passed(), sha)).not.toThrow();
    expect(() => assertCiPassed({ ...passed(), headSha: "other-sha" }, sha)).toThrow(/CI must pass/);
    expect(() => assertCiPassed({ ...passed(), conclusion: "failure" }, sha)).toThrow(/CI must pass/);
    expect(() => assertCiPassed({ ...passed(), jobs: [] }, sha)).toThrow(/CI must pass/);
    expect(() => assertCiPassed({ ...passed(), jobs: passed().jobs.filter(j => j.name !== "stockfish") }, sha))
      .toThrow(/CI must pass/);
  });
  it.each(["failure", "skipped", "cancelled", null])("rejects a %s smoke even if the run claims success", conclusion => {
    const result = passed();
    result.jobs.find(job => job.name === "stockfish").conclusion = conclusion;
    expect(() => assertCiPassed(result, sha)).toThrow(/CI must pass/);
  });
  it("also rejects a failing job added to CI", () => {
    const result = passed();
    result.jobs.push({ name: "new-gate", conclusion: "failure" });
    expect(() => assertCiPassed(result, sha)).toThrow(/CI must pass/);
  });

  function harness(result = passed()) {
    const command = vi.fn((_exe, args) => {
      if (args[1] === "list") return JSON.stringify([{ databaseId: 123 }]);
      if (args[1] === "view") return JSON.stringify(result);
      return "";
    });
    const sleep = vi.fn();
    return { repository: "owner/repo", pr: 42, sha, command, sleep };
  }
  it("waits for PR CI, then squash merges only its tested head", async () => {
    const opts = harness();
    opts.command.mockReturnValueOnce("[]");
    await mergeAfterCi(opts);
    expect(opts.sleep).toHaveBeenCalledWith(10_000);
    expect(opts.command.mock.calls[0][1]).toEqual(expect.arrayContaining(["ci.yml", "pull_request", sha]));
    expect(opts.command).toHaveBeenCalledWith("gh", ["run", "watch", "123", "--repo", "owner/repo", "--exit-status"],
      { stdio: "inherit" });
    expect(opts.command).toHaveBeenLastCalledWith("gh", ["pr", "merge", "42", "--repo", "owner/repo",
      "--squash", "--match-head-commit", sha], { stdio: "inherit" });
  });
  it("never merges when checks do not arrive", async () => {
    const opts = harness();
    opts.command.mockReturnValue("[]");
    await expect(mergeAfterCi(opts)).rejects.toThrow(/No pull-request CI run/);
    expect(opts.command).toHaveBeenCalledTimes(30);
  });
  it.each(["failure", "cancelled"])("retries an unchanged PR after CI %s", async conclusion => {
    const opts = harness();
    opts.command.mockReturnValueOnce(JSON.stringify([{ databaseId: 123, status: "completed", conclusion }]));
    await mergeAfterCi(opts);
    expect(opts.command).toHaveBeenNthCalledWith(2, "gh", ["run", "rerun", "123", "--repo", "owner/repo"],
      { stdio: "inherit" });
  });
  it("reuses successful CI on an unchanged PR", async () => {
    const opts = harness();
    opts.command.mockReturnValueOnce(JSON.stringify([{ databaseId: 123, status: "completed", conclusion: "success" }]));
    await mergeAfterCi(opts);
    expect(opts.command.mock.calls.some(([, args]) => args[1] === "rerun")).toBe(false);
  });
  it("never merges a failed CI run", async () => {
    const opts = harness();
    opts.command.mockImplementation((_exe, args) => {
      if (args[1] === "list") return JSON.stringify([{ databaseId: 123 }]);
      throw new Error("CI failed");
    });
    await expect(mergeAfterCi(opts)).rejects.toThrow("CI failed");
    expect(opts.command.mock.calls.some(([, args]) => args[1] === "merge")).toBe(false);
  });
  it("never merges incomplete CI or a changed head", async () => {
    const opts = harness({ ...passed(), headSha: "changed" });
    await expect(mergeAfterCi(opts)).rejects.toThrow(/CI must pass/);
    expect(opts.command.mock.calls.some(([, args]) => args[1] === "merge")).toBe(false);
  });
});
